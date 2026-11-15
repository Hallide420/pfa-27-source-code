/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

app.use(express.json({ limit: '32kb' }));

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_GRACE_MS = 30_000;
const STALE_ROOM_TTL_MS = 15 * 60_000;
const RATE_LIMIT_WINDOW_MS = 5_000;
const RATE_LIMIT_MAX_MSGS = 30;

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
  activeTurn: 'player1' | 'player2';
  roundScore: [number, number];
  currentRound: number;
  turnSeq: number;
  matchWinner?: 'player1' | 'player2' | null;
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
  hostDisconnectTimer?: NodeJS.Timeout;
  guestDisconnectTimer?: NodeJS.Timeout;
  crossplay: boolean;
  activeTurn: 'player1' | 'player2';
  turnSeq: number;
  turnInFlight: boolean;
  inFlightActor: 'player1' | 'player2' | null;
  roundScore: [number, number];
  currentRound: number;
  matchWinner: 'player1' | 'player2' | null;
  snapshot: RoomSnapshot | null;
  rematchRequests: { host: boolean; guest: boolean };
  lastActivityAt: number;
}

const clients = new Map<WebSocket, ClientSession>();
const rooms = new Map<string, Room>();

function sendJson(ws: WebSocket | null | undefined, payload: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function generateRoomCode(): string {
  for (let i = 0; i < 10; i++) {
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    if (!rooms.has(code) && code.length >= 4) return code;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
}

function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function cleanupRoom(code: string) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.hostDisconnectTimer) clearTimeout(room.hostDisconnectTimer);
  if (room.guestDisconnectTimer) clearTimeout(room.guestDisconnectTimer);
  rooms.delete(code);
}

// Health / API check with room listing
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    game: 'PFA 27 Pen Fight',
    activeRooms: rooms.size,
    activePlayers: clients.size,
  });
});

app.get('/api/rooms', (_req, res) => {
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

  ws.on('message', (messageRaw: string) => {
    session.isAlive = true;

    const now = Date.now();
    session.msgTimestamps = session.msgTimestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    session.msgTimestamps.push(now);
    if (session.msgTimestamps.length > RATE_LIMIT_MAX_MSGS) {
      sendJson(ws, {
        type: 'ERROR',
        message: 'Rate limit exceeded. Slow down actions.',
      });
      return;
    }

    try {
      const data = JSON.parse(messageRaw.toString());
      const type = data.type;

      switch (type) {
        case 'PING': {
          sendJson(ws, { type: 'PONG', ts: data.ts || Date.now(), serverTs: Date.now() });
          break;
        }

        case 'PONG': {
          session.isAlive = true;
          if (typeof data.ts === 'number') {
            sendJson(ws, { type: 'RTT_UPDATE', rttMs: Math.max(0, Date.now() - data.ts) });
          }
          break;
        }

        case 'CREATE_ROOM': {
          // Leave any prior room cleanly before hosting a new one
          if (session.roomCode) {
            const oldRoom = rooms.get(session.roomCode);
            if (oldRoom && oldRoom.host === ws) {
              cleanupRoom(oldRoom.code);
            }
          }

          const requested =
            typeof data.roomCode === 'string'
              ? data.roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
              : '';
          const roomCode =
            requested.length >= 4 && !rooms.has(requested) ? requested : generateRoomCode();

          const hostName = String(data.playerName || 'Player 1').slice(0, 40);
          const hostPen = String(data.penId || 'bic_cristal').slice(0, 64);
          const hostPlatform: 'mobile' | 'desktop' =
            data.platform === 'mobile' ? 'mobile' : 'desktop';
          const crossplay: boolean = data.crossplay !== false;
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
            role: 'player1',
            platform: hostPlatform,
            crossplay,
            message: `Room ${roomCode} created (${crossplay ? 'Crossplay ON' : 'Same-Platform Only'}). Share code with opponent!`,
          });
          break;
        }

        case 'LIST_ROOMS': {
          const openRooms = Array.from(rooms.values())
            .filter((r) => r.status === 'WAITING' && r.hostConnected)
            .map((r) => ({
              code: r.code,
              hostName: r.hostName,
              hostPen: r.hostPen,
              hostPlatform: r.hostPlatform,
              crossplay: r.crossplay,
            }));
          sendJson(ws, {
            type: 'ROOMS_LIST',
            rooms: openRooms,
          });
          break;
        }

        case 'JOIN_ROOM': {
          const targetCode = String(data.roomCode || '').toUpperCase().trim();
          const room = rooms.get(targetCode);
          const guestName = String(data.playerName || 'Player 2').slice(0, 40);
          const guestPen = String(data.penId || 'pilot_g2').slice(0, 64);
          const guestPlatform: 'mobile' | 'desktop' =
            data.platform === 'mobile' ? 'mobile' : 'desktop';
          const guestCrossplay: boolean = data.crossplay !== false;

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
              message: `Crossplay disabled by host. Room only accepts ${room.hostPlatform.toUpperCase()} players (You are on ${guestPlatform.toUpperCase()}).`,
            });
            return;
          }

          if (!guestCrossplay && room.hostPlatform !== guestPlatform) {
            sendJson(ws, {
              type: 'ERROR',
              message: `Your settings specify SAME PLATFORM ONLY (${guestPlatform.toUpperCase()}), but the room host is on ${room.hostPlatform.toUpperCase()}.`,
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

          // Notify guest (Guest is always player2 on the canonical table)
          sendJson(ws, {
            type: 'ROOM_JOINED',
            roomCode: targetCode,
            sessionToken: guestToken,
            role: 'player2',
            opponentName: room.hostName,
            opponentPen: room.hostPen,
            opponentPlatform: room.hostPlatform,
            myPlatform: guestPlatform,
            crossplay: room.crossplay,
            activeTurn: room.activeTurn,
            turnSeq: room.turnSeq,
          });

          // Notify host (Host is always player1 on the canonical table)
          sendJson(room.host, {
            type: 'OPPONENT_JOINED',
            roomCode: targetCode,
            role: 'player1',
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

        case 'RECONNECT_ROOM': {
          const targetCode = String(data.roomCode || '').toUpperCase().trim();
          const token = String(data.sessionToken || '').trim();
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
            if (room.hostDisconnectTimer) {
              clearTimeout(room.hostDisconnectTimer);
              room.hostDisconnectTimer = undefined;
            }
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

            sendJson(room.guest, {
              type: 'OPPONENT_RECONNECTED',
              message: `${room.hostName} reconnected to the desk!`,
            });
          } else {
            if (room.guestDisconnectTimer) {
              clearTimeout(room.guestDisconnectTimer);
              room.guestDisconnectTimer = undefined;
            }
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

            sendJson(room.host, {
              type: 'OPPONENT_RECONNECTED',
              message: `${room.guestName || 'Opponent'} reconnected to the desk!`,
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

          const actor: 'player1' | 'player2' = session.isHost ? 'player1' : 'player2';
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

          if (typeof data.turnSeq === 'number' && data.turnSeq !== room.turnSeq) {
            sendJson(ws, {
              type: 'ACTION_REJECTED',
              reason: 'STALE_SEQUENCE',
              activeTurn: room.activeTurn,
              turnSeq: room.turnSeq,
              snapshot: room.snapshot,
              message: 'Turn sequence out of sync. Resyncing.',
            });
            return;
          }

          const rawPower = Number(data.power);
          const rawAngle = Number(data.angle);
          const rawCurve = Number(data.curve ?? 0);
          if (!Number.isFinite(rawPower) || !Number.isFinite(rawAngle) || !Number.isFinite(rawCurve)) {
            sendJson(ws, {
              type: 'ACTION_REJECTED',
              reason: 'INVALID_PAYLOAD',
              message: 'Invalid flick parameters.',
            });
            return;
          }

          const power = Math.min(1.0, Math.max(0.08, rawPower));
          const curve = Math.min(1.0, Math.max(-1.0, rawCurve));
          const angle = rawAngle;
          const flickStyleId = String(data.flickStyleId || 'style_classic_thumb').slice(0, 64);

          room.status = 'PLAYING';
          room.turnSeq += 1;
          room.turnInFlight = true;
          room.inFlightActor = actor;
          room.lastActivityAt = Date.now();

          const recipient = session.isHost ? room.guest : room.host;

          // Confirm accepted flick + updated seq to sender
          sendJson(ws, {
            type: 'FLICK_ACCEPTED',
            actor,
            turnSeq: room.turnSeq,
          });

          // Broadcast validated flick to opponent
          sendJson(recipient, {
            type: 'OPPONENT_FLICKED',
            actor,
            turnSeq: room.turnSeq,
            power,
            angle,
            curve,
            flickStyleId,
          });
          break;
        }

        case 'SYNC_STATE': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room) return;

          const senderRole: 'player1' | 'player2' = session.isHost ? 'player1' : 'player2';
          // Accept canonical post-physics settlement from the active turn's shooter
          if (room.inFlightActor && room.inFlightActor !== senderRole) {
            return;
          }

          if (typeof data.turnSeq === 'number' && data.turnSeq < room.turnSeq) {
            return;
          }

          const nextTurn: 'player1' | 'player2' =
            data.activeTurn === 'player2' ? 'player2' : 'player1';
          const scoreArr: [number, number] =
            Array.isArray(data.roundScore) && data.roundScore.length === 2
              ? [
                  Math.max(0, Math.min(2, Math.floor(Number(data.roundScore[0]) || 0))),
                  Math.max(0, Math.min(2, Math.floor(Number(data.roundScore[1]) || 0))),
                ]
              : room.roundScore;
          const currentRound = Math.max(1, Math.min(3, Math.floor(Number(data.currentRound) || room.currentRound)));
          let matchWinner: 'player1' | 'player2' | null = null;
          if (data.matchWinner === 'player1' && scoreArr[0] >= 2) {
            matchWinner = 'player1';
          } else if (data.matchWinner === 'player2' && scoreArr[1] >= 2) {
            matchWinner = 'player2';
          }

          const sanitizedPens: PenSnapshot[] = Array.isArray(data.pens)
            ? data.pens.slice(0, 2).map((p: any) => ({
                id: String(p.id || ''),
                pos: {
                  x: Number(p.pos?.x) || 0,
                  y: Number(p.pos?.y) || 0,
                },
                vel: {
                  x: Number(p.vel?.x) || 0,
                  y: Number(p.vel?.y) || 0,
                },
                angle: Number(p.angle) || 0,
                angularVel: Number(p.angularVel) || 0,
                isKnockedOut: Boolean(p.isKnockedOut),
              }))
            : [];

          room.turnInFlight = false;
          room.inFlightActor = null;
          room.activeTurn = nextTurn;
          room.roundScore = scoreArr;
          room.currentRound = currentRound;
          room.matchWinner = matchWinner;
          if (matchWinner) {
            room.status = 'FINISHED';
          }
          room.lastActivityAt = Date.now();

          room.snapshot = {
            pens: sanitizedPens,
            activeTurn: nextTurn,
            roundScore: scoreArr,
            currentRound,
            turnSeq: room.turnSeq,
            matchWinner,
          };

          const recipient = session.isHost ? room.guest : room.host;
          sendJson(recipient, {
            type: 'PEER_STATE_SYNC',
            ...room.snapshot,
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

          room.lastActivityAt = Date.now();
          const recipient = session.isHost ? room.guest : room.host;
          sendJson(recipient, {
            type: 'OPPONENT_TAUNT',
            message: String(data.message || '').slice(0, 120),
            sender: session.playerName,
          });
          break;
        }

        case 'LEAVE_ROOM': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (room) {
            const other = session.isHost ? room.guest : room.host;
            sendJson(other, {
              type: 'OPPONENT_LEFT',
              winner: session.isHost ? 'player2' : 'player1',
              message: `${session.playerName} left the match.`,
            });
            cleanupRoom(room.code);
          }
          session.roomCode = null;
          session.sessionToken = null;
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('WebSocket parse error', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);

    if (!session.roomCode) return;
    const room = rooms.get(session.roomCode);
    if (!room) return;

    // Ignore stale close if socket was already replaced by a reconnect
    if (session.isHost && room.host !== ws) return;
    if (!session.isHost && room.guest !== ws) return;

    // Waiting room without a guest: keep brief grace in case host refreshes, otherwise clean up
    if (room.status === 'WAITING') {
      room.hostConnected = false;
      room.hostDisconnectTimer = setTimeout(() => {
        if (!room.hostConnected) {
          cleanupRoom(room.code);
        }
      }, 15_000);
      return;
    }

    if (room.status === 'FINISHED') {
      cleanupRoom(room.code);
      return;
    }

    const other = session.isHost ? room.guest : room.host;
    if (session.isHost) {
      room.hostConnected = false;
    } else {
      room.guestConnected = false;
    }

    // If BOTH players disconnected, clean up cleanly after grace
    if (!room.hostConnected && !room.guestConnected) {
      const timer = setTimeout(() => {
        if (!room.hostConnected && !room.guestConnected) {
          cleanupRoom(room.code);
        }
      }, RECONNECT_GRACE_MS);
      if (session.isHost) room.hostDisconnectTimer = timer;
      else room.guestDisconnectTimer = timer;
      return;
    }

    // Notify remaining player of temporary disconnect & 30s grace window
    sendJson(other, {
      type: 'OPPONENT_DISCONNECTED_TEMP',
      graceSeconds: Math.round(RECONNECT_GRACE_MS / 1000),
      message: `${session.playerName} lost connection. Waiting 30s for reconnect...`,
    });

    const graceTimer = setTimeout(() => {
      const stillExists = rooms.get(room.code);
      if (!stillExists) return;
      const reconnected = session.isHost ? stillExists.hostConnected : stillExists.guestConnected;
      if (!reconnected) {
        const remaining = session.isHost ? stillExists.guest : stillExists.host;
        sendJson(remaining, {
          type: 'OPPONENT_FORFEITED',
          winner: session.isHost ? 'player2' : 'player1',
          message: `${session.playerName} failed to reconnect in time. You win by forfeit!`,
        });
        cleanupRoom(stillExists.code);
      }
    }, RECONNECT_GRACE_MS);

    if (session.isHost) {
      room.hostDisconnectTimer = graceTimer;
    } else {
      room.guestDisconnectTimer = graceTimer;
    }
  });
});

// Periodic WebSocket Heartbeat & Dead Room Sweeper
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

  // Sweep stale idle rooms
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivityAt > STALE_ROOM_TTL_MS) {
      cleanupRoom(code);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Configure Vite middleware in development
async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';
  const PORT = Number(process.env.PORT) || 3000;

  const publicDir = path.resolve(__dirname, 'public');
  const srcAssetsImagesDir = path.resolve(__dirname, 'src', 'assets', 'images');
  const distDir = path.resolve(__dirname, 'dist');

  // Explicit static assets routing with 1-day browser caching
  app.use('/images', express.static(path.join(publicDir, 'images'), { maxAge: '1d' }));
  app.use(express.static(publicDir, { maxAge: '1d' }));

  // Backward compatibility: serve /src/assets/images from public/images and src/assets/images
  app.use('/src/assets/images', express.static(path.join(publicDir, 'images'), { maxAge: '1d' }));
  app.use('/src/assets/images', express.static(srcAssetsImagesDir, { maxAge: '1d' }));

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
    app.use('/src/assets/images', express.static(path.join(distDir, 'images'), { maxAge: '1d' }));
    app.get('*', (_req, res) => {
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
