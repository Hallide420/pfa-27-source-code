/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  PenEntity,
  DeskObstacle,
  PlayerProfile,
  FlickStyle,
  BotDifficulty,
  MatchMode,
  OnlineMatchSyncState,
  OnlineFlickPayload,
  OnlinePenSnapshot,
  OnlineTurnChangePayload,
  OnlineMatchResultPayload,
} from '../types/game';
import { PENS_CATALOG, FLICK_STYLES, BOT_DIFFICULTIES } from '../data/initialData';
import { stepPhysics, DeskBounds, distance } from '../physics/penPhysics';
import { sounds } from '../utils/audio';
import { triggerHaptic, detectDevicePlatform } from '../utils/device';
import { PenChangeModal } from './PenChangeModal';
import {
  Zap,
  Award,
  Camera,
  Scale,
  Smartphone,
  Wifi,
  WifiOff,
  Clock,
} from 'lucide-react';

interface DeskArenaProps {
  mode: MatchMode;
  playerProfile: PlayerProfile;
  botDifficulty?: BotDifficulty;
  botPenId?: string;
  opponentName?: string;
  opponentAvatar?: string;
  opponentPenId?: string;
  localRole?: 'player1' | 'player2';
  onMatchComplete: (winner: 'player1' | 'player2', settlementToken?: string) => void;
  onExitMatch: () => void;
  onEquipPen?: (penId: string) => void;
  onSendFlick?: (power: number, angle: number, curve: number, styleId: string) => void;
  onSendSyncState?: (snapshot: OnlineMatchSyncState) => void;
  onSendTurnChange?: (payload: {
    nextTurn: 'host' | 'guest';
    roundScore: [number, number];
    currentRound: number;
    pens: OnlinePenSnapshot[];
  }) => void;
  onSendMatchResult?: (payload: {
    winner: 'host' | 'guest';
    finalScore: [number, number];
  }) => void;
  onRequestRematch?: () => void;
  incomingOnlineFlick?: OnlineFlickPayload | null;
  onlineSyncSnapshot?: OnlineMatchSyncState | null;
  onlineTurnChange?: OnlineTurnChangePayload | null;
  onlineMatchResult?: OnlineMatchResultPayload | null;
  onlineTurnSeq?: number;
  onlineConnectionStatus?: 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
  onlineNotice?: string | null;
  latencyMs?: number | null;
  rematchState?: { requestedByMe: boolean; requestedByOpponent: boolean; triggerCounter: number };
  isAdminUser?: boolean;
  godModePower?: number;
  playerPlatform?: 'mobile' | 'desktop';
  opponentPlatform?: 'mobile' | 'desktop';
  crossplay?: boolean;
  rewardClips?: number;
}

interface AimState {
  isAiming: boolean;
  startPos: { x: number; y: number };
  currentPos: { x: number; y: number };
  powerNormalized: number;
  angle: number;
}

const DESK_WIDTH = 840;
const DESK_HEIGHT = 520;
const TABLE_BOUNDS: DeskBounds = {
  x: 50,
  y: 40,
  width: DESK_WIDTH - 100,
  height: DESK_HEIGHT - 80,
};

export const DeskArena: React.FC<DeskArenaProps> = ({
  mode,
  playerProfile,
  botDifficulty = 'NORMAL',
  botPenId,
  opponentName = 'Opponent',
  opponentAvatar = '🎯',
  opponentPenId,
  localRole = 'player1',
  onMatchComplete,
  onExitMatch,
  onEquipPen,
  onSendFlick,
  onSendSyncState,
  onSendTurnChange,
  onSendMatchResult,
  onRequestRematch,
  incomingOnlineFlick,
  onlineSyncSnapshot,
  onlineTurnChange,
  onlineMatchResult,
  onlineTurnSeq = 0,
  onlineConnectionStatus = 'CONNECTED',
  onlineNotice = null,
  latencyMs = null,
  rematchState,
  isAdminUser = false,
  godModePower = 1.0,
  playerPlatform = detectDevicePlatform(),
  opponentPlatform = 'desktop',
  crossplay = true,
  rewardClips = 35,
}) => {
  // Strictly isolate God Mode power boost to verified admins in Bot Lab sparring only
  const effectiveGodMode =
    mode === 'BOT_BATTLE' && isAdminUser ? Math.min(5.0, Math.max(1.0, godModePower)) : 1.0;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Match state (mirrored to refs so RAF loop never tears down on state changes)
  const [roundScore, setRoundScoreState] = useState<[number, number]>([0, 0]);
  const [currentRound, setCurrentRoundState] = useState<number>(1);
  const [activeTurn, setActiveTurnState] = useState<'player1' | 'player2'>('player1');
  const [isSimulating, setIsSimulatingState] = useState<boolean>(false);
  const [isAwaitingOnlineTurn, setIsAwaitingOnlineTurn] = useState<boolean>(false);
  const [matchWinner, setMatchWinner] = useState<'player1' | 'player2' | null>(null);
  const [knockoutBanner, setKnockoutBannerState] = useState<string | null>(null);
  const [slowMoReplay] = useState<boolean>(false);

  const roundScoreRef = useRef<[number, number]>([0, 0]);
  const currentRoundRef = useRef<number>(1);
  const activeTurnRef = useRef<'player1' | 'player2'>('player1');
  const isSimulatingRef = useRef<boolean>(false);
  const matchWinnerRef = useRef<'player1' | 'player2' | null>(null);
  const knockoutBannerRef = useRef<string | null>(null);
  const slowMoReplayRef = useRef<boolean>(false);
  const onlineTurnSeqRef = useRef<number>(onlineTurnSeq);

  const setRoundScoreSync = useCallback((next: [number, number]) => {
    roundScoreRef.current = next;
    setRoundScoreState(next);
  }, []);

  const setCurrentRoundSync = useCallback((next: number) => {
    currentRoundRef.current = next;
    setCurrentRoundState(next);
  }, []);

  const setActiveTurnSync = useCallback((next: 'player1' | 'player2') => {
    activeTurnRef.current = next;
    setActiveTurnState(next);
  }, []);

  const setIsSimulatingSync = useCallback((next: boolean) => {
    isSimulatingRef.current = next;
    setIsSimulatingState(next);
  }, []);

  const setKnockoutBannerSync = useCallback((next: string | null) => {
    knockoutBannerRef.current = next;
    setKnockoutBannerState(next);
  }, []);

  useEffect(() => {
    matchWinnerRef.current = matchWinner;
  }, [matchWinner]);

  useEffect(() => {
    slowMoReplayRef.current = slowMoReplay;
  }, [slowMoReplay]);

  useEffect(() => {
    onlineTurnSeqRef.current = onlineTurnSeq;
  }, [onlineTurnSeq]);

  const matchSettledRef = useRef<boolean>(false);
  const lastHandledFlickSeqRef = useRef<number>(0);
  const lastHandledSyncSeqRef = useRef<number>(-1);
  const lastRematchTriggerRef = useRef<number>(0);
  const lastSyncSentAtRef = useRef<number>(0);
  const guestTargetPensRef = useRef<OnlinePenSnapshot[] | null>(null);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const scheduleSafeTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      pendingTimersRef.current.delete(id);
      fn();
    }, ms);
    pendingTimersRef.current.add(id);
    return id;
  }, []);

  const clearSafeTimeouts = useCallback(() => {
    for (const id of pendingTimersRef.current) {
      clearTimeout(id);
    }
    pendingTimersRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      clearSafeTimeouts();
    };
  }, [clearSafeTimeouts]);

  // Mobile ergonomics & Pass & Play state
  const isMobileDevice = playerPlatform === 'mobile';
  const [useVirtualFlickPad, setUseVirtualFlickPad] = useState<boolean>(isMobileDevice);
  const [passPlayNotice, setPassPlayNotice] = useState<string | null>(null);
  const lastPowerBracketRef = useRef<number>(-1);

  // Pen change modal
  const [showPenChangeModal, setShowPenChangeModal] = useState<boolean>(false);

  // Flick controls (aimState stored in ref so pointermove never recreates RAF loop)
  const [selectedFlickStyle, setSelectedFlickStyle] = useState<FlickStyle>(() => {
    return FLICK_STYLES.find((s) => s.id === playerProfile.equippedFlickStyleId) || FLICK_STYLES[0];
  });
  const [curveModifier, setCurveModifier] = useState<number>(0);
  const curveModifierRef = useRef<number>(0);
  useEffect(() => {
    curveModifierRef.current = curveModifier;
  }, [curveModifier]);

  const aimStateRef = useRef<AimState>({
    isAiming: false,
    startPos: { x: 0, y: 0 },
    currentPos: { x: 0, y: 0 },
    powerNormalized: 0,
    angle: 0,
  });

  // Callback refs for stable RAF loop
  const onMatchCompleteRef = useRef(onMatchComplete);
  const onSendSyncStateRef = useRef(onSendSyncState);
  const onSendTurnChangeRef = useRef(onSendTurnChange);
  const onSendMatchResultRef = useRef(onSendMatchResult);
  useEffect(() => {
    onMatchCompleteRef.current = onMatchComplete;
  }, [onMatchComplete]);
  useEffect(() => {
    onSendSyncStateRef.current = onSendSyncState;
  }, [onSendSyncState]);
  useEffect(() => {
    onSendTurnChangeRef.current = onSendTurnChange;
  }, [onSendTurnChange]);
  useEffect(() => {
    onSendMatchResultRef.current = onSendMatchResult;
  }, [onSendMatchResult]);

  // Desk texture image
  const deskTextureRef = useRef<HTMLImageElement | null>(null);

  // Entities in simulation
  const pensRef = useRef<PenEntity[]>([]);
  const obstaclesRef = useRef<DeskObstacle[]>([
    {
      id: 'eraser_center',
      type: 'eraser',
      x: DESK_WIDTH / 2 - 28,
      y: DESK_HEIGHT / 2 - 16,
      width: 56,
      height: 32,
      angle: 0.1,
      color: '#fb7185',
      label: 'ERASER',
    },
    {
      id: 'sharpener_top',
      type: 'sharpener',
      x: DESK_WIDTH / 2 + 130,
      y: 110,
      width: 32,
      height: 38,
      angle: -0.2,
      color: '#38bdf8',
      label: 'STEEL',
    },
  ]);

  const buildPenSnapshots = useCallback((zeroVelocity: boolean = true): OnlinePenSnapshot[] => {
    return pensRef.current.map((p) => ({
      id: p.id,
      pos: { x: p.pos.x, y: p.pos.y },
      vel: zeroVelocity ? { x: 0, y: 0 } : { x: p.vel.x, y: p.vel.y },
      angle: p.angle,
      angularVel: zeroVelocity ? 0 : p.angularVel,
      isKnockedOut: p.isKnockedOut,
    }));
  }, []);

  // Reset pens to initial face-off positions (Host = Left pen_player1, Guest = Right pen_player2)
  const resetRoundPositions = useCallback(() => {
    const userPenDef =
      PENS_CATALOG.find((p) => p.id === playerProfile.equippedPenId) || PENS_CATALOG[0];
    const userSkin =
      userPenDef.availableSkins.find((s) => s.id === playerProfile.equippedSkinId) ||
      userPenDef.availableSkins[0];

    const oppPenDef =
      (mode === 'BOT_BATTLE' && botPenId
        ? PENS_CATALOG.find((p) => p.id === botPenId)
        : mode === 'ONLINE_ROOM' && opponentPenId
        ? PENS_CATALOG.find((p) => p.id === opponentPenId)
        : null) ||
      PENS_CATALOG[4] ||
      PENS_CATALOG[1];
    const oppSkin = oppPenDef.availableSkins[0];

    const p1IsLocal = mode !== 'ONLINE_ROOM' || localRole === 'player1';
    const p1Def = p1IsLocal ? userPenDef : oppPenDef;
    const p1Skin = p1IsLocal ? userSkin : oppSkin;
    const p2Def = p1IsLocal ? oppPenDef : userPenDef;
    const p2Skin = p1IsLocal ? oppSkin : userSkin;

    pensRef.current = [
      {
        id: 'pen_player1',
        owner: 'player1',
        name: p1Def.name,
        brand: p1Def.brand,
        penId: p1Def.id,
        skinId: p1Skin.id,
        pos: { x: TABLE_BOUNDS.x + 120, y: DESK_HEIGHT / 2 },
        vel: { x: 0, y: 0 },
        angle: 0,
        angularVel: 0,
        stats: { ...p1Def.stats },
        primaryColor: p1Skin.primaryColor,
        secondaryColor: p1Skin.secondaryColor,
        accentColor: p1Skin.accentColor,
        clipColor: p1Def.clipColor,
        tipColor: p1Def.tipColor,
        pattern: p1Skin.pattern,
        isKnockedOut: false,
        trail: [],
      },
      {
        id: 'pen_player2',
        owner: mode === 'BOT_BATTLE' ? 'ai' : 'player2',
        name: mode === 'BOT_BATTLE' ? `[AI BOT] ${opponentName}` : p2Def.name,
        brand: p2Def.brand,
        penId: p2Def.id,
        skinId: p2Skin.id,
        pos: { x: TABLE_BOUNDS.x + TABLE_BOUNDS.width - 120, y: DESK_HEIGHT / 2 },
        vel: { x: 0, y: 0 },
        angle: Math.PI,
        angularVel: 0,
        stats: { ...p2Def.stats },
        primaryColor: p2Skin.primaryColor,
        secondaryColor: p2Skin.secondaryColor,
        accentColor: p2Skin.accentColor,
        clipColor: p2Def.clipColor,
        tipColor: p2Def.tipColor,
        pattern: p2Skin.pattern,
        isKnockedOut: false,
        trail: [],
      },
    ];

    guestTargetPensRef.current = null;
    setIsSimulatingSync(false);
    setKnockoutBannerSync(null);
  }, [
    playerProfile.equippedPenId,
    playerProfile.equippedSkinId,
    mode,
    botPenId,
    opponentPenId,
    opponentName,
    localRole,
    setIsSimulatingSync,
    setKnockoutBannerSync,
  ]);

  const resetRoundPositionsRef = useRef(resetRoundPositions);
  useEffect(() => {
    resetRoundPositionsRef.current = resetRoundPositions;
  }, [resetRoundPositions]);

  // Load desk background texture once and initialize positions when match setup changes
  useEffect(() => {
    const img = new Image();
    img.src = '/images/desk_arena_surface.jpg';
    img.onload = () => {
      deskTextureRef.current = img;
    };
  }, []);

  useEffect(() => {
    resetRoundPositions();
  }, [resetRoundPositions]);

  // Execute realistic physics flick with strict mass-dependent impulse: v = J / m
  const executeFlick = useCallback(
    (penId: string, powerNormalized: number, angle: number, curve: number, style: FlickStyle) => {
      const pen = pensRef.current.find((p) => p.id === penId);
      if (!pen || pen.isKnockedOut) return;

      // God Mode applies strictly in BOT_BATTLE for verified admins
      const isBotLabLocalPen = mode === 'BOT_BATTLE' && pen.owner === 'player1';
      const impulseMultiplier = isBotLabLocalPen ? effectiveGodMode : 1.0;
      const baseImpulse = 18.0 * style.powerBonus * powerNormalized * impulseMultiplier;
      const speed = (baseImpulse / pen.stats.mass) * pen.stats.powerMultiplier;

      pen.vel.x = Math.cos(angle) * speed;
      pen.vel.y = Math.sin(angle) * speed;

      const baseTorque = curve * 7.5 * style.spinBonus * pen.stats.spinMultiplier;
      pen.angularVel = baseTorque / Math.max(0.6, pen.stats.mass * 0.8);

      sounds.playFlick(powerNormalized);
      triggerHaptic('medium');
      setIsSimulatingSync(true);
    },
    [effectiveGodMode, mode, setIsSimulatingSync]
  );

  // Host handles Guest's incoming flick input
  useEffect(() => {
    if (!incomingOnlineFlick || mode !== 'ONLINE_ROOM' || localRole !== 'player1') return;
    if (incomingOnlineFlick.turnSeq <= lastHandledFlickSeqRef.current) return;
    lastHandledFlickSeqRef.current = incomingOnlineFlick.turnSeq;

    const style =
      FLICK_STYLES.find((s) => s.id === incomingOnlineFlick.styleId) || FLICK_STYLES[0];
    const targetPenId =
      incomingOnlineFlick.actor === 'player1' ? 'pen_player1' : 'pen_player2';
    executeFlick(
      targetPenId,
      incomingOnlineFlick.power,
      incomingOnlineFlick.angle,
      incomingOnlineFlick.curve,
      style
    );
  }, [incomingOnlineFlick, mode, localRole, executeFlick]);

  // Guest applies streamed 15Hz Host physics frames for smooth interpolation
  useEffect(() => {
    if (!onlineSyncSnapshot || mode !== 'ONLINE_ROOM' || localRole !== 'player2') return;
    if (onlineSyncSnapshot.turnSeq < lastHandledSyncSeqRef.current) return;
    lastHandledSyncSeqRef.current = onlineSyncSnapshot.turnSeq;

    setIsAwaitingOnlineTurn(false);

    if (onlineSyncSnapshot.pens && onlineSyncSnapshot.pens.length > 0) {
      guestTargetPensRef.current = onlineSyncSnapshot.pens;

      const p1Snap = onlineSyncSnapshot.pens.find((p) => p.id === 'pen_player1');
      const p2Snap = onlineSyncSnapshot.pens.find((p) => p.id === 'pen_player2');
      const p1 = pensRef.current.find((p) => p.id === 'pen_player1');
      const p2 = pensRef.current.find((p) => p.id === 'pen_player2');

      const newlyKo = Boolean(
        (p1Snap?.isKnockedOut && !p1?.isKnockedOut) ||
          (p2Snap?.isKnockedOut && !p2?.isKnockedOut)
      );

      for (const snap of onlineSyncSnapshot.pens) {
        const target = pensRef.current.find((p) => p.id === snap.id);
        if (target) {
          target.vel = { x: snap.vel.x, y: snap.vel.y };
          target.angularVel = snap.angularVel;
          target.isKnockedOut = snap.isKnockedOut;
        }
      }

      if (newlyKo && !knockoutBannerRef.current) {
        sounds.playKnockout();
        triggerHaptic('knockout');
        if (p1Snap?.isKnockedOut && p2Snap?.isKnockedOut) {
          setKnockoutBannerSync('DOUBLE RING OUT! REPLAY ROUND');
        } else if (p2Snap?.isKnockedOut) {
          setKnockoutBannerSync(`${p1?.name || 'Host'} KNOCKOUT STRIKE!`);
        } else if (p1Snap?.isKnockedOut) {
          setKnockoutBannerSync(`${p2?.name || 'Guest'} KNOCKOUT STRIKE!`);
        }
      }

      const anyMoving = onlineSyncSnapshot.pens.some(
        (p) => Math.hypot(p.vel.x, p.vel.y) > 0.4 || Math.abs(p.angularVel) > 0.04
      );
      setIsSimulatingSync(anyMoving);
    }

    setRoundScoreSync(onlineSyncSnapshot.roundScore);
    setCurrentRoundSync(onlineSyncSnapshot.currentRound);
    setActiveTurnSync(onlineSyncSnapshot.activeTurn);
  }, [
    onlineSyncSnapshot,
    mode,
    localRole,
    setActiveTurnSync,
    setCurrentRoundSync,
    setIsSimulatingSync,
    setKnockoutBannerSync,
    setRoundScoreSync,
  ]);

  // Apply authoritative TURN_CHANGE from server (snap positions & swap turn deterministically)
  useEffect(() => {
    if (!onlineTurnChange || mode !== 'ONLINE_ROOM') return;

    setIsAwaitingOnlineTurn(false);
    setIsSimulatingSync(false);
    setKnockoutBannerSync(null);
    guestTargetPensRef.current = null;

    if (onlineTurnChange.pens && onlineTurnChange.pens.length > 0) {
      for (const snap of onlineTurnChange.pens) {
        const target = pensRef.current.find((p) => p.id === snap.id);
        if (target) {
          target.pos = { x: snap.pos.x, y: snap.pos.y };
          target.vel = { x: 0, y: 0 };
          target.angle = snap.angle;
          target.angularVel = 0;
          target.isKnockedOut = snap.isKnockedOut;
          target.fallAnimationProgress = undefined;
          target.trail = [];
        }
      }
    }

    setRoundScoreSync(onlineTurnChange.roundScore);
    setCurrentRoundSync(onlineTurnChange.currentRound);
    setActiveTurnSync(onlineTurnChange.activeTurn);
  }, [
    onlineTurnChange,
    mode,
    setActiveTurnSync,
    setCurrentRoundSync,
    setIsSimulatingSync,
    setKnockoutBannerSync,
    setRoundScoreSync,
  ]);

  // Apply server-minted MATCH_RESULT for BOTH Host and Guest symmetrically
  useEffect(() => {
    if (!onlineMatchResult || mode !== 'ONLINE_ROOM') return;

    guestTargetPensRef.current = null;
    setIsAwaitingOnlineTurn(false);
    setIsSimulatingSync(false);
    setKnockoutBannerSync(null);

    const winnerTableRole: 'player1' | 'player2' =
      onlineMatchResult.winner === 'host' ? 'player1' : 'player2';
    setRoundScoreSync(onlineMatchResult.finalScore);
    setMatchWinner(winnerTableRole);

    if (!matchSettledRef.current) {
      matchSettledRef.current = true;
      onMatchCompleteRef.current(
        winnerTableRole === localRole ? 'player1' : 'player2',
        onlineMatchResult.settlementToken
      );
    }
  }, [
    onlineMatchResult,
    mode,
    localRole,
    setIsSimulatingSync,
    setKnockoutBannerSync,
    setRoundScoreSync,
  ]);

  // Clear temporary lock if server rejects an action
  useEffect(() => {
    if (onlineNotice) {
      setIsAwaitingOnlineTurn(false);
    }
  }, [onlineNotice]);

  // Handle mutual online rematch start
  useEffect(() => {
    if (
      mode === 'ONLINE_ROOM' &&
      rematchState &&
      rematchState.triggerCounter > lastRematchTriggerRef.current
    ) {
      lastRematchTriggerRef.current = rematchState.triggerCounter;
      clearSafeTimeouts();
      matchSettledRef.current = false;
      lastHandledFlickSeqRef.current = 0;
      lastHandledSyncSeqRef.current = -1;
      setMatchWinner(null);
      setIsAwaitingOnlineTurn(false);
      setRoundScoreSync([0, 0]);
      setCurrentRoundSync(1);
      setActiveTurnSync('player1');
      resetRoundPositions();
    }
  }, [
    rematchState,
    mode,
    clearSafeTimeouts,
    resetRoundPositions,
    setActiveTurnSync,
    setCurrentRoundSync,
    setRoundScoreSync,
  ]);

  // AI Opponent move calculation - Strictly active ONLY in BOT_BATTLE mode
  const triggerAiFlick = useCallback(() => {
    if (mode !== 'BOT_BATTLE') return;

    const aiPen = pensRef.current.find((p) => p.id === 'pen_player2');
    const playerPen = pensRef.current.find((p) => p.id === 'pen_player1');
    if (!aiPen || !playerPen || aiPen.isKnockedOut || playerPen.isKnockedOut) return;

    const diffConfig =
      BOT_DIFFICULTIES.find((d) => d.id === botDifficulty) || BOT_DIFFICULTIES[2];

    const dx = playerPen.pos.x - aiPen.pos.x;
    const dy = playerPen.pos.y - aiPen.pos.y;
    const dist = Math.hypot(dx, dy);
    const baseAngle = Math.atan2(dy, dx);

    const playerDistLeft = playerPen.pos.x - TABLE_BOUNDS.x;
    const playerDistRight = TABLE_BOUNDS.x + TABLE_BOUNDS.width - playerPen.pos.x;
    const playerDistTop = playerPen.pos.y - TABLE_BOUNDS.y;
    const playerDistBottom = TABLE_BOUNDS.y + TABLE_BOUNDS.height - playerPen.pos.y;
    const minPlayerRim = Math.min(playerDistLeft, playerDistRight, playerDistTop, playerDistBottom);

    const aiDistLeft = aiPen.pos.x - TABLE_BOUNDS.x;
    const aiDistRight = TABLE_BOUNDS.x + TABLE_BOUNDS.width - aiPen.pos.x;
    const aiDistTop = aiPen.pos.y - TABLE_BOUNDS.y;
    const aiDistBottom = TABLE_BOUNDS.y + TABLE_BOUNDS.height - aiPen.pos.y;
    const minAiRim = Math.min(aiDistLeft, aiDistRight, aiDistTop, aiDistBottom);

    let targetAngle = baseAngle;
    let power = 0.5;
    let curve = 0;
    let chosenStyle = FLICK_STYLES[0];

    switch (diffConfig.id) {
      case 'DUMMY': {
        const aimError = (Math.random() - 0.5) * 1.3;
        targetAngle = baseAngle + aimError;
        const behaviorRoll = Math.random();
        if (behaviorRoll < 0.45) {
          power = 0.12 + Math.random() * 0.14;
        } else if (behaviorRoll < 0.8) {
          power = 0.96 + Math.random() * 0.04;
          if (Math.random() < 0.5) {
            targetAngle += (Math.random() - 0.5) * 1.5;
          }
        } else {
          power = 0.45 + (Math.random() - 0.5) * 0.3;
        }
        curve = (Math.random() - 0.5) * 0.5;
        break;
      }

      case 'ROOKIE': {
        targetAngle = baseAngle + (Math.random() - 0.5) * 0.48;
        power = Math.min(
          1.0,
          Math.max(0.25, (dist / 380) * (aiPen.stats.mass / 1.1) + (Math.random() - 0.5) * 0.38)
        );
        curve = (Math.random() - 0.5) * 0.25;
        break;
      }

      case 'NORMAL': {
        targetAngle = baseAngle + (Math.random() - 0.5) * 0.14;
        power = Math.min(1.0, Math.max(0.35, (dist / 400) * (aiPen.stats.mass / 1.1)));
        if (minPlayerRim < 85) {
          power = Math.min(1.0, power * 1.25);
        }
        curve = (Math.random() - 0.5) * 0.1;
        break;
      }

      case 'HARD': {
        let rimDx = 0;
        let rimDy = 0;
        if (minPlayerRim === playerDistLeft) rimDx = -1;
        else if (minPlayerRim === playerDistRight) rimDx = 1;
        else if (minPlayerRim === playerDistTop) rimDy = -1;
        else rimDy = 1;

        const rimAngle = Math.atan2(rimDy, rimDx);
        const bias = Math.sin(rimAngle - baseAngle) * 0.12;
        targetAngle = baseAngle + bias + (Math.random() - 0.5) * 0.035;

        const massRatio = playerPen.stats.mass / aiPen.stats.mass;
        power = Math.min(1.0, Math.max(0.42, (dist / 360) * Math.sqrt(massRatio) * 1.18));

        if (minAiRim < 85) {
          power = Math.min(0.68, power);
        }
        chosenStyle = FLICK_STYLES[1] || FLICK_STYLES[0];
        curve = (Math.random() - 0.5) * 0.15;
        break;
      }

      case 'CYBORG_APEX': {
        const playerHalfL = playerPen.stats.length / 2;
        const cornerOffset = playerHalfL * 0.35;
        const contactX = playerPen.pos.x + Math.cos(playerPen.angle) * cornerOffset;
        const contactY = playerPen.pos.y + Math.sin(playerPen.angle) * cornerOffset;

        targetAngle = Math.atan2(contactY - aiPen.pos.y, contactX - aiPen.pos.x);

        const neededSpeed = Math.sqrt(2 * playerPen.stats.friction * 980 * (minPlayerRim + 45));
        const impulse = (neededSpeed * playerPen.stats.mass) / playerPen.stats.powerMultiplier;
        const calculatedPower = (impulse * aiPen.stats.mass) / (18.0 * 1.25);
        power = Math.min(1.0, Math.max(0.46, calculatedPower));

        const maxSafeTravel = Math.max(15, minAiRim - 25);
        const maxSafeSpeed = Math.sqrt(2 * aiPen.stats.friction * 980 * maxSafeTravel);
        const maxSafePower = (maxSafeSpeed * aiPen.stats.mass) / 18.0;
        if (power > maxSafePower && maxSafePower > 0.38) {
          power = maxSafePower;
        }

        chosenStyle = FLICK_STYLES[2] || FLICK_STYLES[0];
        curve = minPlayerRim < 120 ? -0.08 : 0.08;
        break;
      }
    }

    executeFlick('pen_player2', power, targetAngle, curve, chosenStyle);
  }, [executeFlick, mode, botDifficulty]);

  const triggerAiFlickRef = useRef(triggerAiFlick);
  useEffect(() => {
    triggerAiFlickRef.current = triggerAiFlick;
  }, [triggerAiFlick]);

  const playerUsernameRef = useRef(playerProfile.username);
  const opponentNameRef = useRef(opponentName);
  useEffect(() => {
    playerUsernameRef.current = playerProfile.username;
    opponentNameRef.current = opponentName;
  }, [playerProfile.username, opponentName]);

  // Render authentic silhouettes for real pen brands
  const drawRealPenSilhouette = (ctx: CanvasRenderingContext2D, pen: PenEntity) => {
    const halfL = pen.stats.length / 2;
    const halfW = pen.stats.width / 2;

    if (pen.penId === 'bic_cristal') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fillRect(-halfL, -halfW, pen.stats.length, pen.stats.width);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-halfL, -halfW, pen.stats.length, pen.stats.width);

      ctx.fillStyle = pen.primaryColor;
      ctx.fillRect(-halfL + 6, -1.8, pen.stats.length - 16, 3.6);

      ctx.fillStyle = '#d97706';
      ctx.beginPath();
      ctx.moveTo(halfL, -halfW * 0.6);
      ctx.lineTo(halfL + 12, 0);
      ctx.lineTo(halfL, halfW * 0.6);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = pen.primaryColor;
      ctx.fillRect(-halfL, -halfW, 8, pen.stats.width);
    } else if (pen.penId === 'rotring_600') {
      ctx.fillStyle = pen.primaryColor;
      ctx.beginPath();
      ctx.roundRect(-halfL, -halfW, pen.stats.length, pen.stats.width, 1);
      ctx.fill();
      ctx.strokeStyle = '#3f3f46';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#27272a';
      ctx.fillRect(halfL - 28, -halfW, 18, pen.stats.width);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      for (let k = 0; k < 5; k++) {
        ctx.beginPath();
        ctx.moveTo(halfL - 28 + k * 3.5, -halfW);
        ctx.lineTo(halfL - 28 + k * 3.5, halfW);
        ctx.stroke();
      }

      ctx.fillStyle = '#dc2626';
      ctx.fillRect(-halfL + 12, -halfW - 1, 3.5, pen.stats.width + 2);

      ctx.fillStyle = '#a1a1aa';
      ctx.fillRect(halfL, -1.5, 9, 3);
    } else if (pen.penId === 'parker_jotter') {
      ctx.fillStyle = pen.primaryColor;
      ctx.fillRect(0, -halfW, halfL, pen.stats.width);

      const steelGrad = ctx.createLinearGradient(0, -halfW, 0, halfW);
      steelGrad.addColorStop(0, '#f1f5f9');
      steelGrad.addColorStop(0.5, '#cbd5e1');
      steelGrad.addColorStop(1, '#94a3b8');
      ctx.fillStyle = steelGrad;
      ctx.fillRect(-halfL, -halfW, halfL, pen.stats.width);

      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(-halfL + 3, -halfW - 3, 24, 2.5);
      ctx.beginPath();
      ctx.moveTo(-halfL + 27, -halfW - 4.5);
      ctx.lineTo(-halfL + 31, -halfW - 2);
      ctx.lineTo(-halfL + 27, -halfW + 0.5);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#64748b';
      ctx.fillRect(-halfL - 4, -halfW * 0.45, 4, pen.stats.width * 0.9);

      ctx.fillStyle = '#94a3b8';
      ctx.beginPath();
      ctx.moveTo(halfL, -halfW * 0.6);
      ctx.lineTo(halfL + 8, 0);
      ctx.lineTo(halfL, halfW * 0.6);
      ctx.fill();
    } else if (pen.penId === 'lamy_safari') {
      ctx.fillStyle = pen.primaryColor;
      ctx.beginPath();
      ctx.roundRect(-halfL, -halfW, pen.stats.length, pen.stats.width, 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.roundRect(0, -2, 10, 4, 2);
      ctx.fill();

      ctx.strokeStyle = '#e4e4e7';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-halfL + 4, -halfW - 3);
      ctx.lineTo(-halfL + 34, -halfW - 3);
      ctx.lineTo(-halfL + 34, -halfW + 1);
      ctx.stroke();

      ctx.fillStyle = pen.tipColor;
      ctx.beginPath();
      ctx.moveTo(halfL, -halfW * 0.6);
      ctx.lineTo(halfL + 11, 0);
      ctx.lineTo(halfL, halfW * 0.6);
      ctx.fill();
    } else {
      const bodyGrad = ctx.createLinearGradient(0, -halfW, 0, halfW);
      bodyGrad.addColorStop(0, pen.primaryColor);
      bodyGrad.addColorStop(0.5, pen.secondaryColor);
      bodyGrad.addColorStop(1, pen.primaryColor);
      ctx.fillStyle = bodyGrad;

      ctx.beginPath();
      ctx.roundRect(-halfL, -halfW, pen.stats.length, pen.stats.width, 3);
      ctx.fill();

      ctx.fillStyle = pen.accentColor;
      ctx.fillRect(halfL - 24, -halfW, 14, pen.stats.width);

      ctx.fillStyle = pen.clipColor || '#94a3b8';
      ctx.fillRect(-halfL + 3, -halfW - 3, 20, 2.5);

      ctx.fillStyle = pen.stats.material === 'brass' ? '#fbbf24' : '#cbd5e1';
      ctx.beginPath();
      ctx.moveTo(halfL, -halfW * 0.7);
      ctx.lineTo(halfL + 10, 0);
      ctx.lineTo(halfL, halfW * 0.7);
      ctx.closePath();
      ctx.fill();
    }
  };

  // Stable RequestAnimationFrame Simulation & Render Loop (depends only on [mode, localRole])
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let lastTime = performance.now();

    const loop = (time: number) => {
      const dt = Math.min(0.033, Math.max(0.001, (time - lastTime) / 1000));
      lastTime = time;

      const isOnlineGuest = mode === 'ONLINE_ROOM' && localRole === 'player2';

      if (isOnlineGuest) {
        // Guest does NOT run its own physics — interpolates smoothly toward Host ~15Hz frames
        const targetSnaps = guestTargetPensRef.current;
        if (targetSnaps && targetSnaps.length > 0) {
          const lerpAlpha = 1 - Math.exp(-22 * dt);
          for (const snap of targetSnaps) {
            const target = pensRef.current.find((p) => p.id === snap.id);
            if (target) {
              target.pos.x += (snap.pos.x - target.pos.x) * lerpAlpha;
              target.pos.y += (snap.pos.y - target.pos.y) * lerpAlpha;
              const angleDiff = Math.atan2(
                Math.sin(snap.angle - target.angle),
                Math.cos(snap.angle - target.angle)
              );
              target.angle += angleDiff * lerpAlpha;
              target.isKnockedOut = snap.isKnockedOut;
              if (snap.isKnockedOut) {
                target.fallAnimationProgress = Math.min(
                  1,
                  (target.fallAnimationProgress || 0) + dt * 2.8
                );
              }
            }
          }
        }
      } else if (isSimulatingRef.current) {
        const stepRate = slowMoReplayRef.current ? 0.35 : 1.0;
        const result = stepPhysics(
          pensRef.current,
          obstaclesRef.current,
          TABLE_BOUNDS,
          dt * stepRate
        );

        for (const col of result.collisions) {
          sounds.playDeskImpact(col.intensity, col.material);
          triggerHaptic(col.intensity > 0.5 ? 'heavy' : 'light');
        }

        const p1 = pensRef.current.find((p) => p.id === 'pen_player1');
        const p2 = pensRef.current.find((p) => p.id === 'pen_player2');
        const p1Out = Boolean(p1?.isKnockedOut);
        const p2Out = Boolean(p2?.isKnockedOut);

        if (p1Out || p2Out) {
          if (!knockoutBannerRef.current) {
            sounds.playKnockout();
            triggerHaptic('knockout');
            if (p1Out && p2Out) {
              setKnockoutBannerSync('DOUBLE RING OUT! REPLAY ROUND');
            } else if (p2Out) {
              setKnockoutBannerSync(`${p1?.name || 'Player 1'} KNOCKOUT STRIKE!`);
            } else {
              setKnockoutBannerSync(`${p2?.name || 'Opponent'} KNOCKOUT STRIKE!`);
            }
          }
        }

        // Host streams pen positions & velocities to Guest at ~15Hz (~66ms)
        if (mode === 'ONLINE_ROOM' && localRole === 'player1') {
          if (time - lastSyncSentAtRef.current >= 66 || result.allStopped) {
            lastSyncSentAtRef.current = time;
            onSendSyncStateRef.current?.({
              pens: buildPenSnapshots(result.allStopped),
              activeTurn: activeTurnRef.current,
              roundScore: roundScoreRef.current,
              currentRound: currentRoundRef.current,
              turnSeq: onlineTurnSeqRef.current,
              matchWinner: null,
            });
          }
        }

        if (result.allStopped) {
          setIsSimulatingSync(false);

          if (mode === 'ONLINE_ROOM' && localRole === 'player1') {
            const nextRole: 'player1' | 'player2' =
              activeTurnRef.current === 'player1' ? 'player2' : 'player1';
            const nextWsTurn: 'host' | 'guest' = nextRole === 'player2' ? 'guest' : 'host';

            if (p1Out || p2Out) {
              scheduleSafeTimeout(() => {
                if (p1Out && p2Out) {
                  resetRoundPositionsRef.current();
                  setActiveTurnSync(nextRole);
                  onSendTurnChangeRef.current?.({
                    nextTurn: nextWsTurn,
                    roundScore: roundScoreRef.current,
                    currentRound: currentRoundRef.current,
                    pens: buildPenSnapshots(true),
                  });
                } else {
                  const [s1, s2] = roundScoreRef.current;
                  const newScore: [number, number] = p2Out ? [s1 + 1, s2] : [s1, s2 + 1];
                  setRoundScoreSync(newScore);

                  const winnerWsRole: 'host' | 'guest' | null =
                    newScore[0] >= 2 ? 'host' : newScore[1] >= 2 ? 'guest' : null;

                  if (winnerWsRole) {
                    setKnockoutBannerSync(null);
                    // Wait for authoritative server MATCH_RESULT with settlementToken so both Host and Guest settle cleanly
                    onSendMatchResultRef.current?.({
                      winner: winnerWsRole,
                      finalScore: newScore,
                    });
                  } else {
                    const nextRnd = currentRoundRef.current + 1;
                    setCurrentRoundSync(nextRnd);
                    resetRoundPositionsRef.current();
                    setActiveTurnSync(nextRole);
                    onSendTurnChangeRef.current?.({
                      nextTurn: nextWsTurn,
                      roundScore: newScore,
                      currentRound: nextRnd,
                      pens: buildPenSnapshots(true),
                    });
                  }
                }
              }, 1400);
            } else {
              setActiveTurnSync(nextRole);
              onSendTurnChangeRef.current?.({
                nextTurn: nextWsTurn,
                roundScore: roundScoreRef.current,
                currentRound: currentRoundRef.current,
                pens: buildPenSnapshots(true),
              });
            }
          } else if (mode !== 'ONLINE_ROOM') {
            // Local modes (BOT_BATTLE / TOURNAMENT / PASS_PLAY)
            if (p1Out || p2Out) {
              scheduleSafeTimeout(() => {
                if (p1Out && p2Out) {
                  resetRoundPositionsRef.current();
                } else {
                  const [s1, s2] = roundScoreRef.current;
                  const newScore: [number, number] = p2Out ? [s1 + 1, s2] : [s1, s2 + 1];
                  setRoundScoreSync(newScore);

                  const settledWinner: 'player1' | 'player2' | null =
                    newScore[0] >= 2 ? 'player1' : newScore[1] >= 2 ? 'player2' : null;

                  if (settledWinner) {
                    setKnockoutBannerSync(null);
                    setMatchWinner(settledWinner);
                    if (!matchSettledRef.current) {
                      matchSettledRef.current = true;
                      onMatchCompleteRef.current(settledWinner);
                    }
                  } else {
                    setCurrentRoundSync(currentRoundRef.current + 1);
                    resetRoundPositionsRef.current();
                  }
                }
              }, 1400);
            } else {
              const nextTurn: 'player1' | 'player2' =
                activeTurnRef.current === 'player1' ? 'player2' : 'player1';
              setActiveTurnSync(nextTurn);

              if (mode === 'PASS_PLAY') {
                setPassPlayNotice(
                  nextTurn === 'player1'
                    ? playerUsernameRef.current
                    : opponentNameRef.current || 'Player 2'
                );
                triggerHaptic('heavy');
              }

              if (nextTurn === 'player2' && mode === 'BOT_BATTLE') {
                scheduleSafeTimeout(() => {
                  triggerAiFlickRef.current();
                }, 800);
              }
            }
          }
        }
      }

      // Render Desk surface
      ctx.clearRect(0, 0, DESK_WIDTH, DESK_HEIGHT);

      if (deskTextureRef.current) {
        ctx.drawImage(deskTextureRef.current, 0, 0, DESK_WIDTH, DESK_HEIGHT);
        const grad = ctx.createRadialGradient(
          DESK_WIDTH / 2,
          DESK_HEIGHT / 2,
          200,
          DESK_WIDTH / 2,
          DESK_HEIGHT / 2,
          500
        );
        grad.addColorStop(0, 'rgba(0,0,0,0.1)');
        grad.addColorStop(1, 'rgba(0,0,0,0.65)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, DESK_WIDTH, DESK_HEIGHT);
      } else {
        ctx.fillStyle = '#6b4f2c';
        ctx.fillRect(0, 0, DESK_WIDTH, DESK_HEIGHT);
      }

      // Table Boundary Line (Knockout Perimeter)
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(TABLE_BOUNDS.x, TABLE_BOUNDS.y, TABLE_BOUNDS.width, TABLE_BOUNDS.height);
      ctx.setLineDash([]);

      // Desk ruler markings
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.font = '10px monospace';
      for (let i = 0; i <= TABLE_BOUNDS.width; i += 40) {
        const x = TABLE_BOUNDS.x + i;
        ctx.fillRect(x, TABLE_BOUNDS.y, 1, 8);
        if (i % 80 === 0) {
          ctx.fillText(`${i / 20}cm`, x - 10, TABLE_BOUNDS.y + 18);
        }
      }

      // Center Court circle
      ctx.beginPath();
      ctx.arc(DESK_WIDTH / 2, DESK_HEIGHT / 2, 60, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(212, 248, 42, 0.2)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Obstacles
      for (const obs of obstaclesRef.current) {
        ctx.save();
        ctx.translate(obs.x + obs.width / 2, obs.y + obs.height / 2);
        ctx.rotate(obs.angle);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(-obs.width / 2 + 3, -obs.height / 2 + 4, obs.width, obs.height);

        ctx.fillStyle = obs.color;
        ctx.fillRect(-obs.width / 2, -obs.height / 2, obs.width, obs.height);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-obs.width / 2, -obs.height / 2, obs.width, obs.height);

        if (obs.label) {
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(obs.label, 0, 0);
        }
        ctx.restore();
      }

      // Draw Pens with Authentic Silhouettes
      const currentActiveTurn = activeTurnRef.current;
      const currentlySimulating = isSimulatingRef.current;

      for (const pen of pensRef.current) {
        if (pen.isKnockedOut && pen.fallAnimationProgress && pen.fallAnimationProgress >= 1) {
          continue;
        }

        ctx.save();
        ctx.translate(pen.pos.x, pen.pos.y);
        ctx.rotate(pen.angle);

        const scale =
          pen.isKnockedOut && pen.fallAnimationProgress
            ? Math.max(0.1, 1 - pen.fallAnimationProgress * 0.6)
            : 1.0;
        ctx.scale(scale, scale);

        const halfL = pen.stats.length / 2;
        const halfW = pen.stats.width / 2;

        // Shadow on wooden desk
        ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
        ctx.beginPath();
        ctx.roundRect(-halfL + 4, -halfW + 5, pen.stats.length, pen.stats.width, 3);
        ctx.fill();

        // Active turn outline glow
        const penTurnRole = pen.owner === 'player1' ? 'player1' : 'player2';
        if (currentActiveTurn === penTurnRole && !currentlySimulating) {
          ctx.strokeStyle = '#d4f82a';
          ctx.lineWidth = 2.5;
          ctx.strokeRect(-halfL - 5, -halfW - 5, pen.stats.length + 10, pen.stats.width + 10);
        }

        drawRealPenSilhouette(ctx, pen);

        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${pen.stats.weightGrams}g`, 0, halfW + 10);

        ctx.restore();
      }

      // Slingshot Aim Arrow & Prediction Line (read directly from aimStateRef)
      const aim = aimStateRef.current;
      if (aim.isAiming) {
        const activePen = pensRef.current.find(
          (p) => (p.owner === 'player1' ? 'player1' : 'player2') === currentActiveTurn
        );
        if (activePen) {
          ctx.save();
          const { x: px, y: py } = activePen.pos;

          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(aim.currentPos.x, aim.currentPos.y);
          ctx.strokeStyle = 'rgba(212, 248, 42, 0.4)';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.stroke();
          ctx.setLineDash([]);

          const forwardLen = 60 + aim.powerNormalized * 140;
          const fx = px + Math.cos(aim.angle) * forwardLen;
          const fy = py + Math.sin(aim.angle) * forwardLen;
          const curve = curveModifierRef.current;

          if (Math.abs(curve) > 0.05) {
            const curveOffset = curve * 45;
            const ctrlX =
              px + Math.cos(aim.angle) * (forwardLen * 0.5) - Math.sin(aim.angle) * curveOffset;
            const ctrlY =
              py + Math.sin(aim.angle) * (forwardLen * 0.5) + Math.cos(aim.angle) * curveOffset;

            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.quadraticCurveTo(ctrlX, ctrlY, fx, fy);
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 3;
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(fx, fy);
            ctx.strokeStyle = '#d4f82a';
            ctx.lineWidth = 3.5;
            ctx.stroke();
          }

          ctx.fillStyle = '#d4f82a';
          ctx.beginPath();
          ctx.arc(fx, fy, 6, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 12px monospace';
          ctx.fillText(`${Math.round(aim.powerNormalized * 100)}%`, fx + 10, fy - 6);

          ctx.restore();
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [
    mode,
    localRole,
    buildPenSnapshots,
    scheduleSafeTimeout,
    setActiveTurnSync,
    setCurrentRoundSync,
    setIsSimulatingSync,
    setKnockoutBannerSync,
    setRoundScoreSync,
  ]);

  // Attach non-passive wheel listener on canvas so e.preventDefault() stops page scrolling
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setCurveModifier((prev) => {
        const next =
          e.deltaY < 0
            ? Math.min(1.0, +(prev + 0.1).toFixed(1))
            : Math.max(-1.0, +(prev - 0.1).toFixed(1));
        triggerHaptic('spin');
        return next;
      });
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Pointer Interaction Handlers for Slingshot Flick
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isSimulating || matchWinner || isAwaitingOnlineTurn) return;
    if (mode === 'RANKED' && activeTurn !== 'player1') return;
    if (mode === 'BOT_BATTLE' && activeTurn !== 'player1') return;
    if (
      mode === 'ONLINE_ROOM' &&
      (activeTurn !== localRole || onlineConnectionStatus !== 'CONNECTED')
    ) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = DESK_WIDTH / rect.width;
    const scaleY = DESK_HEIGHT / rect.height;

    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    const currentPen = pensRef.current.find(
      (p) => (p.owner === 'player1' ? 'player1' : 'player2') === activeTurn
    );
    if (!currentPen) return;

    triggerHaptic('light');
    lastPowerBracketRef.current = 0;

    aimStateRef.current = {
      isAiming: true,
      startPos: { x: clickX, y: clickY },
      currentPos: { x: clickX, y: clickY },
      powerNormalized: 0,
      angle: currentPen.angle,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!aimStateRef.current.isAiming) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = DESK_WIDTH / rect.width;
    const scaleY = DESK_HEIGHT / rect.height;

    const currentX = (e.clientX - rect.left) * scaleX;
    const currentY = (e.clientY - rect.top) * scaleY;

    const currentPen = pensRef.current.find(
      (p) => (p.owner === 'player1' ? 'player1' : 'player2') === activeTurn
    );
    if (!currentPen) return;

    const distToPen = distance(aimStateRef.current.startPos, currentPen.pos);
    const isRelativeDrag = useVirtualFlickPad || distToPen > 110;

    const dx = isRelativeDrag
      ? currentX - aimStateRef.current.startPos.x
      : currentX - currentPen.pos.x;
    const dy = isRelativeDrag
      ? currentY - aimStateRef.current.startPos.y
      : currentY - currentPen.pos.y;
    const pullDist = Math.hypot(dx, dy);

    const maxPull = 140;
    const powerNormalized = Math.min(1.0, Math.max(0.08, pullDist / maxPull));
    const flickAngle = Math.atan2(-dy, -dx);

    const bracket = Math.floor(powerNormalized * 4);
    if (bracket !== lastPowerBracketRef.current) {
      lastPowerBracketRef.current = bracket;
      triggerHaptic('powerTick');
    }

    aimStateRef.current = {
      ...aimStateRef.current,
      currentPos: { x: currentX, y: currentY },
      powerNormalized,
      angle: flickAngle,
    };
  };

  const fireActiveTurnFlick = useCallback(
    (power: number, angle: number) => {
      const currentPen = pensRef.current.find(
        (p) => (p.owner === 'player1' ? 'player1' : 'player2') === activeTurnRef.current
      );
      if (!currentPen || power <= 0.08) return;

      if (mode === 'ONLINE_ROOM') {
        if (localRole === 'player1') {
          // Host simulates locally immediately and notifies server of turn in flight
          executeFlick(currentPen.id, power, angle, curveModifierRef.current, selectedFlickStyle);
          onSendFlick?.(power, angle, curveModifierRef.current, selectedFlickStyle.id);
        } else {
          // Guest sends input to Host and awaits authoritative PEER_STATE_SYNC / TURN_CHANGE
          sounds.playFlick(power);
          triggerHaptic('medium');
          setIsAwaitingOnlineTurn(true);
          onSendFlick?.(power, angle, curveModifierRef.current, selectedFlickStyle.id);
        }
      } else {
        executeFlick(currentPen.id, power, angle, curveModifierRef.current, selectedFlickStyle);
      }
    },
    [mode, localRole, executeFlick, onSendFlick, selectedFlickStyle]
  );

  const handlePointerUp = () => {
    if (!aimStateRef.current.isAiming) return;
    const { powerNormalized, angle } = aimStateRef.current;

    aimStateRef.current = {
      isAiming: false,
      startPos: { x: 0, y: 0 },
      currentPos: { x: 0, y: 0 },
      powerNormalized: 0,
      angle: 0,
    };

    fireActiveTurnFlick(powerNormalized, angle);
  };

  // PC Keyboard Shortcuts (1-6 for styles, Q/E for spin, Space for flick, R for rematch)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showPenChangeModal) return;

      if (e.key >= '1' && e.key <= '6') {
        const idx = parseInt(e.key, 10) - 1;
        if (FLICK_STYLES[idx] && playerProfile.unlockedFlickStyles.includes(FLICK_STYLES[idx].id)) {
          setSelectedFlickStyle(FLICK_STYLES[idx]);
          sounds.playClick();
        }
      } else if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowLeft') {
        setCurveModifier((c) => {
          const next = Math.max(-1.0, +(c - 0.1).toFixed(1));
          triggerHaptic('spin');
          return next;
        });
      } else if (e.key === 'e' || e.key === 'E' || e.key === 'ArrowRight') {
        setCurveModifier((c) => {
          const next = Math.min(1.0, +(c + 0.1).toFixed(1));
          triggerHaptic('spin');
          return next;
        });
      } else if (e.key === 'w' || e.key === 'W' || e.key === '0') {
        setCurveModifier(0);
        triggerHaptic('spin');
      } else if (e.key === 'r' || e.key === 'R') {
        if (matchWinner) {
          sounds.playClick();
          if (mode === 'ONLINE_ROOM') {
            onRequestRematch?.();
          } else {
            clearSafeTimeouts();
            matchSettledRef.current = false;
            setMatchWinner(null);
            setRoundScoreSync([0, 0]);
            setCurrentRoundSync(1);
            setActiveTurnSync('player1');
            resetRoundPositions();
          }
        }
      } else if (e.key === ' ' && !isSimulating && !matchWinner && !isAwaitingOnlineTurn) {
        if (mode === 'RANKED' && activeTurn !== 'player1') return;
        if (mode === 'BOT_BATTLE' && activeTurn !== 'player1') return;
        if (
          mode === 'ONLINE_ROOM' &&
          (activeTurn !== localRole || onlineConnectionStatus !== 'CONNECTED')
        ) {
          return;
        }
        const currentPen = pensRef.current.find(
          (p) => (p.owner === 'player1' ? 'player1' : 'player2') === activeTurn
        );
        if (currentPen) {
          const aim = aimStateRef.current;
          const power = aim.isAiming && aim.powerNormalized > 0.1 ? aim.powerNormalized : 0.75;
          const angle = aim.isAiming ? aim.angle : currentPen.angle;
          aimStateRef.current = {
            isAiming: false,
            startPos: { x: 0, y: 0 },
            currentPos: { x: 0, y: 0 },
            powerNormalized: 0,
            angle: 0,
          };
          fireActiveTurnFlick(power, angle);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showPenChangeModal,
    matchWinner,
    isSimulating,
    isAwaitingOnlineTurn,
    activeTurn,
    playerProfile.unlockedFlickStyles,
    resetRoundPositions,
    fireActiveTurnFlick,
    mode,
    localRole,
    onlineConnectionStatus,
    onRequestRematch,
    clearSafeTimeouts,
    setActiveTurnSync,
    setCurrentRoundSync,
    setRoundScoreSync,
  ]);

  const p1Pen = pensRef.current.find((p) => p.id === 'pen_player1');
  const p2Pen = pensRef.current.find((p) => p.id === 'pen_player2');
  const isLocalP2 = mode === 'ONLINE_ROOM' && localRole === 'player2';
  const leftName = isLocalP2 ? opponentName : playerProfile.username;
  const rightName = isLocalP2 ? playerProfile.username : opponentName;
  const leftPlatform = isLocalP2 ? opponentPlatform : playerPlatform;
  const rightPlatform = isLocalP2 ? playerPlatform : opponentPlatform;
  const myPen = isLocalP2 ? p2Pen : p1Pen;
  const isMyTurn =
    mode === 'ONLINE_ROOM'
      ? activeTurn === localRole && !isAwaitingOnlineTurn
      : mode === 'PASS_PLAY'
      ? true
      : activeTurn === 'player1';
  const didLocalPlayerWin =
    matchWinner !== null &&
    (mode === 'ONLINE_ROOM' ? matchWinner === localRole : matchWinner === 'player1');

  return (
    <div className="flex flex-col items-center w-full max-w-5xl mx-auto px-2 sm:px-4 py-2 sm:py-3 touch-none select-none">
      {/* Mobile Compact Broadcast Scorebug (< 640px) */}
      <div className="sm:hidden w-full bg-[#0e121b] border-2 border-white p-2 mb-2 shadow-brutal-yellow">
        <div className="flex items-center justify-between gap-1.5">
          <div
            className={`flex items-center gap-1.5 px-2 py-1 border transition-all ${
              activeTurn === 'player1' ? 'bg-[#ffe500]/20 border-[#ffe500] shadow-sm' : 'border-white/10'
            }`}
          >
            <span className="text-sm">{leftPlatform === 'mobile' ? '📱' : '🖥️'}</span>
            <div className="flex flex-col leading-none">
              <span className="font-broadcast text-xs font-black uppercase text-white truncate max-w-[85px]">
                {leftName} {isLocalP2 ? '' : '(YOU)'}
              </span>
              <span className="font-mono text-[9px] text-[#ffe500] font-bold mt-0.5">
                {p1Pen?.stats.weightGrams}g
              </span>
            </div>
          </div>

          <div className="flex flex-col items-center">
            <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-black border border-white font-mono text-xl font-black text-white tabular-nums">
              <span className={roundScore[0] > roundScore[1] ? 'text-[#ffe500]' : 'text-slate-200'}>
                {roundScore[0]}
              </span>
              <span className="text-slate-500 text-sm">:</span>
              <span className={roundScore[1] > roundScore[0] ? 'text-red-400' : 'text-slate-200'}>
                {roundScore[1]}
              </span>
            </div>
            <span className="text-[8px] uppercase font-mono font-bold tracking-widest text-slate-400 mt-0.5">
              RND {currentRound}/3
            </span>
          </div>

          <div
            className={`flex items-center gap-1.5 px-2 py-1 border text-right transition-all ${
              activeTurn === 'player2' ? 'bg-red-500/20 border-red-500 shadow-sm' : 'border-white/10'
            }`}
          >
            <div className="flex flex-col items-end leading-none">
              <span className="font-broadcast text-xs font-black uppercase text-white truncate max-w-[85px]">
                {isLocalP2 ? `${rightName} (YOU)` : rightName}
              </span>
              <span className="font-mono text-[9px] text-red-300 font-bold mt-0.5">
                {p2Pen?.stats.weightGrams}g
              </span>
            </div>
            <span className="text-sm">{rightPlatform === 'mobile' ? '📱' : '🖥️'}</span>
          </div>
        </div>
      </div>

      {/* Desktop Broadcast Scoreboard Header (>= 640px) */}
      <div className="hidden sm:flex w-full items-center justify-between bg-[#0e121b] border-4 border-white px-6 py-3 mb-2 shadow-brutal-yellow">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-[#ffe500] border-2 border-black flex items-center justify-center text-xl shadow-brutal-black">
            {isLocalP2 ? opponentAvatar : '🖋️'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-broadcast text-xl font-black italic uppercase text-white tracking-wide">
                {leftName}
              </span>
              {!isLocalP2 && (
                <span className="text-[10px] font-mono font-black uppercase text-black bg-[#ffe500] px-1.5 py-0.2 border border-black">
                  YOU · DIV {playerProfile.division}
                </span>
              )}
              <span
                className="text-xs px-1.5 py-0.5 bg-black border border-white/30 text-slate-300 font-mono"
                title={`Platform: ${leftPlatform}`}
              >
                {leftPlatform === 'mobile' ? '📱 Mobile' : '🖥️ PC'}
              </span>
            </div>
            <div className="text-xs font-mono font-bold flex items-center gap-1.5 mt-0.5">
              <span className={activeTurn === 'player1' ? 'text-[#ffe500] font-black' : 'text-slate-300'}>
                {p1Pen?.name || 'Active Pen'}
              </span>
              <span className="px-1.5 py-0.2 bg-white/10 text-[#ffe500] border border-white/20 text-[10px]">
                {p1Pen?.stats.weightGrams}g
              </span>
              <span className="text-slate-400 text-[10px]">{p1Pen?.stats.densityGramsPerCm3} g/cm³</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center">
          <div className="flex items-center gap-3 px-5 py-1 bg-black border-2 border-white font-mono text-3xl font-black text-white shadow-brutal-black tabular-nums">
            <span className={roundScore[0] > roundScore[1] ? 'text-[#ffe500]' : 'text-slate-200'}>
              {roundScore[0]}
            </span>
            <span className="text-slate-500 text-xl font-sans">:</span>
            <span className={roundScore[1] > roundScore[0] ? 'text-red-400' : 'text-slate-200'}>
              {roundScore[1]}
            </span>
          </div>
          <span className="text-[10px] uppercase font-mono font-bold tracking-widest text-slate-400 mt-1">
            ROUND {currentRound} / 3 (FIRST TO 2)
          </span>
          {effectiveGodMode > 1.0 && (
            <span className="mt-1 px-2 py-0.5 bg-[#ffe500] text-black text-[9px] font-mono font-black border border-black shadow-sm">
              BOT LAB GOD-MODE: {effectiveGodMode}X
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="flex items-center justify-end gap-2">
              {mode === 'BOT_BATTLE' ? (
                <span className="text-[10px] font-mono font-black uppercase text-black bg-[#ffe500] px-1.5 py-0.2 border border-black">
                  AI BOT // {botDifficulty}
                </span>
              ) : (
                <>
                  {isLocalP2 && (
                    <span className="text-[10px] font-mono font-black uppercase text-black bg-[#ffe500] px-1.5 py-0.2 border border-black">
                      YOU · DIV {playerProfile.division}
                    </span>
                  )}
                  <span
                    className="text-xs px-1.5 py-0.5 bg-black border border-white/30 text-slate-300 font-mono"
                    title={`Platform: ${rightPlatform}`}
                  >
                    {rightPlatform === 'mobile' ? '📱 Mobile' : '🖥️ PC'}
                  </span>
                </>
              )}
              <span className="font-broadcast text-xl font-black italic uppercase text-white tracking-wide">
                {rightName}
              </span>
              <span className="text-lg">{isLocalP2 ? '🖋️' : opponentAvatar}</span>
            </div>
            <div className="text-xs font-mono font-bold flex items-center justify-end gap-1.5 mt-0.5">
              <span className={activeTurn === 'player2' ? 'text-red-400 font-black' : 'text-slate-300'}>
                {p2Pen?.name || 'Rival'}
              </span>
              <span className="px-1.5 py-0.2 bg-red-500/20 text-red-300 border border-red-500/40 text-[10px]">
                {p2Pen?.stats.weightGrams}g
              </span>
            </div>
          </div>
          <div className="w-11 h-11 bg-red-600 border-2 border-black flex items-center justify-center text-xl shadow-brutal-black">
            {mode === 'BOT_BATTLE' ? '🤖' : isLocalP2 ? '🖋️' : '🎯'}
          </div>
        </div>
      </div>

      {/* Live Network Sync & Turn Strip (ONLINE_ROOM only) */}
      {mode === 'ONLINE_ROOM' && (
        <div className="w-full flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 mb-2 bg-[#0a0d14] border-2 border-white/25 text-[11px] font-mono">
          <div className="flex items-center gap-2">
            {onlineConnectionStatus === 'CONNECTED' ? (
              <span className="inline-flex items-center gap-1 text-emerald-400 font-bold">
                <Wifi className="w-3.5 h-3.5" />
                LIVE SYNC {latencyMs !== null ? `(${latencyMs}ms)` : ''}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-400 font-bold animate-pulse">
                <WifiOff className="w-3.5 h-3.5" />
                {onlineConnectionStatus === 'RECONNECTING' ? 'Reconnecting…' : 'Disconnected'}
              </span>
            )}
            <span className="text-slate-500">|</span>
            <span className="text-slate-300">
              SIDE:{' '}
              <strong className="text-[#ffe500]">
                {localRole === 'player1' ? 'LEFT (HOST · AUTHORITATIVE)' : 'RIGHT (GUEST · SYNCED)'}
              </strong>
            </span>
          </div>

          <div className="flex items-center gap-2">
            {onlineNotice && <span className="text-amber-300 font-bold">{onlineNotice}</span>}
            <span
              className={`px-2 py-0.5 font-black uppercase border ${
                isMyTurn
                  ? 'bg-[#ffe500] text-black border-black animate-pulse'
                  : 'bg-slate-800 text-slate-300 border-slate-600'
              }`}
            >
              {isAwaitingOnlineTurn
                ? 'SYNCING FLICK...'
                : isMyTurn
                ? 'YOUR TURN TO FLICK'
                : `${opponentName.toUpperCase()}'S TURN`}
            </span>
          </div>
        </div>
      )}

      {/* Main Canvas Arena Container */}
      <div className="relative w-full aspect-[840/520] bg-black border-3 sm:border-4 border-white shadow-brutal-white overflow-hidden touch-none select-none">
        <canvas
          ref={canvasRef}
          width={DESK_WIDTH}
          height={DESK_HEIGHT}
          className="w-full h-full cursor-crosshair touch-none select-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />

        {/* Slow-mo Replay & Knockout Banner Overlay */}
        {knockoutBanner && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 backdrop-blur-xs pointer-events-none animate-fadeIn z-30">
            <div className="bg-[#ffe500] text-black border-4 border-black px-6 sm:px-8 py-3 shadow-brutal-black -rotate-2 flex flex-col items-center max-w-[90%] text-center">
              <div className="flex items-center gap-2 font-mono text-[10px] sm:text-xs font-black uppercase tracking-widest mb-0.5">
                <Camera className="w-4 h-4" /> REPLAY FLASH // OUT OF BOUNDS
              </div>
              <h2 className="font-broadcast text-2xl sm:text-5xl font-black italic tracking-wider uppercase text-black">
                {knockoutBanner}
              </h2>
            </div>
            <p className="text-white font-mono text-[10px] sm:text-xs uppercase tracking-widest mt-4 bg-black px-3 py-1 border border-white">
              DESK PERIMETER KNOCKOUT · POINT AWARDED
            </p>
          </div>
        )}

        {/* Pass & Play Device Handover Modal */}
        {passPlayNotice && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md p-6 z-40">
            <div className="bg-[#0e121b] border-4 border-[#ffe500] p-6 max-w-sm w-full text-center shadow-brutal-yellow">
              <div className="w-14 h-14 bg-[#ffe500] text-black border-2 border-black mx-auto flex items-center justify-center mb-3 shadow-brutal-black text-2xl">
                📱
              </div>
              <span className="text-xs uppercase font-mono font-bold tracking-widest text-[#ffe500] mb-1 block">
                PASS &amp; PLAY TURN HANDOVER
              </span>
              <h3 className="font-broadcast text-3xl font-black italic uppercase text-white mb-2">
                PASS TO {passPlayNotice}!
              </h3>
              <p className="text-slate-300 text-xs mb-5">
                Hand device over to the rival fighter. Tap ready when poised to aim and strike.
              </p>
              <button
                onClick={() => {
                  triggerHaptic('medium');
                  sounds.playClick();
                  setPassPlayNotice(null);
                }}
                className="w-full py-3 bg-[#ffe500] hover:bg-[#ebd300] text-black font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black shadow-brutal-white cursor-pointer active:scale-95 transition-transform"
              >
                I AM READY TO FLICK
              </button>
            </div>
          </div>
        )}

        {/* Self Reconnecting Overlay */}
        {mode === 'ONLINE_ROOM' && !matchWinner && onlineConnectionStatus === 'RECONNECTING' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm p-4 z-35">
            <div className="bg-[#0e121b] border-4 border-amber-400 p-5 max-w-sm w-full text-center shadow-brutal-yellow">
              <div className="w-12 h-12 bg-amber-400 text-black border-2 border-black mx-auto flex items-center justify-center mb-3 animate-pulse">
                <Clock className="w-6 h-6" />
              </div>
              <span className="text-[10px] font-mono font-black uppercase tracking-widest text-amber-400">
                CONNECTION INTERRUPTED
              </span>
              <h3 className="font-broadcast text-2xl font-black italic uppercase text-white mt-1">
                Reconnecting…
              </h3>
              <p className="text-xs text-slate-300 font-mono mt-2">
                Attempting to restore your live room session.
              </p>
            </div>
          </div>
        )}

        {/* Virtual Thumb Flick Pad for Mobile Ergonomics */}
        {useVirtualFlickPad && !isSimulating && !matchWinner && isMyTurn && (
          <div className="absolute bottom-2 right-2 sm:bottom-4 sm:right-4 z-20 pointer-events-none">
            <div className="border-2 border-dashed border-[#ffe500]/50 bg-black/40 backdrop-blur-xs px-3 py-2 flex flex-col items-center">
              <span className="text-[9px] font-mono font-black text-[#ffe500] uppercase tracking-wider">
                THUMB FLICK ZONE
              </span>
              <span className="text-[8px] font-mono text-slate-300">
                PULL BACK HERE TO AIM
              </span>
            </div>
          </div>
        )}

        {/* Match Finished Victory Modal */}
        {matchWinner && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md p-4 sm:p-6 z-40">
            <div className="bg-[#0e121b] border-4 border-[#ffe500] p-6 sm:p-8 max-w-md w-full text-center shadow-brutal-yellow">
              <div className="w-16 h-16 bg-[#ffe500] text-black border-2 border-black mx-auto flex items-center justify-center mb-3 shadow-brutal-black">
                <Award className="w-8 h-8" />
              </div>
              <span className="text-xs uppercase font-mono font-bold tracking-widest text-[#ffe500] mb-1 block">
                MATCH SETTLED // FINAL SCORE {roundScore[0]} : {roundScore[1]}
              </span>
              <h3 className="font-broadcast text-3xl sm:text-5xl font-black italic uppercase text-white mb-2">
                {didLocalPlayerWin ? `${playerProfile.username} WINS!` : `${opponentName} WINS!`}
              </h3>
              <p className="text-slate-300 text-xs sm:text-sm mb-6">
                {didLocalPlayerWin
                  ? `+${rewardClips} Paperclips secured! Progression XP saved to cloud profile.`
                  : '+5 Consolation Paperclips earned. Calibrate your flick angle for the rematch!'}
              </p>
              {mode === 'ONLINE_ROOM' && rematchState?.requestedByOpponent && !rematchState?.requestedByMe && (
                <div className="mb-3 px-3 py-1.5 bg-emerald-500/20 border border-emerald-400 text-emerald-300 font-mono text-xs font-bold">
                  {opponentName} wants a rematch!
                </div>
              )}
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <button
                  onClick={() => {
                    sounds.playClick();
                    if (mode === 'ONLINE_ROOM') {
                      onRequestRematch?.();
                    } else {
                      clearSafeTimeouts();
                      matchSettledRef.current = false;
                      setMatchWinner(null);
                      setRoundScoreSync([0, 0]);
                      setCurrentRoundSync(1);
                      setActiveTurnSync('player1');
                      resetRoundPositions();
                    }
                  }}
                  disabled={mode === 'ONLINE_ROOM' && rematchState?.requestedByMe}
                  className="w-full py-3 bg-[#ffe500] hover:bg-[#ebd300] text-black font-broadcast font-black text-sm uppercase tracking-wider border-2 border-black shadow-brutal-white cursor-pointer active:scale-95 disabled:opacity-60"
                >
                  {mode === 'ONLINE_ROOM'
                    ? rematchState?.requestedByMe
                      ? 'Waiting for Rival...'
                      : 'Request Rematch (R)'
                    : 'Instant Rematch (Press R)'}
                </button>
                <button
                  onClick={() => {
                    sounds.playClick();
                    onExitMatch();
                  }}
                  className="w-full py-3 bg-white/10 hover:bg-white/20 text-white font-broadcast font-bold text-sm uppercase tracking-wider border-2 border-white/30 cursor-pointer active:scale-95"
                >
                  Return to Hub
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* PC Keyboard Shortcuts HUD Bar (Desktop only) */}
      <div className="hidden lg:flex items-center justify-between w-full px-3 py-1.5 mt-2 bg-black/60 border border-white/10 text-[10px] font-mono text-slate-400">
        <div className="flex items-center gap-4">
          <span>
            <strong className="text-white bg-white/10 px-1 border border-white/20">1-6</strong> Technique Styles
          </span>
          <span>
            <strong className="text-white bg-white/10 px-1 border border-white/20">Q / E</strong> Curve Left/Right
          </span>
          <span>
            <strong className="text-white bg-white/10 px-1 border border-white/20">Scroll Wheel</strong> Spin
          </span>
          <span>
            <strong className="text-white bg-white/10 px-1 border border-white/20">Space</strong> Flick
          </span>
          <span>
            <strong className="text-white bg-white/10 px-1 border border-white/20">R</strong> Rematch
          </span>
        </div>
        <div className="flex items-center gap-2 text-[#ffe500]">
          <span>CROSSPLAY: {crossplay ? 'ENABLED' : 'SOLO'}</span>
        </div>
      </div>

      {/* Interactive Controls Bar */}
      <div className="w-full flex flex-col md:flex-row items-center justify-between gap-3 mt-3 bg-[#0e121b] border-2 border-white/20 p-3 sm:p-4 shadow-brutal-black">
        <div className="flex items-center justify-between w-full md:w-auto gap-2">
          <button
            onClick={() => {
              sounds.playClick();
              setShowPenChangeModal(true);
            }}
            className="flex-1 md:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-[#ffe500] hover:bg-[#ebd300] text-black font-broadcast font-black text-xs sm:text-sm uppercase tracking-wider border-2 border-black shadow-brutal-white active:scale-95 cursor-pointer whitespace-nowrap shrink-0"
          >
            <Scale className="w-4 h-4" />
            <span>Weapon ({myPen?.stats.weightGrams || p1Pen?.stats.weightGrams}g)</span>
          </button>

          <button
            onClick={() => {
              triggerHaptic('light');
              sounds.playClick();
              setUseVirtualFlickPad((p) => !p);
            }}
            className={`flex items-center gap-1.5 px-3 py-2.5 border-2 text-xs font-mono font-bold tracking-tight cursor-pointer active:scale-95 transition-all ${
              useVirtualFlickPad
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500'
                : 'bg-black text-slate-400 border-white/20 hover:text-white'
            }`}
            title="Toggle spacious thumb flick pad on desk"
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Thumb Pad:</span>
            <span>{useVirtualFlickPad ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        {/* Technique Styles Picker */}
        <div className="w-full md:w-auto flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-thin">
          <span className="hidden xl:inline text-xs font-mono font-bold uppercase text-slate-400 mr-1 whitespace-nowrap">
            STYLE:
          </span>
          {FLICK_STYLES.map((style, idx) => {
            const isUnlocked = playerProfile.unlockedFlickStyles.includes(style.id);
            const isSelected = selectedFlickStyle.id === style.id;

            return (
              <button
                key={style.id}
                disabled={!isUnlocked}
                onClick={() => {
                  triggerHaptic('light');
                  sounds.playClick();
                  setSelectedFlickStyle(style);
                }}
                className={`px-2.5 sm:px-3 py-1.5 text-[11px] sm:text-xs font-broadcast font-bold uppercase border-2 transition-all whitespace-nowrap shrink-0 flex items-center gap-1 cursor-pointer active:scale-95 ${
                  !isUnlocked
                    ? 'opacity-35 bg-white/5 border-transparent text-slate-500 cursor-not-allowed'
                    : isSelected
                    ? 'bg-white text-black border-white shadow-brutal-yellow font-black'
                    : 'bg-black border-white/20 hover:border-white/40 text-slate-300'
                }`}
                title={
                  isUnlocked
                    ? style.description
                    : `Unlocks at Player Level ${style.levelRequired}`
                }
              >
                <span className="hidden sm:inline text-[9px] font-mono font-black text-slate-400 bg-white/10 px-1 border border-white/20 mr-0.5">
                  {idx + 1}
                </span>
                <Zap className="w-3 h-3" />
                {style.name}
              </button>
            );
          })}
        </div>

        {/* Trajectory Spin Controls */}
        <div className="flex items-center justify-between w-full md:w-auto gap-2">
          <div className="flex items-center gap-1 bg-black p-1 border border-white/20">
            <button
              onClick={() => {
                triggerHaptic('spin');
                sounds.playClick();
                setCurveModifier((c) => Math.max(-1.0, +(c - 0.25).toFixed(2)));
              }}
              className="px-2 py-1 bg-white/10 hover:bg-white/20 text-white font-mono text-xs font-bold border border-white/20 active:scale-95"
              title="Curve Left"
            >
              ↶
            </button>
            <button
              onClick={() => {
                triggerHaptic('spin');
                sounds.playClick();
                setCurveModifier(0);
              }}
              className="px-2 py-1 bg-white/10 hover:bg-white/20 text-[#ffe500] font-mono text-[10px] font-black border border-white/20 active:scale-95"
              title="Reset Spin"
            >
              0
            </button>
            <button
              onClick={() => {
                triggerHaptic('spin');
                sounds.playClick();
                setCurveModifier((c) => Math.min(1.0, +(c + 0.25).toFixed(2)));
              }}
              className="px-2 py-1 bg-white/10 hover:bg-white/20 text-white font-mono text-xs font-bold border border-white/20 active:scale-95"
              title="Curve Right"
            >
              ↷
            </button>
            <span className="font-mono text-xs text-[#ffe500] font-bold px-1.5 tabular-nums">
              {curveModifier > 0 ? `+${curveModifier}` : curveModifier}
            </span>
          </div>

          <button
            onClick={() => {
              sounds.playClick();
              onExitMatch();
            }}
            className="px-3 sm:px-4 py-2 text-xs font-broadcast font-bold uppercase bg-white/10 hover:bg-white/20 text-slate-200 border border-white/20 transition-colors cursor-pointer active:scale-95 whitespace-nowrap shrink-0"
          >
            Leave
          </button>
        </div>
      </div>

      {/* Change Pen Modal */}
      {showPenChangeModal && (
        <PenChangeModal
          currentPenId={playerProfile.equippedPenId}
          profile={playerProfile}
          onSelectPen={(penId) => {
            if (onEquipPen) onEquipPen(penId);
            scheduleSafeTimeout(() => resetRoundPositions(), 50);
          }}
          onClose={() => setShowPenChangeModal(false)}
        />
      )}
    </div>
  );
};
