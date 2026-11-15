/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PFA 27 Authoritative Game Server & WebSocket Protocol
 * ======================================================
 * Transport: HTTP/Express + WebSocket (`ws`), maxPayload = 4096 bytes, sliding-window rate limit = 20 msgs/s.
 *
 * Client -> Server WS Messages:
 *   - PING              { ts?: number }
 *   - PONG              { ts?: number }
 *   - CREATE_ROOM       { playerName: string, penId: string, platform: 'mobile'|'desktop', crossplay: boolean }
 *   - JOIN_ROOM         { roomCode: string, playerName: string, penId: string, platform: 'mobile'|'desktop', crossplay: boolean }
 *   - JOIN_QUEUE        { playerName: string, penId: string, platform: 'mobile'|'desktop', crossplay: boolean }
 *   - LEAVE_QUEUE       {}
 *   - RECONNECT_ROOM    { roomCode: string, sessionToken: string }
 *   - FLICK_ACTION      { power: number (0..1], angle: number, curve: number [-1..1], flickStyleId: string, turnSeq: number }
 *   - SYNC_STATE        { pens: PenSnapshot[], activeTurn: 'player1'|'player2', roundScore: [number, number], currentRound: number, turnSeq: number } (Host-only, ~15Hz)
 *   - TURN_CHANGE       { nextTurn: 'host'|'guest', roundScore: [number, number], currentRound: number, pens: PenSnapshot[] } (Host-only)
 *   - MATCH_RESULT      { winner: 'host'|'guest', finalScore: [number, number] } (Host-only)
 *   - REQUEST_REMATCH   {}
 *   - CHAT_TAUNT        { message: string }
 *   - LEAVE_ROOM        {}
 *
 * Server -> Client WS Messages:
 *   - PING / PONG / RTT_UPDATE
 *   - ROOM_CREATED      { roomCode, sessionToken, yourRole: 'host', role: 'player1', firstTurn: 'host', platform, crossplay, message }
 *   - ROOM_JOINED       { roomCode, sessionToken, yourRole: 'guest', role: 'player2', firstTurn: 'host', activeTurn: 'player1', turnSeq, opponentName, opponentPen, opponentPlatform, myPlatform, crossplay }
 *   - OPPONENT_JOINED   { roomCode, yourRole: 'host', role: 'player1', firstTurn: 'host', activeTurn: 'player1', turnSeq, opponentName, opponentPen, opponentPlatform, myPlatform, crossplay }
 *   - QUEUE_JOINED      { position, message }
 *   - QUEUE_LEFT        {}
 *   - QUEUE_MATCHED     { roomCode, sessionToken, yourRole, role, firstTurn: 'host', activeTurn: 'player1', turnSeq, opponentName, opponentPen, opponentPlatform, myPlatform, crossplay }
 *   - ROOM_RECONNECTED  / RECONNECT_FAILED
 *   - FLICK_ACCEPTED    { actor, turnSeq }
 *   - OPPONENT_FLICKED  { actor, turnSeq, power, angle, curve, flickStyleId }
 *   - PEER_STATE_SYNC   { pens, activeTurn, roundScore, currentRound, turnSeq }
 *   - TURN_CHANGE       { nextTurn: 'host'|'guest', activeTurn: 'player1'|'player2', turnSeq, roundScore, currentRound, pens }
 *   - MATCH_RESULT      { winner: 'host'|'guest', finalScore: [number, number], settlementToken: string }
 *   - OPPONENT_DISCONNECTED { message }
 *   - REMATCH_REQUESTED / REMATCH_STARTED
 *   - OPPONENT_TAUNT    { message, sender }
 *   - ACTION_REJECTED   { reason, message, activeTurn?, turnSeq?, snapshot? }
 *   - ERROR             { message }
 */

import 'dotenv/config';
import crypto from 'crypto';
import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getFirebaseAdmin, verifyRequestUser, VerifiedRequestUser } from './firebaseAdmin';
import { PENS_CATALOG, FLICK_STYLES, GEOMETRY_BOXES } from './src/data/initialData';
import type { MatchMode, PenDefinition, PenSkin, PlayerProfile, Rarity } from './src/types/game';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const MAX_WS_PAYLOAD_BYTES = 4096; // 4 KB strict payload ceiling
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s heartbeat
const STALE_ROOM_TTL_MS = 15 * 60_000;
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_MSGS = 20; // 20 msgs/sec sliding window
const MATCH_SETTLEMENT_TTL_MS = 10 * 60_000;

const VALID_PEN_IDS = new Set(PENS_CATALOG.map((p) => p.id));
const VALID_SKIN_IDS = new Set(PENS_CATALOG.flatMap((p) => p.availableSkins.map((s) => s.id)));
const VALID_FLICK_STYLE_IDS = new Set(FLICK_STYLES.map((s) => s.id));
const ALL_PEN_IDS = PENS_CATALOG.map((p) => p.id);
const ALL_SKIN_IDS = PENS_CATALOG.flatMap((p) => p.availableSkins.map((s) => s.id));
const ALL_FLICK_STYLE_IDS = FLICK_STYLES.map((s) => s.id);

const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type PlayerRole = 'host' | 'guest';
type TableRole = 'player1' | 'player2';

interface ClientSession {
  ws: WebSocket;
  roomCode: string | null;
  playerName: string;
  isHost: boolean;
  platform: 'mobile' | 'desktop';
  sessionToken: string | null;
  isAlive: boolean;
  msgTimestamps: number[];
}

interface PenSnapshot {
  id: string;
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  angle: number;
  angularVel: number;
  isKnockedOut: boolean;
}

interface RoomSnapshot {
  pens: PenSnapshot[];
  activeTurn: TableRole;
  roundScore: [number, number];
  currentRound: number;
  turnSeq: number;
}

interface Room {
  code: string;
  host: WebSocket | null;
  guest: WebSocket | null;
  hostToken: string;
  guestToken: string | null;
  hostName: string;
  guestName: string | null;
  status: 'WAITING' | 'READY' | 'PLAYING' | 'FINISHED';
  hostPen: string;
  guestPen: string | null;
  hostPlatform: 'mobile' | 'desktop';
  guestPlatform: 'mobile' | 'desktop' | null;
  hostConnected: boolean;
  guestConnected: boolean;
  crossplay: boolean;
  activeTurn: TableRole;
  turnSeq: number;
  turnInFlight: boolean;
  inFlightActor: TableRole | null;
  roundScore: [number, number];
  currentRound: number;
  matchWinner: PlayerRole | null;
  snapshot: RoomSnapshot | null;
  rematchRequests: { host: boolean; guest: boolean };
  lastActivityAt: number;
}

interface QueueEntry {
  ws: WebSocket;
  playerName: string;
  penId: string;
  platform: 'mobile' | 'desktop';
  crossplay: boolean;
  enqueuedAt: number;
}

interface SettlementTicket {
  token: string;
  roomCode: string;
  role: PlayerRole;
  isVictory: boolean;
  createdAt: number;
  consumed: boolean;
}

const clients = new Map<WebSocket, ClientSession>();
const rooms = new Map<string, Room>();
const matchmakingQueue: QueueEntry[] = [];
const pendingSettlements = new Map<string, SettlementTicket>();
const lastPracticeSettlementByUid = new Map<string, number>();

function isOriginAllowed(originHeader: string | undefined, reqHostHeader: string | undefined): boolean {
  if (!originHeader) {
    // Allow non-browser / CLI WS clients unless strictly restricted via env
    return process.env.STRICT_WS_ORIGIN !== 'true';
  }

  try {
    const parsedOrigin = new URL(originHeader);
    const allowedEnv = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowedEnv.includes(originHeader) || allowedEnv.includes(parsedOrigin.host)) {
      return true;
    }

    if (reqHostHeader && parsedOrigin.host === reqHostHeader) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  verifyClient: (info, callback) => {
    const allowed = isOriginAllowed(info.origin, info.req.headers.host);
    if (!allowed) {
      callback(false, 403, 'Forbidden WebSocket origin');
      return;
    }
    callback(true);
  },
});

app.use(express.json({ limit: '32kb' }));

function sanitizeText(raw: unknown, maxLen: number, fallback: string = ''): string {
  const cleaned = String(raw ?? '')
    .replace(/[\x00-\x1F\x7F<>]/g, '')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

function sanitizePenId(raw: unknown, fallback: string): string {
  const candidate = String(raw ?? '').trim().slice(0, 64);
  return VALID_PEN_IDS.has(candidate) ? candidate : fallback;
}

function sendJson(ws: WebSocket | null | undefined, payload: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    const bytes = crypto.randomBytes(5);
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += ROOM_CODE_CHARSET[bytes[i] % ROOM_CODE_CHARSET.length];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }
  // 8-char fallback if 5-char space were ever heavily saturated
  let fallbackCode = '';
  do {
    fallbackCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  } while (rooms.has(fallbackCode));
  return fallbackCode;
}

function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function removeFromQueue(ws: WebSocket): boolean {
  const idx = matchmakingQueue.findIndex((q) => q.ws === ws);
  if (idx !== -1) {
    matchmakingQueue.splice(idx, 1);
    return true;
  }
  return false;
}

function cleanupRoom(code: string) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.host) {
    const hostSession = clients.get(room.host);
    if (hostSession && hostSession.roomCode === code) {
      hostSession.roomCode = null;
      hostSession.sessionToken = null;
      hostSession.isHost = false;
    }
  }
  if (room.guest) {
    const guestSession = clients.get(room.guest);
    if (guestSession && guestSession.roomCode === code) {
      guestSession.roomCode = null;
      guestSession.sessionToken = null;
      guestSession.isHost = false;
    }
  }
  rooms.delete(code);
}

function createMatchedRoom(
  hostEntry: {
    ws: WebSocket;
    playerName: string;
    penId: string;
    platform: 'mobile' | 'desktop';
  },
  guestEntry: {
    ws: WebSocket;
    playerName: string;
    penId: string;
    platform: 'mobile' | 'desktop';
  },
  crossplay: boolean
): Room {
  const roomCode = generateRoomCode();
  const hostToken = generateToken();
  const guestToken = generateToken();

  const room: Room = {
    code: roomCode,
    host: hostEntry.ws,
    guest: guestEntry.ws,
    hostToken,
    guestToken,
    hostName: hostEntry.playerName,
    guestName: guestEntry.playerName,
    status: 'READY',
    hostPen: hostEntry.penId,
    guestPen: guestEntry.penId,
    hostPlatform: hostEntry.platform,
    guestPlatform: guestEntry.platform,
    hostConnected: true,
    guestConnected: true,
    crossplay,
    activeTurn: 'player1',
    turnSeq: 0,
    turnInFlight: false,
    inFlightActor: null,
    roundScore: [0, 0],
    currentRound: 1,
    matchWinner: null,
    snapshot: null,
    rematchRequests: { host: false, guest: false },
    lastActivityAt: Date.now(),
  };

  rooms.set(roomCode, room);

  const hostSession = clients.get(hostEntry.ws);
  if (hostSession) {
    hostSession.roomCode = roomCode;
    hostSession.playerName = hostEntry.playerName;
    hostSession.isHost = true;
    hostSession.platform = hostEntry.platform;
    hostSession.sessionToken = hostToken;
  }

  const guestSession = clients.get(guestEntry.ws);
  if (guestSession) {
    guestSession.roomCode = roomCode;
    guestSession.playerName = guestEntry.playerName;
    guestSession.isHost = false;
    guestSession.platform = guestEntry.platform;
    guestSession.sessionToken = guestToken;
  }

  return room;
}

// =========================================================================
// Server-Side Economy, Leaderboard & Admin Helpers (Firebase Admin SDK)
// =========================================================================

function sanitizeServerProfile(raw: Record<string, unknown>, isAdminClaim: boolean, fallbackName: string): PlayerProfile {
  const rawPens = Array.isArray(raw.unlockedPens)
    ? raw.unlockedPens.filter((id): id is string => typeof id === 'string' && VALID_PEN_IDS.has(id))
    : [];
  if (!rawPens.includes('bic_cristal')) rawPens.unshift('bic_cristal');
  if (!rawPens.includes('pilot_g2')) rawPens.push('pilot_g2');

  const rawSkins = Array.isArray(raw.unlockedSkins)
    ? raw.unlockedSkins.filter((id): id is string => typeof id === 'string' && VALID_SKIN_IDS.has(id))
    : [];
  if (!rawSkins.includes('skin_bic_classic_blue')) rawSkins.unshift('skin_bic_classic_blue');
  if (!rawSkins.includes('skin_g2_midnight')) rawSkins.push('skin_g2_midnight');

  const rawStyles = Array.isArray(raw.unlockedFlickStyles)
    ? raw.unlockedFlickStyles.filter((id): id is string => typeof id === 'string' && VALID_FLICK_STYLE_IDS.has(id))
    : [];
  if (!rawStyles.includes('style_classic_thumb')) rawStyles.unshift('style_classic_thumb');

  const unlockedPens = Array.from(new Set(rawPens)).slice(0, 50);
  const unlockedSkins = Array.from(new Set(rawSkins)).slice(0, 100);
  const unlockedFlickStyles = Array.from(new Set(rawStyles)).slice(0, 20);

  let equippedPenId = typeof raw.equippedPenId === 'string' && unlockedPens.includes(raw.equippedPenId)
    ? raw.equippedPenId
    : unlockedPens[0];
  let equippedSkinId = typeof raw.equippedSkinId === 'string' && unlockedSkins.includes(raw.equippedSkinId)
    ? raw.equippedSkinId
    : unlockedSkins[0];
  let equippedFlickStyleId = typeof raw.equippedFlickStyleId === 'string' && unlockedFlickStyles.includes(raw.equippedFlickStyleId)
    ? raw.equippedFlickStyleId
    : unlockedFlickStyles[0];

  const totalMatches = Math.max(0, Math.min(100000, Math.floor(Number(raw.totalMatches) || 0)));
  const totalWins = Math.max(0, Math.min(totalMatches, Math.floor(Number(raw.totalWins) || 0)));
  const winStreak = Math.max(0, Math.min(totalWins, Math.floor(Number(raw.winStreak) || 0)));

  return {
    username: sanitizeText(raw.username, 64, fallbackName),
    level: Math.max(1, Math.min(100, Math.floor(Number(raw.level) || 1))),
    xp: Math.max(0, Math.min(10000000, Math.floor(Number(raw.xp) || 0))),
    xpNextLevel: Math.max(100, Math.min(10000000, Math.floor(Number(raw.xpNextLevel) || 100))),
    paperclips: Math.max(0, Math.min(999999, Math.floor(Number(raw.paperclips ?? 240) || 0))),
    division: Math.max(1, Math.min(10, Math.floor(Number(raw.division) || 10))),
    divisionPoints: Math.max(0, Math.min(100, Math.floor(Number(raw.divisionPoints ?? 20) || 0))),
    totalWins,
    totalMatches,
    winStreak,
    equippedPenId,
    equippedSkinId,
    equippedFlickStyleId,
    unlockedPens,
    unlockedSkins,
    unlockedFlickStyles,
    role: isAdminClaim ? 'ADMIN' : 'PLAYER',
    isAdmin: isAdminClaim,
    platform: raw.platform === 'mobile' ? 'mobile' : 'desktop',
    crossplaySetting: raw.crossplaySetting === 'SAME_PLATFORM_ONLY' ? 'SAME_PLATFORM_ONLY' : 'CROSSPLAY_ENABLED',
    tutorialCompleted: Boolean(raw.tutorialCompleted),
  };
}

function buildDefaultProfile(fallbackName: string, isAdminClaim: boolean): PlayerProfile {
  return sanitizeServerProfile(
    {
      username: fallbackName,
      level: 1,
      xp: 0,
      xpNextLevel: 100,
      paperclips: 240,
      division: 10,
      divisionPoints: 20,
      totalWins: 0,
      totalMatches: 0,
      winStreak: 0,
      equippedPenId: 'bic_cristal',
      equippedSkinId: 'skin_bic_classic_blue',
      equippedFlickStyleId: 'style_classic_thumb',
      unlockedPens: ['bic_cristal', 'pilot_g2'],
      unlockedSkins: ['skin_bic_classic_blue', 'skin_g2_midnight'],
      unlockedFlickStyles: ['style_classic_thumb'],
      platform: 'desktop',
      crossplaySetting: 'CROSSPLAY_ENABLED',
      tutorialCompleted: false,
    },
    isAdminClaim,
    fallbackName
  );
}

function buildUserDocWrite(
  user: VerifiedRequestUser,
  profile: PlayerProfile,
  existingCreatedAt?: unknown
): Record<string, unknown> {
  return {
    userId: user.uid,
    email: (user.email || `${user.uid}@pfa27.local`).slice(0, 256),
    username: profile.username,
    level: profile.level,
    xp: profile.xp,
    xpNextLevel: profile.xpNextLevel,
    paperclips: profile.paperclips,
    division: profile.division,
    divisionPoints: profile.divisionPoints,
    totalWins: profile.totalWins,
    totalMatches: profile.totalMatches,
    winStreak: profile.winStreak,
    equippedPenId: profile.equippedPenId,
    equippedSkinId: profile.equippedSkinId,
    equippedFlickStyleId: profile.equippedFlickStyleId,
    unlockedPens: profile.unlockedPens,
    unlockedSkins: profile.unlockedSkins,
    unlockedFlickStyles: profile.unlockedFlickStyles,
    role: user.isAdmin ? 'ADMIN' : 'PLAYER',
    isAdmin: user.isAdmin,
    platform: profile.platform || 'desktop',
    crossplaySetting: profile.crossplaySetting || 'CROSSPLAY_ENABLED',
    tutorialCompleted: Boolean(profile.tutorialCompleted),
    createdAt: existingCreatedAt || FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function buildLeaderboardDocWrite(user: VerifiedRequestUser, profile: PlayerProfile): Record<string, unknown> {
  return {
    userId: user.uid,
    username: profile.username,
    division: profile.division,
    divisionPoints: profile.divisionPoints,
    totalWins: profile.totalWins,
    totalMatches: profile.totalMatches,
    winStreak: profile.winStreak,
    equippedPenId: profile.equippedPenId,
    isAdmin: user.isAdmin,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function rollGeometryBoxDropServer(boxId: string): { pen: PenDefinition; skin: PenSkin } {
  const canonicalBox = GEOMETRY_BOXES.find((b) => b.id === boxId) || GEOMETRY_BOXES[0];
  const rollInt = crypto.randomInt(0, 10000);
  const rand = rollInt / 10000;
  let selectedRarity: Rarity = 'Common';
  const rates = canonicalBox.dropRates;

  if (rand < rates.Icon) {
    selectedRarity = 'Icon';
  } else if (rand < rates.Icon + rates.Legendary) {
    selectedRarity = 'Legendary';
  } else if (rand < rates.Icon + rates.Legendary + rates.Epic) {
    selectedRarity = 'Epic';
  } else if (rand < rates.Icon + rates.Legendary + rates.Epic + rates.Rare) {
    selectedRarity = 'Rare';
  }

  const matchingSkins: { pen: PenDefinition; skin: PenSkin }[] = [];
  for (const pen of PENS_CATALOG) {
    for (const skin of pen.availableSkins) {
      if (skin.rarity === selectedRarity) {
        matchingSkins.push({ pen, skin });
      }
    }
  }

  const fallbackPen = PENS_CATALOG[0];
  if (matchingSkins.length === 0) {
    return { pen: fallbackPen, skin: fallbackPen.availableSkins[0] };
  }
  const chosenIdx = crypto.randomInt(0, matchingSkins.length);
  return matchingSkins[chosenIdx];
}

function handleApiAuthError(res: Response, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'MISSING_AUTH_TOKEN' || msg.includes('Firebase ID token')) {
    res.status(401).json({ error: 'Unauthorized: valid Firebase ID token required.' });
    return;
  }
  if (msg.includes('credentials not configured') || msg === 'ADMIN_SDK_UNAVAILABLE') {
    res.status(503).json({
      error: 'Firebase Admin SDK is not configured on the server.',
      details: msg,
    });
    return;
  }
  console.error('API route error:', err);
  res.status(500).json({ error: msg || 'Internal server error' });
}

// =========================================================================
// Public Health & Room Discovery HTTP Endpoints
// =========================================================================

app.get('/api/health', (_req: Request, res: Response) => {
  const { error } = getFirebaseAdmin();
  res.json({
    status: 'ok',
    game: 'PFA 27 Pen Fight',
    activeRooms: rooms.size,
    activePlayers: clients.size,
    queueLength: matchmakingQueue.length,
    adminSdkReady: !error,
  });
});

app.get('/api/rooms', (_req: Request, res: Response) => {
  const publicRooms = Array.from(rooms.values())
    .filter((r) => r.status === 'WAITING' && r.hostConnected)
    .map((r) => ({
      code: r.code,
      hostName: r.hostName,
      hostPen: r.hostPen,
      hostPlatform: r.hostPlatform,
      crossplay: r.crossplay,
    }));
  res.json({ rooms: publicRooms });
});

// =========================================================================
// Server-Authoritative Profile, Economy, Leaderboard & Admin Endpoints
// =========================================================================

app.post('/api/profile/me', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    const { db } = getFirebaseAdmin();
    if (!db) {
      res.status(503).json({ error: 'Firestore Admin unavailable' });
      return;
    }

    const bodyPlatform = req.body?.platform === 'mobile' ? 'mobile' : 'desktop';
    const userDocRef = db.collection('users').doc(authUser.uid);
    const lbDocRef = db.collection('leaderboard').doc(authUser.uid);

    const profile = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userDocRef);
      const lbSnap = await tx.get(lbDocRef);

      let nextProfile: PlayerProfile;
      let existingCreatedAt: unknown = FieldValue.serverTimestamp();

      if (userSnap.exists) {
        const data = userSnap.data() || {};
        existingCreatedAt = data.createdAt || FieldValue.serverTimestamp();
        nextProfile = sanitizeServerProfile(data, authUser.isAdmin, authUser.name);

        const needsSync =
          data.isAdmin !== authUser.isAdmin ||
          data.role !== (authUser.isAdmin ? 'ADMIN' : 'PLAYER') ||
          data.tutorialCompleted === undefined ||
          data.createdAt === undefined;

        if (needsSync || !lbSnap.exists) {
          tx.set(userDocRef, buildUserDocWrite(authUser, nextProfile, existingCreatedAt));
          tx.set(lbDocRef, buildLeaderboardDocWrite(authUser, nextProfile));
        }
      } else {
        nextProfile = buildDefaultProfile(authUser.name, authUser.isAdmin);
        nextProfile.platform = bodyPlatform;
        tx.set(userDocRef, buildUserDocWrite(authUser, nextProfile, existingCreatedAt));
        tx.set(lbDocRef, buildLeaderboardDocWrite(authUser, nextProfile));
      }

      return nextProfile;
    });

    res.json({ profile });
  } catch (err) {
    handleApiAuthError(res, err);
  }
});

app.post('/api/profile/cosmetics', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    const { db } = getFirebaseAdmin();
    if (!db) {
      res.status(503).json({ error: 'Firestore Admin unavailable' });
      return;
    }

    const userDocRef = db.collection('users').doc(authUser.uid);
    const lbDocRef = db.collection('leaderboard').doc(authUser.uid);

    const updatedProfile = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userDocRef);
      const base = snap.exists
        ? sanitizeServerProfile(snap.data() || {}, authUser.isAdmin, authUser.name)
        : buildDefaultProfile(authUser.name, authUser.isAdmin);
      const existingCreatedAt = snap.exists ? snap.data()?.createdAt : FieldValue.serverTimestamp();

      const body = req.body as Record<string, unknown>;
      const next = { ...base };

      if (typeof body.username === 'string' && body.username.trim()) {
        next.username = sanitizeText(body.username, 64, base.username);
      }
      if (typeof body.equippedPenId === 'string' && base.unlockedPens.includes(body.equippedPenId)) {
        next.equippedPenId = body.equippedPenId;
      }
      if (typeof body.equippedSkinId === 'string' && base.unlockedSkins.includes(body.equippedSkinId)) {
        next.equippedSkinId = body.equippedSkinId;
      }
      if (
        typeof body.equippedFlickStyleId === 'string' &&
        base.unlockedFlickStyles.includes(body.equippedFlickStyleId)
      ) {
        next.equippedFlickStyleId = body.equippedFlickStyleId;
      }
      if (body.platform === 'mobile' || body.platform === 'desktop') {
        next.platform = body.platform;
      }
      if (body.crossplaySetting === 'CROSSPLAY_ENABLED' || body.crossplaySetting === 'SAME_PLATFORM_ONLY') {
        next.crossplaySetting = body.crossplaySetting;
      }

      const clean = sanitizeServerProfile(next as unknown as Record<string, unknown>, authUser.isAdmin, authUser.name);
      tx.set(userDocRef, buildUserDocWrite(authUser, clean, existingCreatedAt));
      tx.set(lbDocRef, buildLeaderboardDocWrite(authUser, clean));
      return clean;
    });

    res.json({ profile: updatedProfile });
  } catch (err) {
    handleApiAuthError(res, err);
  }
});

app.post('/api/economy/match-result', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    const { db } = getFirebaseAdmin();
    if (!db) {
      res.status(503).json({ error: 'Firestore Admin unavailable' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const mode = String(body.mode || '') as MatchMode;
    const settlementToken = typeof body.settlementToken === 'string' ? body.settlementToken.trim() : '';

    const allowedModes: MatchMode[] = ['ONLINE_ROOM', 'TOURNAMENT', 'BOT_BATTLE', 'PASS_PLAY'];
    if (!allowedModes.includes(mode)) {
      res.status(400).json({ error: 'Invalid match mode for settlement.' });
      return;
    }

    let isVictory = false;
    let isRankedMatch = false;
    let clipsReward = 15;
    let xpReward = 10;

    if (mode === 'ONLINE_ROOM') {
      if (!settlementToken) {
        res.status(403).json({ error: 'Online match settlement requires an authoritative server settlement token.' });
        return;
      }
      const ticket = pendingSettlements.get(settlementToken);
      if (!ticket || ticket.consumed || Date.now() - ticket.createdAt > MATCH_SETTLEMENT_TTL_MS) {
        res.status(403).json({ error: 'Invalid, expired, or already-claimed match settlement token.' });
        return;
      }
      ticket.consumed = true;
      isVictory = ticket.isVictory;
      isRankedMatch = true;
      clipsReward = isVictory ? 35 : 5;
      xpReward = isVictory ? 50 : 15;
    } else {
      const now = Date.now();
      const lastTs = lastPracticeSettlementByUid.get(authUser.uid) || 0;
      if (now - lastTs < 8_000) {
        res.status(429).json({ error: 'Match settlement cooldown active. Please wait a few seconds.' });
        return;
      }
      lastPracticeSettlementByUid.set(authUser.uid, now);

      isVictory = body.isVictory === true;
      if (mode === 'TOURNAMENT') {
        isRankedMatch = true;
        clipsReward = isVictory ? 80 : 5;
        xpReward = isVictory ? 50 : 15;
      } else if (mode === 'BOT_BATTLE') {
        isRankedMatch = false;
        clipsReward = isVictory ? 20 : 5;
        xpReward = isVictory ? 25 : 10;
      } else {
        // PASS_PLAY
        isRankedMatch = false;
        clipsReward = isVictory ? 15 : 5;
        xpReward = isVictory ? 25 : 10;
      }
    }

    const userDocRef = db.collection('users').doc(authUser.uid);
    const lbDocRef = db.collection('leaderboard').doc(authUser.uid);

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userDocRef);
      const current = snap.exists
        ? sanitizeServerProfile(snap.data() || {}, authUser.isAdmin, authUser.name)
        : buildDefaultProfile(authUser.name, authUser.isAdmin);
      const existingCreatedAt = snap.exists ? snap.data()?.createdAt : FieldValue.serverTimestamp();

      const updated: PlayerProfile = {
        ...current,
        unlockedPens: [...current.unlockedPens],
        unlockedSkins: [...current.unlockedSkins],
        unlockedFlickStyles: [...current.unlockedFlickStyles],
      };

      updated.totalMatches = Math.min(100000, updated.totalMatches + 1);
      if (isRankedMatch) {
        if (isVictory) {
          updated.totalWins = Math.min(updated.totalMatches, updated.totalWins + 1);
          updated.winStreak = Math.min(updated.totalWins, updated.winStreak + 1);
        } else {
          updated.winStreak = 0;
        }
      }

      updated.paperclips = Math.min(999999, updated.paperclips + clipsReward);
      updated.xp = Math.min(10000000, updated.xp + xpReward);

      let leveledUp = false;
      const newFlickStylesUnlocked: string[] = [];

      if (updated.xp >= updated.xpNextLevel && updated.level < 100) {
        updated.xp = Math.max(0, updated.xp - updated.xpNextLevel);
        updated.level += 1;
        updated.xpNextLevel = Math.min(10000000, Math.floor(updated.xpNextLevel * 1.35));
        leveledUp = true;

        for (const style of FLICK_STYLES) {
          if (
            updated.level >= style.levelRequired &&
            !updated.unlockedFlickStyles.includes(style.id) &&
            updated.unlockedFlickStyles.length < 20
          ) {
            updated.unlockedFlickStyles.push(style.id);
            newFlickStylesUnlocked.push(style.name);
          }
        }

        for (const pen of PENS_CATALOG) {
          if (
            updated.level >= pen.requiredLevel &&
            !updated.unlockedPens.includes(pen.id) &&
            updated.unlockedPens.length < 50
          ) {
            updated.unlockedPens.push(pen.id);
          }
        }
      }

      let divisionPromoted = false;
      if (isRankedMatch) {
        if (isVictory) {
          updated.divisionPoints = Math.min(100, updated.divisionPoints + 25);
          if (updated.divisionPoints >= 100 && updated.division > 1) {
            updated.division -= 1;
            updated.divisionPoints = 0;
            divisionPromoted = true;
          }
        } else {
          updated.divisionPoints = Math.max(0, updated.divisionPoints - 10);
        }
      }

      const clean = sanitizeServerProfile(
        updated as unknown as Record<string, unknown>,
        authUser.isAdmin,
        authUser.name
      );
      tx.set(userDocRef, buildUserDocWrite(authUser, clean, existingCreatedAt));
      tx.set(lbDocRef, buildLeaderboardDocWrite(authUser, clean));

      return {
        profile: clean,
        reward: {
          xpGained: xpReward,
          clipsGained: clipsReward,
          leveledUp,
          newLevel: clean.level,
          newFlickStylesUnlocked,
          divisionPromoted,
          newDivision: clean.division,
        },
      };
    });

    res.json(outcome);
  } catch (err) {
    handleApiAuthError(res, err);
  }
});

app.post('/api/economy/purchase-box', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    const { db } = getFirebaseAdmin();
    if (!db) {
      res.status(503).json({ error: 'Firestore Admin unavailable' });
      return;
    }

    const boxId = String((req.body as Record<string, unknown>)?.boxId || '');
    const box = GEOMETRY_BOXES.find((b) => b.id === boxId);
    if (!box) {
      res.status(400).json({ error: 'INVALID_BOX' });
      return;
    }

    const userDocRef = db.collection('users').doc(authUser.uid);

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userDocRef);
      const current = snap.exists
        ? sanitizeServerProfile(snap.data() || {}, authUser.isAdmin, authUser.name)
        : buildDefaultProfile(authUser.name, authUser.isAdmin);
      const existingCreatedAt = snap.exists ? snap.data()?.createdAt : FieldValue.serverTimestamp();

      if (current.paperclips < box.costPaperclips) {
        throw new Error('INSUFFICIENT_CLIPS');
      }

      const drop = rollGeometryBoxDropServer(box.id);
      const nextPens = current.unlockedPens.includes(drop.pen.id)
        ? [...current.unlockedPens]
        : [...current.unlockedPens, drop.pen.id];
      const nextSkins = current.unlockedSkins.includes(drop.skin.id)
        ? [...current.unlockedSkins]
        : [...current.unlockedSkins, drop.skin.id];

      const clean = sanitizeServerProfile(
        {
          ...current,
          paperclips: current.paperclips - box.costPaperclips,
          unlockedPens: nextPens,
          unlockedSkins: nextSkins,
        } as unknown as Record<string, unknown>,
        authUser.isAdmin,
        authUser.name
      );

      tx.set(userDocRef, buildUserDocWrite(authUser, clean, existingCreatedAt));
      return { profile: clean, pen: drop.pen, skin: drop.skin };
    });

    res.json(outcome);
  } catch (err) {
    if (err instanceof Error && err.message === 'INSUFFICIENT_CLIPS') {
      res.status(400).json({ error: 'INSUFFICIENT_CLIPS' });
      return;
    }
    handleApiAuthError(res, err);
  }
});

app.post('/api/economy/tutorial-complete', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    const { db } = getFirebaseAdmin();
    if (!db) {
      res.status(503).json({ error: 'Firestore Admin unavailable' });
      return;
    }

    const userDocRef = db.collection('users').doc(authUser.uid);

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userDocRef);
      const current = snap.exists
        ? sanitizeServerProfile(snap.data() || {}, authUser.isAdmin, authUser.name)
        : buildDefaultProfile(authUser.name, authUser.isAdmin);
      const existingCreatedAt = snap.exists ? snap.data()?.createdAt : FieldValue.serverTimestamp();

      if (current.tutorialCompleted) {
        return { profile: current, newlyClaimed: false };
      }

      const nextSkins = current.unlockedSkins.includes('skin_gold_leaf')
        ? [...current.unlockedSkins]
        : [...current.unlockedSkins, 'skin_gold_leaf'];

      const clean = sanitizeServerProfile(
        {
          ...current,
          tutorialCompleted: true,
          paperclips: Math.min(999999, current.paperclips + 100),
          unlockedSkins: nextSkins,
        } as unknown as Record<string, unknown>,
        authUser.isAdmin,
        authUser.name
      );

      tx.set(userDocRef, buildUserDocWrite(authUser, clean, existingCreatedAt));
      return { profile: clean, newlyClaimed: true };
    });

    res.json(outcome);
  } catch (err) {
    handleApiAuthError(res, err);
  }
});

app.post('/api/admin/grant', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    if (!authUser.isAdmin) {
      res.status(403).json({ error: 'Forbidden: admin custom claim required.' });
      return;
    }

    const { db } = getFirebaseAdmin();
    if (!db) {
      res.status(503).json({ error: 'Firestore Admin unavailable' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const action = String(body.action || '');
    const userDocRef = db.collection('users').doc(authUser.uid);
    const lbDocRef = db.collection('leaderboard').doc(authUser.uid);

    const profile = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userDocRef);
      const current = snap.exists
        ? sanitizeServerProfile(snap.data() || {}, true, authUser.name)
        : buildDefaultProfile(authUser.name, true);
      const existingCreatedAt = snap.exists ? snap.data()?.createdAt : FieldValue.serverTimestamp();

      let next: PlayerProfile = { ...current };

      switch (action) {
        case 'MAX_ALL':
          next = {
            ...current,
            level: 99,
            xp: 999999,
            xpNextLevel: 1000000,
            paperclips: 999999,
            division: 1,
            divisionPoints: 100,
            totalWins: Math.max(current.totalWins, 777),
            totalMatches: Math.max(current.totalMatches, 777),
            winStreak: Math.max(current.winStreak, 777),
            unlockedPens: [...ALL_PEN_IDS],
            unlockedSkins: [...ALL_SKIN_IDS],
            unlockedFlickStyles: [...ALL_FLICK_STYLE_IDS],
            role: 'ADMIN',
            isAdmin: true,
          };
          break;

        case 'ADD_CLIPS': {
          const amount = Math.max(1, Math.min(500000, Math.floor(Number(body.amount) || 100000)));
          next.paperclips = Math.min(999999, current.paperclips + amount);
          break;
        }

        case 'UNLOCK_PENS':
          next.unlockedPens = [...ALL_PEN_IDS];
          break;

        case 'UNLOCK_SKINS':
          next.unlockedSkins = [...ALL_SKIN_IDS];
          break;

        case 'UNLOCK_STYLES':
          next.unlockedFlickStyles = [...ALL_FLICK_STYLE_IDS];
          break;

        case 'RESET_ROOKIE':
          next = {
            ...current,
            level: 1,
            xp: 0,
            xpNextLevel: 100,
            paperclips: 240,
            division: 10,
            divisionPoints: 20,
            equippedPenId: 'bic_cristal',
            equippedSkinId: 'skin_bic_classic_blue',
            equippedFlickStyleId: 'style_classic_thumb',
            unlockedPens: ['bic_cristal', 'pilot_g2'],
            unlockedSkins: ['skin_bic_classic_blue', 'skin_g2_midnight'],
            unlockedFlickStyles: ['style_classic_thumb'],
            role: 'ADMIN',
            isAdmin: true,
          };
          break;

        default:
          throw new Error('INVALID_ADMIN_ACTION');
      }

      const clean = sanitizeServerProfile(next as unknown as Record<string, unknown>, true, authUser.name);
      tx.set(userDocRef, buildUserDocWrite(authUser, clean, existingCreatedAt));
      tx.set(lbDocRef, buildLeaderboardDocWrite(authUser, clean));
      return clean;
    });

    res.json({ profile });
  } catch (err) {
    if (err instanceof Error && err.message === 'INVALID_ADMIN_ACTION') {
      res.status(400).json({ error: 'Invalid admin grant action.' });
      return;
    }
    handleApiAuthError(res, err);
  }
});

app.post('/api/admin/bootstrap-claim', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    const configuredSecret = process.env.ADMIN_BOOTSTRAP_SECRET?.trim();
    const providedSecret = String((req.body as Record<string, unknown>)?.secret || '').trim();

    if (!configuredSecret || !providedSecret) {
      res.status(403).json({ error: 'Forbidden: bootstrap secret not configured or missing.' });
      return;
    }

    const a = Buffer.from(configuredSecret);
    const b = Buffer.from(providedSecret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Forbidden: invalid bootstrap secret.' });
      return;
    }

    const { auth } = getFirebaseAdmin();
    if (!auth) {
      res.status(503).json({ error: 'Firebase Auth Admin unavailable' });
      return;
    }

    const record = await auth.getUser(authUser.uid);
    await auth.setCustomUserClaims(authUser.uid, { ...(record.customClaims || {}), admin: true });
    res.json({ ok: true, uid: authUser.uid, admin: true });
  } catch (err) {
    handleApiAuthError(res, err);
  }
});

app.post('/api/announcements', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    if (!authUser.isAdmin) {
      res.status(403).json({ error: 'Forbidden: only admin accounts can publish announcements.' });
      return;
    }

    const { db } = getFirebaseAdmin();
    if (!db) {
      res.status(503).json({ error: 'Firestore Admin unavailable' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const title = sanitizeText(body.title, 140, '');
    const content = sanitizeText(body.content, 3000, '');
    const rawCat = String(body.category || 'ANNOUNCEMENT');
    const validCategories = ['PATCH_NOTES', 'TOURNAMENT', 'FEATURE', 'ANNOUNCEMENT'];
    const category = validCategories.includes(rawCat) ? rawCat : 'ANNOUNCEMENT';
    const pinned = Boolean(body.pinned);

    if (!title || !content) {
      res.status(400).json({ error: 'Title and content are required.' });
      return;
    }

    const authorName = sanitizeText(
      authUser.email ? authUser.email.split('@')[0] : authUser.name,
      64,
      'Admin'
    );

    const docRef = await db.collection('announcements').add({
      title,
      content,
      category,
      pinned,
      authorName,
      authorUid: authUser.uid,
      createdAt: Timestamp.now(),
    });

    res.json({ id: docRef.id, ok: true });
  } catch (err) {
    handleApiAuthError(res, err);
  }
});

app.delete('/api/announcements/:id', async (req: Request, res: Response) => {
  try {
    const authUser = await verifyRequestUser(req);
    if (!authUser.isAdmin) {
      res.status(403).json({ error: 'Forbidden: only admin accounts can delete announcements.' });
      return;
    }

    const { db } = getFirebaseAdmin();
    if (!db) {
      res.status(503).json({ error: 'Firestore Admin unavailable' });
      return;
    }

    const id = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      res.status(400).json({ error: 'Invalid announcement ID.' });
      return;
    }

    await db.collection('announcements').doc(id).delete();
    res.json({ ok: true, id });
  } catch (err) {
    handleApiAuthError(res, err);
  }
});

// =========================================================================
// WebSocket Multiplayer Engine (Host-Authoritative Sim + Hardening)
// =========================================================================

wss.on('connection', (ws: WebSocket) => {
  const session: ClientSession = {
    ws,
    roomCode: null,
    playerName: 'Player',
    isHost: false,
    platform: 'desktop',
    sessionToken: null,
    isAlive: true,
    msgTimestamps: [],
  };
  clients.set(ws, session);

  ws.on('pong', () => {
    session.isAlive = true;
  });

  ws.on('message', (messageRaw: Buffer | string) => {
    session.isAlive = true;

    const now = Date.now();
    session.msgTimestamps = session.msgTimestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    session.msgTimestamps.push(now);
    if (session.msgTimestamps.length > RATE_LIMIT_MAX_MSGS) {
      sendJson(ws, {
        type: 'ERROR',
        message: 'Rate limit exceeded (max 20 msgs/s). Slow down actions.',
      });
      return;
    }

    try {
      const parsed = JSON.parse(messageRaw.toString()) as Record<string, unknown>;
      const type = String(parsed.type || '');

      switch (type) {
        case 'PING': {
          sendJson(ws, { type: 'PONG', ts: Number(parsed.ts) || Date.now(), serverTs: Date.now() });
          break;
        }

        case 'PONG': {
          session.isAlive = true;
          if (typeof parsed.ts === 'number') {
            sendJson(ws, { type: 'RTT_UPDATE', rttMs: Math.max(0, Date.now() - parsed.ts) });
          }
          break;
        }

        case 'CREATE_ROOM': {
          if (session.roomCode) {
            sendJson(ws, {
              type: 'ERROR',
              message: `Already in room ${session.roomCode}. Leave current room before hosting a new one.`,
            });
            return;
          }
          removeFromQueue(ws);

          // Server is the SINGLE source of truth for room codes (ignores any client-supplied code)
          const roomCode = generateRoomCode();
          const hostName = sanitizeText(parsed.playerName, 24, 'Player 1');
          const hostPen = sanitizePenId(parsed.penId, 'bic_cristal');
          const hostPlatform: 'mobile' | 'desktop' = parsed.platform === 'mobile' ? 'mobile' : 'desktop';
          const crossplay = parsed.crossplay !== false;
          const hostToken = generateToken();

          const room: Room = {
            code: roomCode,
            host: ws,
            guest: null,
            hostToken,
            guestToken: null,
            hostName,
            guestName: null,
            status: 'WAITING',
            hostPen,
            guestPen: null,
            hostPlatform,
            guestPlatform: null,
            hostConnected: true,
            guestConnected: false,
            crossplay,
            activeTurn: 'player1',
            turnSeq: 0,
            turnInFlight: false,
            inFlightActor: null,
            roundScore: [0, 0],
            currentRound: 1,
            matchWinner: null,
            snapshot: null,
            rematchRequests: { host: false, guest: false },
            lastActivityAt: Date.now(),
          };
          rooms.set(roomCode, room);

          session.roomCode = roomCode;
          session.playerName = hostName;
          session.isHost = true;
          session.platform = hostPlatform;
          session.sessionToken = hostToken;

          sendJson(ws, {
            type: 'ROOM_CREATED',
            roomCode,
            sessionToken: hostToken,
            yourRole: 'host',
            role: 'player1',
            firstTurn: 'host',
            platform: hostPlatform,
            crossplay,
            message: `Room ${roomCode} created. Share code with your opponent!`,
          });
          break;
        }

        case 'JOIN_ROOM': {
          if (session.roomCode) {
            sendJson(ws, {
              type: 'ERROR',
              message: `Already in room ${session.roomCode}. Leave current room first.`,
            });
            return;
          }
          removeFromQueue(ws);

          const targetCode = sanitizeText(parsed.roomCode, 10, '').toUpperCase();
          const room = rooms.get(targetCode);
          const guestName = sanitizeText(parsed.playerName, 24, 'Player 2');
          const guestPen = sanitizePenId(parsed.penId, 'pilot_g2');
          const guestPlatform: 'mobile' | 'desktop' = parsed.platform === 'mobile' ? 'mobile' : 'desktop';
          const guestCrossplay = parsed.crossplay !== false;

          if (!room) {
            sendJson(ws, {
              type: 'ERROR',
              message: `Room "${targetCode}" not found. Check the 5-character code.`,
            });
            return;
          }

          if (room.guest !== null || room.status !== 'WAITING') {
            sendJson(ws, {
              type: 'ERROR',
              message: `Room "${targetCode}" is already full or in progress.`,
            });
            return;
          }

          if (!room.crossplay && room.hostPlatform !== guestPlatform) {
            sendJson(ws, {
              type: 'ERROR',
              message: `Crossplay disabled by host (${room.hostPlatform.toUpperCase()} only).`,
            });
            return;
          }

          if (!guestCrossplay && room.hostPlatform !== guestPlatform) {
            sendJson(ws, {
              type: 'ERROR',
              message: `Your settings specify SAME PLATFORM ONLY (${guestPlatform.toUpperCase()}), but host is on ${room.hostPlatform.toUpperCase()}.`,
            });
            return;
          }

          const guestToken = generateToken();
          room.guest = ws;
          room.guestToken = guestToken;
          room.guestName = guestName;
          room.guestPen = guestPen;
          room.guestPlatform = guestPlatform;
          room.guestConnected = true;
          room.status = 'READY';
          room.activeTurn = 'player1';
          room.turnSeq = 0;
          room.turnInFlight = false;
          room.inFlightActor = null;
          room.roundScore = [0, 0];
          room.currentRound = 1;
          room.matchWinner = null;
          room.snapshot = null;
          room.lastActivityAt = Date.now();

          session.roomCode = targetCode;
          session.playerName = guestName;
          session.isHost = false;
          session.platform = guestPlatform;
          session.sessionToken = guestToken;

          sendJson(ws, {
            type: 'ROOM_JOINED',
            roomCode: targetCode,
            sessionToken: guestToken,
            yourRole: 'guest',
            role: 'player2',
            firstTurn: 'host',
            opponentName: room.hostName,
            opponentPen: room.hostPen,
            opponentPlatform: room.hostPlatform,
            myPlatform: guestPlatform,
            crossplay: room.crossplay,
            activeTurn: room.activeTurn,
            turnSeq: room.turnSeq,
          });

          sendJson(room.host, {
            type: 'OPPONENT_JOINED',
            roomCode: targetCode,
            yourRole: 'host',
            role: 'player1',
            firstTurn: 'host',
            opponentName: guestName,
            opponentPen: guestPen,
            opponentPlatform: guestPlatform,
            myPlatform: room.hostPlatform,
            crossplay: room.crossplay,
            activeTurn: room.activeTurn,
            turnSeq: room.turnSeq,
          });
          break;
        }

        case 'JOIN_QUEUE': {
          if (session.roomCode) {
            sendJson(ws, {
              type: 'ERROR',
              message: `Already in room ${session.roomCode}. Leave current room before entering ranked queue.`,
            });
            return;
          }

          removeFromQueue(ws);

          const playerName = sanitizeText(parsed.playerName, 24, 'DeskStriker');
          const penId = sanitizePenId(parsed.penId, 'bic_cristal');
          const platform: 'mobile' | 'desktop' = parsed.platform === 'mobile' ? 'mobile' : 'desktop';
          const crossplay = parsed.crossplay !== false;

          session.playerName = playerName;
          session.platform = platform;

          // Prune stale sockets and locate compatible rival
          for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
            if (matchmakingQueue[i].ws.readyState !== WebSocket.OPEN) {
              matchmakingQueue.splice(i, 1);
            }
          }

          const matchIdx = matchmakingQueue.findIndex((candidate) => {
            if (candidate.ws === ws) return false;
            if (!candidate.crossplay && candidate.platform !== platform) return false;
            if (!crossplay && candidate.platform !== platform) return false;
            return true;
          });

          if (matchIdx !== -1) {
            const opponent = matchmakingQueue.splice(matchIdx, 1)[0];
            const room = createMatchedRoom(
              {
                ws: opponent.ws,
                playerName: opponent.playerName,
                penId: opponent.penId,
                platform: opponent.platform,
              },
              {
                ws,
                playerName,
                penId,
                platform,
              },
              opponent.crossplay && crossplay
            );

            sendJson(opponent.ws, {
              type: 'QUEUE_MATCHED',
              roomCode: room.code,
              sessionToken: room.hostToken,
              yourRole: 'host',
              role: 'player1',
              firstTurn: 'host',
              activeTurn: 'player1',
              turnSeq: 0,
              opponentName: playerName,
              opponentPen: penId,
              opponentPlatform: platform,
              myPlatform: opponent.platform,
              crossplay: room.crossplay,
            });

            sendJson(ws, {
              type: 'QUEUE_MATCHED',
              roomCode: room.code,
              sessionToken: room.guestToken,
              yourRole: 'guest',
              role: 'player2',
              firstTurn: 'host',
              activeTurn: 'player1',
              turnSeq: 0,
              opponentName: opponent.playerName,
              opponentPen: opponent.penId,
              opponentPlatform: opponent.platform,
              myPlatform: platform,
              crossplay: room.crossplay,
            });
          } else {
            matchmakingQueue.push({
              ws,
              playerName,
              penId,
              platform,
              crossplay,
              enqueuedAt: Date.now(),
            });
            sendJson(ws, {
              type: 'QUEUE_JOINED',
              position: matchmakingQueue.length,
              message: 'Searching for a compatible ranked opponent...',
            });
          }
          break;
        }

        case 'LEAVE_QUEUE': {
          removeFromQueue(ws);
          sendJson(ws, { type: 'QUEUE_LEFT' });
          break;
        }

        case 'RECONNECT_ROOM': {
          const targetCode = sanitizeText(parsed.roomCode, 10, '').toUpperCase();
          const token = String(parsed.sessionToken || '').trim();
          const room = rooms.get(targetCode);

          if (!room || !token) {
            sendJson(ws, {
              type: 'RECONNECT_FAILED',
              message: 'Match session expired or room no longer exists.',
            });
            return;
          }

          const isHostMatch = room.hostToken === token;
          const isGuestMatch = room.guestToken === token;
          if (!isHostMatch && !isGuestMatch) {
            sendJson(ws, {
              type: 'RECONNECT_FAILED',
              message: 'Invalid reconnect credentials for this room.',
            });
            return;
          }

          room.lastActivityAt = Date.now();
          if (isHostMatch) {
            room.host = ws;
            room.hostConnected = true;
            session.roomCode = targetCode;
            session.playerName = room.hostName;
            session.isHost = true;
            session.platform = room.hostPlatform;
            session.sessionToken = token;

            sendJson(ws, {
              type: 'ROOM_RECONNECTED',
              roomCode: targetCode,
              yourRole: 'host',
              role: 'player1',
              opponentName: room.guestName || 'Opponent',
              opponentPen: room.guestPen || 'pilot_g2',
              opponentPlatform: room.guestPlatform || 'desktop',
              crossplay: room.crossplay,
              activeTurn: room.activeTurn,
              turnSeq: room.turnSeq,
              roundScore: room.roundScore,
              currentRound: room.currentRound,
              matchWinner: room.matchWinner,
              snapshot: room.snapshot,
              opponentConnected: room.guestConnected,
            });
          } else {
            room.guest = ws;
            room.guestConnected = true;
            session.roomCode = targetCode;
            session.playerName = room.guestName || 'Player 2';
            session.isHost = false;
            session.platform = room.guestPlatform || 'desktop';
            session.sessionToken = token;

            sendJson(ws, {
              type: 'ROOM_RECONNECTED',
              roomCode: targetCode,
              yourRole: 'guest',
              role: 'player2',
              opponentName: room.hostName,
              opponentPen: room.hostPen,
              opponentPlatform: room.hostPlatform,
              crossplay: room.crossplay,
              activeTurn: room.activeTurn,
              turnSeq: room.turnSeq,
              roundScore: room.roundScore,
              currentRound: room.currentRound,
              matchWinner: room.matchWinner,
              snapshot: room.snapshot,
              opponentConnected: room.hostConnected,
            });
          }
          break;
        }

        case 'FLICK_ACTION': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room || room.status === 'WAITING' || room.status === 'FINISHED') {
            sendJson(ws, {
              type: 'ACTION_REJECTED',
              reason: 'MATCH_NOT_ACTIVE',
              message: 'Cannot flick: match is not active.',
            });
            return;
          }

          const actor: TableRole = session.isHost ? 'player1' : 'player2';
          if (room.activeTurn !== actor) {
            sendJson(ws, {
              type: 'ACTION_REJECTED',
              reason: 'NOT_YOUR_TURN',
              activeTurn: room.activeTurn,
              turnSeq: room.turnSeq,
              message: 'Not your turn yet.',
            });
            return;
          }

          if (room.turnInFlight) {
            sendJson(ws, {
              type: 'ACTION_REJECTED',
              reason: 'TURN_IN_FLIGHT',
              activeTurn: room.activeTurn,
              turnSeq: room.turnSeq,
              message: 'Previous flick is still resolving.',
            });
            return;
          }

          if (typeof parsed.turnSeq === 'number' && parsed.turnSeq !== room.turnSeq) {
            sendJson(ws, {
              type: 'ACTION_REJECTED',
              reason: 'STALE_SEQUENCE',
              activeTurn: room.activeTurn,
              turnSeq: room.turnSeq,
              snapshot: room.snapshot,
              message: 'Turn sequence out of sync.',
            });
            return;
          }

          const rawPower = parsed.power;
          const rawAngle = parsed.angle;
          const rawCurve = parsed.curve ?? 0;
          const rawStyleId = String(parsed.flickStyleId ?? '');

          if (
            typeof rawPower !== 'number' ||
            !Number.isFinite(rawPower) ||
            rawPower <= 0 ||
            rawPower > 1.0 ||
            typeof rawAngle !== 'number' ||
            !Number.isFinite(rawAngle) ||
            typeof rawCurve !== 'number' ||
            !Number.isFinite(rawCurve) ||
            rawCurve < -1.0 ||
            rawCurve > 1.0 ||
            !VALID_FLICK_STYLE_IDS.has(rawStyleId)
          ) {
            sendJson(ws, {
              type: 'ACTION_REJECTED',
              reason: 'INVALID_PAYLOAD',
              message: 'Rejected invalid flick parameters.',
            });
            return;
          }

          room.status = 'PLAYING';
          room.turnSeq += 1;
          room.turnInFlight = true;
          room.inFlightActor = actor;
          room.lastActivityAt = Date.now();

          sendJson(ws, {
            type: 'FLICK_ACCEPTED',
            actor,
            turnSeq: room.turnSeq,
          });

          // If guest fired, relay input to Host so Host simulates both pens
          if (!session.isHost) {
            sendJson(room.host, {
              type: 'OPPONENT_FLICKED',
              actor,
              turnSeq: room.turnSeq,
              power: rawPower,
              angle: rawAngle,
              curve: rawCurve,
              flickStyleId: rawStyleId,
            });
          }
          break;
        }

        case 'SYNC_STATE': {
          if (!session.roomCode || !session.isHost) return;
          const room = rooms.get(session.roomCode);
          if (!room || room.status === 'FINISHED') return;

          const sanitizedPens: PenSnapshot[] = Array.isArray(parsed.pens)
            ? parsed.pens.slice(0, 2).map((item) => {
                const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
                const pos = (p.pos && typeof p.pos === 'object' ? p.pos : {}) as Record<string, unknown>;
                const vel = (p.vel && typeof p.vel === 'object' ? p.vel : {}) as Record<string, unknown>;
                return {
                  id: String(p.id || ''),
                  pos: {
                    x: Number.isFinite(Number(pos.x)) ? Number(pos.x) : 0,
                    y: Number.isFinite(Number(pos.y)) ? Number(pos.y) : 0,
                  },
                  vel: {
                    x: Number.isFinite(Number(vel.x)) ? Number(vel.x) : 0,
                    y: Number.isFinite(Number(vel.y)) ? Number(vel.y) : 0,
                  },
                  angle: Number.isFinite(Number(p.angle)) ? Number(p.angle) : 0,
                  angularVel: Number.isFinite(Number(p.angularVel)) ? Number(p.angularVel) : 0,
                  isKnockedOut: Boolean(p.isKnockedOut),
                };
              })
            : [];

          const scoreArr: [number, number] =
            Array.isArray(parsed.roundScore) && parsed.roundScore.length === 2
              ? [
                  Math.max(0, Math.min(2, Math.floor(Number(parsed.roundScore[0]) || 0))),
                  Math.max(0, Math.min(2, Math.floor(Number(parsed.roundScore[1]) || 0))),
                ]
              : room.roundScore;
          const currentRound = Math.max(1, Math.min(3, Math.floor(Number(parsed.currentRound) || room.currentRound)));

          room.lastActivityAt = Date.now();
          room.snapshot = {
            pens: sanitizedPens,
            activeTurn: room.activeTurn,
            roundScore: scoreArr,
            currentRound,
            turnSeq: room.turnSeq,
          };

          sendJson(room.guest, {
            type: 'PEER_STATE_SYNC',
            ...room.snapshot,
          });
          break;
        }

        case 'TURN_CHANGE': {
          // Only Host physics settles turn transitions
          if (!session.roomCode || !session.isHost) return;
          const room = rooms.get(session.roomCode);
          if (!room || room.status === 'FINISHED') return;

          const nextRole: PlayerRole = parsed.nextTurn === 'guest' ? 'guest' : 'host';
          const nextTableTurn: TableRole = nextRole === 'guest' ? 'player2' : 'player1';
          const scoreArr: [number, number] =
            Array.isArray(parsed.roundScore) && parsed.roundScore.length === 2
              ? [
                  Math.max(0, Math.min(2, Math.floor(Number(parsed.roundScore[0]) || 0))),
                  Math.max(0, Math.min(2, Math.floor(Number(parsed.roundScore[1]) || 0))),
                ]
              : room.roundScore;
          const currentRound = Math.max(1, Math.min(3, Math.floor(Number(parsed.currentRound) || room.currentRound)));

          const sanitizedPens: PenSnapshot[] = Array.isArray(parsed.pens)
            ? parsed.pens.slice(0, 2).map((item) => {
                const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
                const pos = (p.pos && typeof p.pos === 'object' ? p.pos : {}) as Record<string, unknown>;
                const vel = (p.vel && typeof p.vel === 'object' ? p.vel : {}) as Record<string, unknown>;
                return {
                  id: String(p.id || ''),
                  pos: {
                    x: Number.isFinite(Number(pos.x)) ? Number(pos.x) : 0,
                    y: Number.isFinite(Number(pos.y)) ? Number(pos.y) : 0,
                  },
                  vel: {
                    x: Number.isFinite(Number(vel.x)) ? Number(vel.x) : 0,
                    y: Number.isFinite(Number(vel.y)) ? Number(vel.y) : 0,
                  },
                  angle: Number.isFinite(Number(p.angle)) ? Number(p.angle) : 0,
                  angularVel: Number.isFinite(Number(p.angularVel)) ? Number(p.angularVel) : 0,
                  isKnockedOut: Boolean(p.isKnockedOut),
                };
              })
            : room.snapshot?.pens || [];

          room.turnInFlight = false;
          room.inFlightActor = null;
          room.activeTurn = nextTableTurn;
          room.roundScore = scoreArr;
          room.currentRound = currentRound;
          room.lastActivityAt = Date.now();
          room.snapshot = {
            pens: sanitizedPens,
            activeTurn: nextTableTurn,
            roundScore: scoreArr,
            currentRound,
            turnSeq: room.turnSeq,
          };

          const turnPayload = {
            type: 'TURN_CHANGE',
            nextTurn: nextRole,
            activeTurn: nextTableTurn,
            turnSeq: room.turnSeq,
            roundScore: scoreArr,
            currentRound,
            pens: sanitizedPens,
          };
          sendJson(room.host, turnPayload);
          sendJson(room.guest, turnPayload);
          break;
        }

        case 'MATCH_RESULT': {
          // Only Host physics arbitrates final match outcome
          if (!session.roomCode || !session.isHost) {
            sendJson(ws, {
              type: 'ERROR',
              message: 'Only the room host can finalize match results.',
            });
            return;
          }
          const room = rooms.get(session.roomCode);
          if (!room || room.status === 'FINISHED') return;

          const winner: PlayerRole = parsed.winner === 'guest' ? 'guest' : 'host';
          const rawScore = Array.isArray(parsed.finalScore) && parsed.finalScore.length === 2
            ? [
                Math.max(0, Math.min(2, Math.floor(Number(parsed.finalScore[0]) || 0))),
                Math.max(0, Math.min(2, Math.floor(Number(parsed.finalScore[1]) || 0))),
              ]
            : room.roundScore;

          const hostWon = winner === 'host';
          if ((hostWon && rawScore[0] < 2) || (!hostWon && rawScore[1] < 2)) {
            sendJson(ws, {
              type: 'ERROR',
              message: 'Invalid final score for match winner.',
            });
            return;
          }

          const finalScore: [number, number] = [rawScore[0], rawScore[1]];
          room.status = 'FINISHED';
          room.turnInFlight = false;
          room.inFlightActor = null;
          room.roundScore = finalScore;
          room.matchWinner = winner;
          room.lastActivityAt = Date.now();

          const hostToken = generateToken();
          const guestToken = generateToken();
          const createdAt = Date.now();

          pendingSettlements.set(hostToken, {
            token: hostToken,
            roomCode: room.code,
            role: 'host',
            isVictory: winner === 'host',
            createdAt,
            consumed: false,
          });
          pendingSettlements.set(guestToken, {
            token: guestToken,
            roomCode: room.code,
            role: 'guest',
            isVictory: winner === 'guest',
            createdAt,
            consumed: false,
          });

          sendJson(room.host, {
            type: 'MATCH_RESULT',
            winner,
            finalScore,
            settlementToken: hostToken,
          });
          sendJson(room.guest, {
            type: 'MATCH_RESULT',
            winner,
            finalScore,
            settlementToken: guestToken,
          });
          break;
        }

        case 'REQUEST_REMATCH': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room) return;

          room.lastActivityAt = Date.now();
          if (session.isHost) {
            room.rematchRequests.host = true;
          } else {
            room.rematchRequests.guest = true;
          }

          const recipient = session.isHost ? room.guest : room.host;

          if (room.rematchRequests.host && room.rematchRequests.guest) {
            room.status = 'PLAYING';
            room.activeTurn = 'player1';
            room.turnSeq += 1;
            room.turnInFlight = false;
            room.inFlightActor = null;
            room.roundScore = [0, 0];
            room.currentRound = 1;
            room.matchWinner = null;
            room.snapshot = null;
            room.rematchRequests = { host: false, guest: false };

            const payload = {
              type: 'REMATCH_STARTED',
              firstTurn: 'host',
              activeTurn: room.activeTurn,
              turnSeq: room.turnSeq,
              roundScore: room.roundScore,
              currentRound: room.currentRound,
            };
            sendJson(room.host, payload);
            sendJson(room.guest, payload);
          } else {
            sendJson(recipient, {
              type: 'REMATCH_REQUESTED',
              by: session.isHost ? 'player1' : 'player2',
              playerName: session.playerName,
            });
          }
          break;
        }

        case 'CHAT_TAUNT': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room) return;

          const message = sanitizeText(parsed.message, 140, '');
          if (!message) return;

          room.lastActivityAt = Date.now();
          const recipient = session.isHost ? room.guest : room.host;
          sendJson(recipient, {
            type: 'OPPONENT_TAUNT',
            message,
            sender: session.playerName,
          });
          break;
        }

        case 'LEAVE_ROOM': {
          removeFromQueue(ws);
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (room) {
            const other = session.isHost ? room.guest : room.host;
            sendJson(other, {
              type: 'OPPONENT_DISCONNECTED',
              message: `${session.playerName} left the match. Returned to lobby with no rewards.`,
            });
            cleanupRoom(room.code);
          }
          session.roomCode = null;
          session.sessionToken = null;
          session.isHost = false;
          break;
        }

        default:
          sendJson(ws, {
            type: 'ERROR',
            message: `Unsupported WebSocket message type: ${type}`,
          });
          break;
      }
    } catch (err) {
      console.error('WebSocket parse error', err);
      sendJson(ws, { type: 'ERROR', message: 'Malformed WebSocket message.' });
    }
  });

  ws.on('error', (err) => {
    console.warn('WebSocket client socket error:', err.message);
    try {
      ws.terminate();
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    removeFromQueue(ws);

    if (!session.roomCode) return;
    const room = rooms.get(session.roomCode);
    if (!room) return;

    if (session.isHost && room.host !== ws) return;
    if (!session.isHost && room.guest !== ws) return;

    if (room.status === 'WAITING' || room.status === 'FINISHED') {
      cleanupRoom(room.code);
      return;
    }

    // Confirmed immediate disconnect policy: end match cleanly with zero rewards
    const other = session.isHost ? room.guest : room.host;
    sendJson(other, {
      type: 'OPPONENT_DISCONNECTED',
      message: 'Opponent disconnected',
    });
    cleanupRoom(room.code);
  });
});

wss.on('error', (err) => {
  console.warn('WebSocket server error:', err.message);
});

// Periodic WebSocket Heartbeat (30s) & Dead Room / Expired Token Sweeper
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  for (const [ws, session] of clients.entries()) {
    if (!session.isAlive) {
      ws.terminate();
      continue;
    }
    session.isAlive = false;
    try {
      ws.ping();
    } catch {}
    sendJson(ws, { type: 'PING', ts: now });
  }

  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivityAt > STALE_ROOM_TTL_MS) {
      cleanupRoom(code);
    }
  }

  for (const [token, ticket] of pendingSettlements.entries()) {
    if (ticket.consumed || now - ticket.createdAt > MATCH_SETTLEMENT_TTL_MS) {
      pendingSettlements.delete(token);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';
  const PORT = Number(process.env.PORT) || 3000;

  const publicDir = path.resolve(__dirname, 'public');
  const distDir = path.resolve(__dirname, 'dist');

  app.use('/images', express.static(path.join(publicDir, 'images'), { maxAge: '1d' }));
  app.use(express.static(publicDir, { maxAge: '1d' }));

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.use('/images', express.static(path.join(distDir, 'images'), { maxAge: '1d' }));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`PFA 27 server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
