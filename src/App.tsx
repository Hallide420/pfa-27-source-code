/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  GameView,
  Tournament,
  TournamentMatch,
  BotDifficulty,
  MatchMode,
  OnlineFlickPayload,
  OnlineMatchSyncState,
  OnlinePenSnapshot,
  OnlineTurnChangePayload,
  OnlineMatchResultPayload,
} from './types/game';
import { sounds } from './utils/audio';
import { BOT_DIFFICULTIES, INITIAL_TOURNAMENTS } from './data/initialData';
import { AuthProvider, useAuth } from './firebase/AuthContext';
import { SignInGate } from './components/SignInGate';
import { Navbar } from './components/Navbar';
import { MobileNavDock } from './components/MobileNavDock';
import { HubDashboard } from './components/HubDashboard';
import { DeskArena } from './components/DeskArena';
import { TournamentBracketView } from './components/TournamentBracketView';
import { DivisionsView } from './components/DivisionsView';
import { GeometryBoxStore } from './components/GeometryBoxStore';
import { PenLocker } from './components/PenLocker';
import { MultiplayerLobby } from './components/MultiplayerLobby';
import { AdminPanelModal } from './components/AdminPanelModal';
import { BotLabModal } from './components/BotLabModal';
import { TutorialAcademy } from './components/TutorialAcademy';
import { NewsView } from './components/NewsView';
import { detectDevicePlatform } from './utils/device';

function cloneInitialTournaments(): Tournament[] {
  return JSON.parse(JSON.stringify(INITIAL_TOURNAMENTS)) as Tournament[];
}

function getTournamentStorageKey(uid: string): string {
  return `pfa27_tournaments_${uid}`;
}

function loadUserTournaments(uid: string): Tournament[] {
  try {
    const raw = localStorage.getItem(getTournamentStorageKey(uid));
    if (!raw) return cloneInitialTournaments();
    const parsed = JSON.parse(raw) as Tournament[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch {}
  return cloneInitialTournaments();
}

function MainAppContent() {
  const {
    user,
    profile,
    loading,
    signOutUser,
    updateCosmeticPrefs,
    submitMatchResult,
    purchaseGeometryBox,
    claimTutorialReward,
    isAdminUser,
    godModePower,
  } = useAuth();

  const [currentView, setCurrentView] = useState<GameView>('HUB');
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isAdminModalOpen, setIsAdminModalOpen] = useState<boolean>(false);
  const [isBotLabOpen, setIsBotLabOpen] = useState<boolean>(false);
  const [activeBotDifficulty, setActiveBotDifficulty] = useState<BotDifficulty>('NORMAL');
  const [activeBotPenId, setActiveBotPenId] = useState<string>('pilot_g2');

  // Persistent tournament progression per signed-in player
  const [tournaments, setTournaments] = useState<Tournament[]>(cloneInitialTournaments);
  const [currentActiveTournamentId, setCurrentActiveTournamentId] = useState<string | null>(null);
  const [currentActiveMatchId, setCurrentActiveMatchId] = useState<string | null>(null);

  useEffect(() => {
    if (user?.uid) {
      setTournaments(loadUserTournaments(user.uid));
    } else {
      setTournaments(cloneInitialTournaments());
    }
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    try {
      localStorage.setItem(getTournamentStorageKey(user.uid), JSON.stringify(tournaments));
    } catch {}
  }, [tournaments, user?.uid]);

  // Match setup state (no fake hardcoded rival stub)
  const [matchMode, setMatchMode] = useState<MatchMode>('BOT_BATTLE');
  const [activeOpponentName, setActiveOpponentName] = useState<string>('Opponent');
  const [activeOpponentAvatar, setActiveOpponentAvatar] = useState<string>('🎯');
  const [activeOpponentPlatform, setActiveOpponentPlatform] = useState<'mobile' | 'desktop'>('desktop');

  // Platform and crossplay preferences
  const currentPlatform: 'mobile' | 'desktop' = profile?.platform || detectDevicePlatform();
  const crossplaySetting = profile?.crossplaySetting || 'CROSSPLAY_ENABLED';

  const handleToggleCrossplay = () => {
    const nextSetting =
      crossplaySetting === 'CROSSPLAY_ENABLED' ? 'SAME_PLATFORM_ONLY' : 'CROSSPLAY_ENABLED';
    void updateCosmeticPrefs({ crossplaySetting: nextSetting });
  };

  // Online WebSocket & Matchmaking Queue state
  const wsRef = useRef<WebSocket | null>(null);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const reconnectAttemptsRef = useRef<number>(0);
  const intentionalCloseRef = useRef<boolean>(false);
  const onlineSessionRef = useRef<{ roomCode: string; sessionToken: string } | null>(null);
  const turnSeqRef = useRef<number>(0);

  const [incomingOnlineFlick, setIncomingOnlineFlick] = useState<OnlineFlickPayload | null>(null);
  const [onlineSyncSnapshot, setOnlineSyncSnapshot] = useState<OnlineMatchSyncState | null>(null);
  const [onlineTurnChange, setOnlineTurnChange] = useState<OnlineTurnChangePayload | null>(null);
  const [onlineMatchResult, setOnlineMatchResult] = useState<OnlineMatchResultPayload | null>(null);
  const [onlineTurnSeq, setOnlineTurnSeq] = useState<number>(0);
  const [onlineRole, setOnlineRole] = useState<'player1' | 'player2'>('player1');
  const [activeOpponentPenId, setActiveOpponentPenId] = useState<string | undefined>(undefined);
  const [onlineRoomCode, setOnlineRoomCode] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [isSearchingQueue, setIsSearchingQueue] = useState<boolean>(false);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);
  const [onlineConnectionStatus, setOnlineConnectionStatus] = useState<
    'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED'
  >('CONNECTED');
  const [onlineNotice, setOnlineNotice] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [rematchState, setRematchState] = useState<{
    requestedByMe: boolean;
    requestedByOpponent: boolean;
    triggerCounter: number;
  }>({ requestedByMe: false, requestedByOpponent: false, triggerCounter: 0 });

  const scheduleManagedTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      pendingTimersRef.current.delete(id);
      fn();
    }, ms);
    pendingTimersRef.current.add(id);
    return id;
  }, []);

  const clearAllManagedTimers = useCallback(() => {
    for (const id of pendingTimersRef.current) {
      clearTimeout(id);
    }
    pendingTimersRef.current.clear();
  }, []);

  const saveOnlineSession = useCallback((roomCode: string, sessionToken: string) => {
    onlineSessionRef.current = { roomCode, sessionToken };
    try {
      sessionStorage.setItem('pfa27_online_session', JSON.stringify({ roomCode, sessionToken }));
    } catch {}
  }, []);

  const clearOnlineSession = useCallback(() => {
    onlineSessionRef.current = null;
    try {
      sessionStorage.removeItem('pfa27_online_session');
    } catch {}
  }, []);

  const closeWebSocketCleanly = useCallback(() => {
    clearAllManagedTimers();
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      try {
        if (
          wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING
        ) {
          wsRef.current.close();
        }
      } catch {}
      wsRef.current = null;
    }
  }, [clearAllManagedTimers]);

  // Close WebSocket & pending timers cleanly on unmount or sign-out
  useEffect(() => {
    if (!user?.uid) {
      closeWebSocketCleanly();
      clearOnlineSession();
      setOnlineRoomCode(null);
      setIsSearchingQueue(false);
      setQueueMessage(null);
      setOnlineSyncSnapshot(null);
      setOnlineTurnChange(null);
      setOnlineMatchResult(null);
      setIncomingOnlineFlick(null);
    }
  }, [user?.uid, closeWebSocketCleanly, clearOnlineSession]);

  useEffect(() => {
    return () => {
      closeWebSocketCleanly();
    };
  }, [closeWebSocketCleanly]);

  // Periodic latency ping while in an active online room
  useEffect(() => {
    if (matchMode !== 'ONLINE_ROOM' || currentView !== 'MATCH') return;
    const pingInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'PING', ts: Date.now() }));
      }
    }, 5000);
    return () => clearInterval(pingInterval);
  }, [matchMode, currentView]);

  // Initialize / reuse single WebSocket connection with 1-attempt mid-match reconnect
  const initWebSocket = useCallback(
    (isReconnectAttempt: boolean = false) => {
      if (
        !isReconnectAttempt &&
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return wsRef.current;
      }

      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        intentionalCloseRef.current = true;
        wsRef.current.close();
      }

      intentionalCloseRef.current = false;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setOnlineConnectionStatus('CONNECTED');
        setOnlineNotice(null);
        socket.send(JSON.stringify({ type: 'PING', ts: Date.now() }));

        if (isReconnectAttempt && onlineSessionRef.current) {
          socket.send(
            JSON.stringify({
              type: 'RECONNECT_ROOM',
              roomCode: onlineSessionRef.current.roomCode,
              sessionToken: onlineSessionRef.current.sessionToken,
            })
          );
        }
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as Record<string, unknown>;
          const type = String(msg.type || '');

          switch (type) {
            case 'PING': {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'PONG', ts: msg.ts }));
              }
              break;
            }

            case 'PONG': {
              if (typeof msg.ts === 'number') {
                setLatencyMs(Math.max(1, Date.now() - msg.ts));
              }
              break;
            }

            case 'RTT_UPDATE': {
              if (typeof msg.rttMs === 'number') {
                setLatencyMs(Math.max(1, msg.rttMs));
              }
              break;
            }

            case 'ROOM_CREATED': {
              const code = String(msg.roomCode || '');
              setOnlineRoomCode(code || null);
              setOnlineRole(msg.yourRole === 'guest' || msg.role === 'player2' ? 'player2' : 'player1');
              setRoomError(null);
              if (code && typeof msg.sessionToken === 'string') {
                saveOnlineSession(code, msg.sessionToken);
              }
              break;
            }

            case 'QUEUE_JOINED': {
              setIsSearchingQueue(true);
              setQueueMessage(
                typeof msg.message === 'string'
                  ? msg.message
                  : 'Searching for a compatible ranked opponent...'
              );
              setRoomError(null);
              break;
            }

            case 'QUEUE_LEFT': {
              setIsSearchingQueue(false);
              setQueueMessage(null);
              break;
            }

            case 'OPPONENT_JOINED':
            case 'ROOM_JOINED':
            case 'QUEUE_MATCHED': {
              const seq = typeof msg.turnSeq === 'number' ? msg.turnSeq : 0;
              turnSeqRef.current = seq;
              setOnlineTurnSeq(seq);
              setIsSearchingQueue(false);
              setQueueMessage(null);
              setRoomError(null);

              const mappedRole: 'player1' | 'player2' =
                msg.yourRole === 'guest' || msg.role === 'player2' ? 'player2' : 'player1';
              setOnlineRole(mappedRole);

              const code = typeof msg.roomCode === 'string' ? msg.roomCode : null;
              if (code) {
                setOnlineRoomCode(code);
                if (typeof msg.sessionToken === 'string') {
                  saveOnlineSession(code, msg.sessionToken);
                }
              }

              setActiveOpponentName(
                typeof msg.opponentName === 'string' && msg.opponentName.trim()
                  ? msg.opponentName
                  : 'Online Rival'
              );
              setActiveOpponentAvatar(mappedRole === 'player1' ? '⚡' : '👑');
              setActiveOpponentPenId(typeof msg.opponentPen === 'string' ? msg.opponentPen : undefined);
              if (msg.opponentPlatform === 'mobile' || msg.opponentPlatform === 'desktop') {
                setActiveOpponentPlatform(msg.opponentPlatform);
              }

              setOnlineSyncSnapshot(null);
              setOnlineTurnChange(null);
              setOnlineMatchResult(null);
              setIncomingOnlineFlick(null);
              setOnlineNotice(null);
              setRematchState({ requestedByMe: false, requestedByOpponent: false, triggerCounter: 0 });
              setMatchMode('ONLINE_ROOM');
              setCurrentView('MATCH');
              break;
            }

            case 'ROOM_RECONNECTED': {
              const seq = typeof msg.turnSeq === 'number' ? msg.turnSeq : 0;
              turnSeqRef.current = seq;
              setOnlineTurnSeq(seq);
              setOnlineRole(msg.yourRole === 'guest' || msg.role === 'player2' ? 'player2' : 'player1');
              setOnlineRoomCode(typeof msg.roomCode === 'string' ? msg.roomCode : null);
              setActiveOpponentName(
                typeof msg.opponentName === 'string' ? msg.opponentName : 'Online Rival'
              );
              setActiveOpponentPenId(typeof msg.opponentPen === 'string' ? msg.opponentPen : undefined);
              if (msg.opponentPlatform === 'mobile' || msg.opponentPlatform === 'desktop') {
                setActiveOpponentPlatform(msg.opponentPlatform);
              }
              setOnlineNotice('Reconnected cleanly to live desk.');
              scheduleManagedTimeout(() => setOnlineNotice(null), 3000);
              if (msg.snapshot && typeof msg.snapshot === 'object') {
                setOnlineSyncSnapshot(msg.snapshot as OnlineMatchSyncState);
              }
              setMatchMode('ONLINE_ROOM');
              setCurrentView('MATCH');
              break;
            }

            case 'RECONNECT_FAILED': {
              clearOnlineSession();
              setOnlineRoomCode(null);
              setOnlineConnectionStatus('DISCONNECTED');
              setRoomError(typeof msg.message === 'string' ? msg.message : 'Session expired.');
              setCurrentView('MULTIPLAYER');
              break;
            }

            case 'FLICK_ACCEPTED': {
              if (typeof msg.turnSeq === 'number') {
                turnSeqRef.current = msg.turnSeq;
                setOnlineTurnSeq(msg.turnSeq);
              }
              break;
            }

            case 'ACTION_REJECTED': {
              setOnlineNotice(
                typeof msg.message === 'string' ? msg.message : 'Action rejected by server.'
              );
              scheduleManagedTimeout(() => setOnlineNotice(null), 2500);
              if (typeof msg.turnSeq === 'number') {
                turnSeqRef.current = msg.turnSeq;
                setOnlineTurnSeq(msg.turnSeq);
              }
              if (msg.snapshot && typeof msg.snapshot === 'object') {
                setOnlineSyncSnapshot(msg.snapshot as OnlineMatchSyncState);
              }
              break;
            }

            case 'OPPONENT_FLICKED': {
              const seq = typeof msg.turnSeq === 'number' ? msg.turnSeq : turnSeqRef.current;
              turnSeqRef.current = seq;
              setOnlineTurnSeq(seq);
              setIncomingOnlineFlick({
                power: Number(msg.power) || 0.5,
                angle: Number(msg.angle) || 0,
                curve: Number(msg.curve) || 0,
                styleId: String(msg.flickStyleId || 'style_classic_thumb'),
                actor: msg.actor === 'player1' ? 'player1' : 'player2',
                turnSeq: seq,
              });
              break;
            }

            case 'PEER_STATE_SYNC': {
              const seq = typeof msg.turnSeq === 'number' ? msg.turnSeq : turnSeqRef.current;
              turnSeqRef.current = seq;
              setOnlineTurnSeq(seq);
              setOnlineSyncSnapshot({
                pens: Array.isArray(msg.pens) ? (msg.pens as OnlinePenSnapshot[]) : [],
                activeTurn: msg.activeTurn === 'player2' ? 'player2' : 'player1',
                roundScore: Array.isArray(msg.roundScore) && msg.roundScore.length === 2
                  ? [Number(msg.roundScore[0]) || 0, Number(msg.roundScore[1]) || 0]
                  : [0, 0],
                currentRound: Number(msg.currentRound) || 1,
                turnSeq: seq,
                matchWinner: null,
              });
              break;
            }

            case 'TURN_CHANGE': {
              const seq = typeof msg.turnSeq === 'number' ? msg.turnSeq : turnSeqRef.current;
              turnSeqRef.current = seq;
              setOnlineTurnSeq(seq);
              setOnlineTurnChange({
                nextTurn: msg.nextTurn === 'guest' ? 'guest' : 'host',
                activeTurn: msg.activeTurn === 'player2' ? 'player2' : 'player1',
                turnSeq: seq,
                roundScore: Array.isArray(msg.roundScore) && msg.roundScore.length === 2
                  ? [Number(msg.roundScore[0]) || 0, Number(msg.roundScore[1]) || 0]
                  : [0, 0],
                currentRound: Number(msg.currentRound) || 1,
                pens: Array.isArray(msg.pens) ? (msg.pens as OnlinePenSnapshot[]) : [],
              });
              break;
            }

            case 'MATCH_RESULT': {
              setOnlineMatchResult({
                winner: msg.winner === 'guest' ? 'guest' : 'host',
                finalScore: Array.isArray(msg.finalScore) && msg.finalScore.length === 2
                  ? [Number(msg.finalScore[0]) || 0, Number(msg.finalScore[1]) || 0]
                  : [0, 0],
                settlementToken: typeof msg.settlementToken === 'string' ? msg.settlementToken : undefined,
              });
              break;
            }

            case 'OPPONENT_DISCONNECTED': {
              // Confirmed policy: immediately end match cleanly and return to lobby with zero rewards
              clearOnlineSession();
              setOnlineRoomCode(null);
              setIsSearchingQueue(false);
              setQueueMessage(null);
              setOnlineSyncSnapshot(null);
              setOnlineTurnChange(null);
              setOnlineMatchResult(null);
              setIncomingOnlineFlick(null);
              setOnlineNotice(null);
              setRoomError(typeof msg.message === 'string' ? msg.message : 'Opponent disconnected');
              setCurrentView('MULTIPLAYER');
              break;
            }

            case 'REMATCH_REQUESTED': {
              setRematchState((prev) => ({ ...prev, requestedByOpponent: true }));
              break;
            }

            case 'REMATCH_STARTED': {
              const seq = typeof msg.turnSeq === 'number' ? msg.turnSeq : 0;
              turnSeqRef.current = seq;
              setOnlineTurnSeq(seq);
              setOnlineSyncSnapshot(null);
              setOnlineTurnChange(null);
              setOnlineMatchResult(null);
              setIncomingOnlineFlick(null);
              setRematchState((prev) => ({
                requestedByMe: false,
                requestedByOpponent: false,
                triggerCounter: prev.triggerCounter + 1,
              }));
              break;
            }

            case 'ERROR': {
              setIsSearchingQueue(false);
              setQueueMessage(null);
              setRoomError(
                typeof msg.message === 'string' ? msg.message : 'Room connection error.'
              );
              break;
            }

            default:
              break;
          }
        } catch (err) {
          console.error('Socket message parse error', err);
        }
      };

      socket.onclose = () => {
        if (intentionalCloseRef.current) return;

        // One automatic reconnect attempt with visible "Reconnecting..." notice when in an active room
        if (onlineSessionRef.current && reconnectAttemptsRef.current < 1) {
          reconnectAttemptsRef.current = 1;
          setOnlineConnectionStatus('RECONNECTING');
          setOnlineNotice('Reconnecting…');
          scheduleManagedTimeout(() => {
            initWebSocket(true);
          }, 800);
        } else if (onlineSessionRef.current) {
          clearOnlineSession();
          setOnlineRoomCode(null);
          setOnlineConnectionStatus('DISCONNECTED');
          setOnlineNotice(null);
          setOnlineSyncSnapshot(null);
          setOnlineTurnChange(null);
          setOnlineMatchResult(null);
          setIncomingOnlineFlick(null);
          setRoomError('Connection lost. Returned to lobby.');
          setCurrentView('MULTIPLAYER');
        } else {
          setIsSearchingQueue(false);
          setQueueMessage(null);
          setOnlineConnectionStatus('DISCONNECTED');
        }
      };

      wsRef.current = socket;
      return socket;
    },
    [clearOnlineSession, saveOnlineSession, scheduleManagedTimeout]
  );

  // Send helper waiting safely for WebSocket OPEN with bounded retry & cleanup tracking
  const sendWhenConnected = useCallback(
    (payload: Record<string, unknown>) => {
      const socket = initWebSocket(false);
      let attempts = 0;

      const checkAndSend = () => {
        if (wsRef.current !== socket) return;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(payload));
          return;
        }
        if (socket.readyState === WebSocket.CONNECTING && attempts < 25) {
          attempts += 1;
          scheduleManagedTimeout(checkAndSend, 100);
          return;
        }
        setIsSearchingQueue(false);
        setQueueMessage(null);
        setRoomError('Unable to reach multiplayer server. Please try again.');
      };

      checkAndSend();
    },
    [initWebSocket, scheduleManagedTimeout]
  );

  const handleCreateRoom = useCallback(() => {
    if (!profile) return;
    setRoomError(null);
    setOnlineRoomCode(null);
    sendWhenConnected({
      type: 'CREATE_ROOM',
      playerName: profile.username,
      penId: profile.equippedPenId,
      platform: currentPlatform,
      crossplay: crossplaySetting === 'CROSSPLAY_ENABLED',
    });
  }, [profile, currentPlatform, crossplaySetting, sendWhenConnected]);

  const handleJoinRoom = useCallback(
    (roomCode: string) => {
      if (!profile) return;
      setRoomError(null);
      sendWhenConnected({
        type: 'JOIN_ROOM',
        roomCode,
        playerName: profile.username,
        penId: profile.equippedPenId,
        platform: currentPlatform,
        crossplay: crossplaySetting === 'CROSSPLAY_ENABLED',
      });
    },
    [profile, currentPlatform, crossplaySetting, sendWhenConnected]
  );

  const handleJoinQueue = useCallback(() => {
    if (!profile) return;
    setRoomError(null);
    setIsSearchingQueue(true);
    setQueueMessage('Connecting to competitive queue...');
    sendWhenConnected({
      type: 'JOIN_QUEUE',
      playerName: profile.username,
      penId: profile.equippedPenId,
      platform: currentPlatform,
      crossplay: crossplaySetting === 'CROSSPLAY_ENABLED',
    });
  }, [profile, currentPlatform, crossplaySetting, sendWhenConnected]);

  const handleLeaveQueue = useCallback(() => {
    setIsSearchingQueue(false);
    setQueueMessage(null);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'LEAVE_QUEUE' }));
    }
  }, []);

  const handleSendFlickOnline = useCallback(
    (power: number, angle: number, curve: number, styleId: string) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'FLICK_ACTION',
            power,
            angle,
            curve,
            flickStyleId: styleId,
            turnSeq: turnSeqRef.current,
          })
        );
      }
    },
    []
  );

  const handleSendSyncStateOnline = useCallback((snapshot: OnlineMatchSyncState) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'SYNC_STATE',
          ...snapshot,
        })
      );
    }
  }, []);

  const handleSendTurnChangeOnline = useCallback(
    (payload: {
      nextTurn: 'host' | 'guest';
      roundScore: [number, number];
      currentRound: number;
      pens: OnlinePenSnapshot[];
    }) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'TURN_CHANGE',
            ...payload,
          })
        );
      }
    },
    []
  );

  const handleSendMatchResultOnline = useCallback(
    (payload: { winner: 'host' | 'guest'; finalScore: [number, number] }) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'MATCH_RESULT',
            ...payload,
          })
        );
      }
    },
    []
  );

  const handleRequestRematchOnline = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setRematchState((prev) => ({ ...prev, requestedByMe: true }));
      wsRef.current.send(JSON.stringify({ type: 'REQUEST_REMATCH' }));
    }
  }, []);

  const handleExitMatch = useCallback(() => {
    if (matchMode === 'ONLINE_ROOM') {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
      }
      closeWebSocketCleanly();
      clearOnlineSession();
      setOnlineRoomCode(null);
      setOnlineSyncSnapshot(null);
      setOnlineTurnChange(null);
      setOnlineMatchResult(null);
      setIncomingOnlineFlick(null);
    }
    setCurrentView('HUB');
  }, [matchMode, closeWebSocketCleanly, clearOnlineSession]);

  const handleSignOut = async () => {
    closeWebSocketCleanly();
    clearOnlineSession();
    setOnlineRoomCode(null);
    setIsSearchingQueue(false);
    setQueueMessage(null);
    setCurrentView('HUB');
    await signOutUser();
  };

  const handleToggleMute = () => {
    const muted = sounds.toggleMute();
    setIsMuted(muted);
  };

  const handleQuickRanked = () => {
    sounds.playClick();
    setCurrentView('MULTIPLAYER');
  };

  const handleStartBotBattle = (difficulty: BotDifficulty, botPenId: string) => {
    setMatchMode('BOT_BATTLE');
    setActiveBotDifficulty(difficulty);
    setActiveBotPenId(botPenId);
    const diffConfig =
      BOT_DIFFICULTIES.find((d) => d.id === difficulty) || BOT_DIFFICULTIES[2];
    setActiveOpponentName(diffConfig.name);
    setActiveOpponentAvatar(diffConfig.avatar);
    setCurrentView('MATCH');
  };

  const handleStartPassAndPlay = () => {
    setMatchMode('PASS_PLAY');
    setActiveOpponentName('Player 2 (Local)');
    setActiveOpponentAvatar('🎮');
    setCurrentView('MATCH');
  };

  const handleStartTournamentMatch = (tournament: Tournament, match: TournamentMatch) => {
    setCurrentActiveTournamentId(tournament.id);
    setCurrentActiveMatchId(match.id);
    setMatchMode('TOURNAMENT');
    const opponent = match.player1.isUser ? match.player2 : match.player1;
    setActiveOpponentName(opponent.name);
    setActiveOpponentAvatar(opponent.avatar);
    setCurrentView('MATCH');
  };

  const handleResetTournament = (tournamentId: string) => {
    const template = cloneInitialTournaments().find((t) => t.id === tournamentId);
    if (!template) return;
    setTournaments((prev) => prev.map((t) => (t.id === tournamentId ? template : t)));
  };

  const handleMatchComplete = useCallback(
    (winner: 'player1' | 'player2', settlementToken?: string) => {
      if (!profile) return;
      const isVictory = winner === 'player1';

      if (isVictory) {
        sounds.playPaperclipReward();
      }

      // Settle rewards via server-verified Admin SDK endpoint
      void submitMatchResult(matchMode, isVictory, settlementToken).catch((err) => {
        console.warn('Server reward settlement notice:', err);
      });

      // Advance persistent tournament bracket when playing a tournament match
      if (matchMode === 'TOURNAMENT' && currentActiveTournamentId && currentActiveMatchId) {
        setTournaments((prev) =>
          prev.map((tourney) => {
            if (tourney.id !== currentActiveTournamentId) return tourney;

            const updatedMatches = tourney.matches.map((m) => ({
              ...m,
              player1: { ...m.player1 },
              player2: { ...m.player2 },
              score: [...m.score] as [number, number],
            }));

            const matchIdx = updatedMatches.findIndex((m) => m.id === currentActiveMatchId);
            if (matchIdx === -1) return tourney;

            const finishedMatch = updatedMatches[matchIdx];
            const userSide: 1 | 2 = finishedMatch.player1.isUser ? 1 : 2;
            const oppSide: 1 | 2 = userSide === 1 ? 2 : 1;
            const winningSide: 1 | 2 = isVictory ? userSide : oppSide;

            finishedMatch.status = 'COMPLETED';
            finishedMatch.winner = winningSide;
            finishedMatch.score = winningSide === 1 ? [2, 0] : [0, 2];

            const advancingPlayer =
              winningSide === 1
                ? {
                    ...finishedMatch.player1,
                    name: finishedMatch.player1.isUser ? profile.username : finishedMatch.player1.name,
                  }
                : {
                    ...finishedMatch.player2,
                    name: finishedMatch.player2.isUser ? profile.username : finishedMatch.player2.name,
                  };

            let nextRound = tourney.currentRound;
            let isCompleted = tourney.isCompleted;

            if (finishedMatch.round === 1) {
              const sf1 = updatedMatches.find((m) => m.round === 2);
              if (sf1) {
                sf1.player1 = advancingPlayer;
              }
              if (isVictory) {
                nextRound = 2;
              } else {
                isCompleted = true;
              }
            } else if (finishedMatch.round === 2) {
              const otherSf = updatedMatches.find(
                (m) => m.round === 2 && m.id !== finishedMatch.id
              );
              let otherSfWinner = otherSf ? { ...otherSf.player1 } : null;
              if (otherSf && otherSf.status !== 'COMPLETED') {
                const aiPick: 1 | 2 = otherSf.player1.rating >= otherSf.player2.rating ? 1 : 2;
                otherSf.status = 'COMPLETED';
                otherSf.winner = aiPick;
                otherSf.score = aiPick === 1 ? [2, 1] : [1, 2];
                otherSfWinner = aiPick === 1 ? { ...otherSf.player1 } : { ...otherSf.player2 };
              }

              const grandFinal = updatedMatches.find((m) => m.round === 3);
              if (grandFinal) {
                grandFinal.player1 = advancingPlayer;
                if (otherSfWinner) {
                  grandFinal.player2 = otherSfWinner;
                }
              }

              if (isVictory) {
                nextRound = 3;
              } else {
                isCompleted = true;
              }
            } else if (finishedMatch.round === 3) {
              isCompleted = true;
            }

            return {
              ...tourney,
              matches: updatedMatches,
              currentRound: nextRound,
              isCompleted,
            };
          })
        );
      }
    },
    [profile, matchMode, currentActiveTournamentId, currentActiveMatchId, submitMatchResult]
  );

  const handleEquipNow = (penId: string, skinId: string) => {
    void updateCosmeticPrefs({ equippedPenId: penId, equippedSkinId: skinId });
  };

  const handleCompleteTutorial = async () => {
    try {
      const newlyClaimed = await claimTutorialReward();
      if (newlyClaimed) {
        sounds.levelUp();
      }
    } catch (err) {
      console.warn('Tutorial graduation claim notice:', err);
    }
    setCurrentView('HUB');
  };

  const currentRewardClips =
    matchMode === 'TOURNAMENT'
      ? 80
      : matchMode === 'ONLINE_ROOM'
      ? 35
      : matchMode === 'BOT_BATTLE'
      ? 20
      : 15;

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] bg-graph-paper flex flex-col items-center justify-center text-white font-sans p-4">
        <div className="w-16 h-16 border-4 border-black border-t-[#ffe500] animate-spin mb-6 bg-white shadow-brutal-yellow" />
        <span className="font-broadcast text-4xl sm:text-5xl font-black italic tracking-wide text-white">
          PFA{' '}
          <span className="bg-[#ffe500] text-black px-2 py-0.5 border-2 border-black inline-block -rotate-1 shadow-brutal-white">
            27
          </span>
        </span>
        <p className="font-mono text-xs uppercase tracking-widest text-[#ffe500] mt-3">
          VERIFYING FIGHTER CREDENTIALS &amp; SESSIONS...
        </p>
      </div>
    );
  }

  // Not signed in: Require sign in gate
  if (!user || !profile) {
    return <SignInGate />;
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] bg-graph-paper text-neutral-100 flex flex-col font-sans selection:bg-[#ffe500] selection:text-black">
      {/* 3-Zone Top Bar Navigation */}
      <Navbar
        currentView={currentView}
        onNavigate={(view) => setCurrentView(view)}
        profile={profile}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        userEmail={user.email || undefined}
        userPhoto={user.photoURL}
        onSignOut={() => void handleSignOut()}
        isAdminUser={isAdminUser}
        onOpenAdminPanel={() => setIsAdminModalOpen(true)}
        platform={currentPlatform}
        crossplaySetting={crossplaySetting}
        onToggleCrossplay={handleToggleCrossplay}
        onOpenBotLab={() => setIsBotLabOpen(true)}
      />

      {/* Main View Router */}
      <main className="flex-1 pb-28 lg:pb-16 px-1 sm:px-2">
        {currentView === 'HUB' && (
          <HubDashboard
            profile={profile}
            isAdminUser={isAdminUser}
            onNavigate={(view) => setCurrentView(view)}
            onQuickRankedMatch={handleQuickRanked}
            onStartPassAndPlay={handleStartPassAndPlay}
            onOpenBotLab={() => setIsBotLabOpen(true)}
          />
        )}

        {currentView === 'MATCH' && (
          <DeskArena
            mode={matchMode}
            playerProfile={profile}
            botDifficulty={activeBotDifficulty}
            botPenId={activeBotPenId}
            opponentName={activeOpponentName}
            opponentAvatar={activeOpponentAvatar}
            opponentPenId={activeOpponentPenId}
            localRole={onlineRole}
            onMatchComplete={handleMatchComplete}
            onExitMatch={handleExitMatch}
            onEquipPen={(penId) => void updateCosmeticPrefs({ equippedPenId: penId })}
            onSendFlick={handleSendFlickOnline}
            onSendSyncState={handleSendSyncStateOnline}
            onSendTurnChange={handleSendTurnChangeOnline}
            onSendMatchResult={handleSendMatchResultOnline}
            onRequestRematch={handleRequestRematchOnline}
            incomingOnlineFlick={incomingOnlineFlick}
            onlineSyncSnapshot={onlineSyncSnapshot}
            onlineTurnChange={onlineTurnChange}
            onlineMatchResult={onlineMatchResult}
            onlineTurnSeq={onlineTurnSeq}
            onlineConnectionStatus={onlineConnectionStatus}
            onlineNotice={onlineNotice}
            latencyMs={latencyMs}
            rematchState={rematchState}
            isAdminUser={isAdminUser}
            godModePower={isAdminUser && matchMode === 'BOT_BATTLE' ? godModePower : 1.0}
            playerPlatform={currentPlatform}
            opponentPlatform={activeOpponentPlatform}
            crossplay={crossplaySetting === 'CROSSPLAY_ENABLED'}
            rewardClips={currentRewardClips}
          />
        )}

        {currentView === 'TOURNAMENT' && (
          <TournamentBracketView
            profile={profile}
            tournaments={tournaments}
            isAdminUser={isAdminUser}
            onStartTournamentMatch={handleStartTournamentMatch}
            onResetTournament={handleResetTournament}
          />
        )}

        {currentView === 'GEOMETRY_STORE' && (
          <GeometryBoxStore
            profile={profile}
            onPurchaseBox={purchaseGeometryBox}
            onEquipNow={handleEquipNow}
          />
        )}

        {currentView === 'LOCKER' && (
          <PenLocker
            profile={profile}
            onEquipPen={(penId) => void updateCosmeticPrefs({ equippedPenId: penId })}
            onEquipSkin={(skinId) => void updateCosmeticPrefs({ equippedSkinId: skinId })}
            onEquipFlickStyle={(styleId) =>
              void updateCosmeticPrefs({ equippedFlickStyleId: styleId })
            }
          />
        )}

        {currentView === 'MULTIPLAYER' && (
          <MultiplayerLobby
            profile={profile}
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
            onJoinQueue={handleJoinQueue}
            onLeaveQueue={handleLeaveQueue}
            isSearchingQueue={isSearchingQueue}
            queueMessage={queueMessage}
            crossplaySetting={crossplaySetting}
            onToggleCrossplay={handleToggleCrossplay}
            platform={currentPlatform}
            serverRoomCode={onlineRoomCode}
            roomError={roomError}
            onClearError={() => setRoomError(null)}
          />
        )}

        {currentView === 'DIVISIONS' && (
          <DivisionsView
            profile={profile}
            onNavigate={(view) => setCurrentView(view)}
          />
        )}

        {currentView === 'TUTORIAL' && (
          <TutorialAcademy
            profile={profile}
            onCompleteTutorial={handleCompleteTutorial}
            onExit={() => setCurrentView('HUB')}
          />
        )}

        {currentView === 'NEWS' && (
          <NewsView
            isAdminUser={isAdminUser}
            userEmail={user.email || undefined}
            userUid={user.uid}
            onNavigate={(view) => setCurrentView(view)}
          />
        )}
      </main>

      {/* Broadcast Footer */}
      <footer className="border-t-4 border-black py-4 px-6 bg-white text-black text-xs font-mono flex flex-col sm:flex-row items-center justify-between gap-3 max-w-6xl mx-auto w-full mb-20 lg:mb-4 shadow-brutal-yellow">
        <div className="flex items-center gap-2">
          <span className="font-broadcast text-2xl font-black italic tracking-wider text-black">
            PFA <span className="bg-[#ffe500] px-1 border border-black">27</span>
          </span>
          <span className="font-bold">· FIGHTER PASSPORT: {user.email}</span>
        </div>
        <div className="flex items-center gap-4 text-neutral-700 font-bold">
          <span className="flex items-center gap-1">
            <span>{currentPlatform === 'mobile' ? '📱 MOBILE' : '🖥️ DESKTOP'}</span>
            <span>•</span>
            <span
              className={
                crossplaySetting === 'CROSSPLAY_ENABLED' ? 'text-emerald-700' : 'text-blue-700'
              }
            >
              {crossplaySetting === 'CROSSPLAY_ENABLED' ? 'CROSSPLAY ON' : 'SOLO PLATFORM'}
            </span>
          </span>
          <span>·</span>
          <span>SEASON 2027</span>
        </div>
      </footer>

      {/* Mobile Navigation Sticky Dock */}
      <MobileNavDock
        currentView={currentView}
        onNavigate={(view) => setCurrentView(view)}
        onOpenBotLab={() => setIsBotLabOpen(true)}
        platform={currentPlatform}
      />

      {/* Admin Developer Console Modal (strictly verified admin claim only) */}
      {isAdminModalOpen && isAdminUser && (
        <AdminPanelModal onClose={() => setIsAdminModalOpen(false)} />
      )}

      {/* AI Bot Sparring Lab Modal */}
      <BotLabModal
        isOpen={isBotLabOpen}
        onClose={() => setIsBotLabOpen(false)}
        profile={profile}
        onStartBotMatch={handleStartBotBattle}
      />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainAppContent />
    </AuthProvider>
  );
}
