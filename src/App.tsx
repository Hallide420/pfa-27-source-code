/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  GameView,
  PlayerProfile,
  Tournament,
  TournamentMatch,
  BotDifficulty,
  MatchMode,
  OnlineFlickPayload,
  OnlineMatchSyncState,
} from './types/game';
import { awardMatchWin } from './utils/storage';
import { sounds } from './utils/audio';
import { BOT_DIFFICULTIES } from './data/initialData';
import { AuthProvider, useAuth } from './firebase/AuthContext';
import { SignInGate } from './components/SignInGate';
import { Navbar } from './components/Navbar';
import { MobileNavDock } from './components/MobileNavDock';
import { HubDashboard } from './components/HubDashboard';
import { DeskArena } from './components/DeskArena';
import { TournamentBracketView } from './components/TournamentBracketView';
import { GeometryBoxStore } from './components/GeometryBoxStore';
import { PenLocker } from './components/PenLocker';
import { MultiplayerLobby } from './components/MultiplayerLobby';
import { AdminPanelModal } from './components/AdminPanelModal';
import { BotLabModal } from './components/BotLabModal';
import { TutorialAcademy } from './components/TutorialAcademy';
import { NewsView } from './components/NewsView';
import { detectDevicePlatform } from './utils/device';

function MainAppContent() {
  const {
    user,
    profile,
    loading,
    signOutUser,
    updateProfileData,
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

  // Match setup state
  const [matchMode, setMatchMode] = useState<MatchMode>('RANKED');
  const [activeOpponentName, setActiveOpponentName] = useState<string>('ApexStriker_X');
  const [activeOpponentAvatar, setActiveOpponentAvatar] = useState<string>('🎯');
  const [activeOpponentPlatform, setActiveOpponentPlatform] = useState<'mobile' | 'desktop'>('desktop');
  const [currentActiveTournament, setCurrentActiveTournament] = useState<Tournament | null>(null);
  const [currentActiveMatch, setCurrentActiveMatch] = useState<TournamentMatch | null>(null);

  // Platform and crossplay preferences
  const currentPlatform: 'mobile' | 'desktop' = profile?.platform || detectDevicePlatform();
  const crossplaySetting = profile?.crossplaySetting || 'CROSSPLAY_ENABLED';

  const handleToggleCrossplay = () => {
    updateProfileData((prev) => ({
      ...prev,
      crossplaySetting: prev.crossplaySetting === 'CROSSPLAY_ENABLED' ? 'SAME_PLATFORM_ONLY' : 'CROSSPLAY_ENABLED',
    }));
  };

  // Online WebSocket state
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const intentionalCloseRef = useRef<boolean>(false);
  const onlineSessionRef = useRef<{ roomCode: string; sessionToken: string } | null>(null);
  const turnSeqRef = useRef<number>(0);

  const [incomingOnlineFlick, setIncomingOnlineFlick] = useState<OnlineFlickPayload | null>(null);
  const [onlineSyncSnapshot, setOnlineSyncSnapshot] = useState<OnlineMatchSyncState | null>(null);
  const [onlineTurnSeq, setOnlineTurnSeq] = useState<number>(0);
  const [onlineRole, setOnlineRole] = useState<'player1' | 'player2'>('player1');
  const [activeOpponentPenId, setActiveOpponentPenId] = useState<string | undefined>(undefined);
  const [onlineRoomCode, setOnlineRoomCode] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [onlineConnectionStatus, setOnlineConnectionStatus] = useState<'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED'>('CONNECTED');
  const [opponentConnectionStatus, setOpponentConnectionStatus] = useState<'ONLINE' | 'RECONNECTING' | 'LEFT'>('ONLINE');
  const [opponentGraceSeconds, setOpponentGraceSeconds] = useState<number>(30);
  const [onlineNotice, setOnlineNotice] = useState<string | null>(null);
  const [forfeitWinner, setForfeitWinner] = useState<'player1' | 'player2' | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [rematchState, setRematchState] = useState<{
    requestedByMe: boolean;
    requestedByOpponent: boolean;
    triggerCounter: number;
  }>({ requestedByMe: false, requestedByOpponent: false, triggerCounter: 0 });

  const saveOnlineSession = (roomCode: string, sessionToken: string) => {
    onlineSessionRef.current = { roomCode, sessionToken };
    try {
      sessionStorage.setItem('pfa27_online_session', JSON.stringify({ roomCode, sessionToken }));
    } catch {}
  };

  const clearOnlineSession = () => {
    onlineSessionRef.current = null;
    try {
      sessionStorage.removeItem('pfa27_online_session');
    } catch {}
  };

  // Grace period countdown UI ticker
  useEffect(() => {
    if (opponentConnectionStatus !== 'RECONNECTING') return;
    const timer = setInterval(() => {
      setOpponentGraceSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [opponentConnectionStatus]);

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

  // Handle WebSocket connection + auto-reconnect
  const initWebSocket = useCallback((isReconnectAttempt: boolean = false) => {
    if (
      !isReconnectAttempt &&
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)
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
        const msg = JSON.parse(event.data);

        switch (msg.type) {
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
            setOnlineRoomCode(msg.roomCode);
            setOnlineRole('player1');
            setRoomError(null);
            if (msg.sessionToken) {
              saveOnlineSession(msg.roomCode, msg.sessionToken);
            }
            break;
          }

          case 'OPPONENT_JOINED': {
            turnSeqRef.current = msg.turnSeq ?? 0;
            setOnlineTurnSeq(turnSeqRef.current);
            setOnlineRole('player1');
            setActiveOpponentName(msg.opponentName || 'Online Rival');
            setActiveOpponentAvatar('⚡');
            setActiveOpponentPenId(msg.opponentPen);
            if (msg.opponentPlatform) setActiveOpponentPlatform(msg.opponentPlatform);
            setOpponentConnectionStatus('ONLINE');
            setForfeitWinner(null);
            setOnlineSyncSnapshot(null);
            setIncomingOnlineFlick(null);
            setOnlineNotice(null);
            setRematchState({ requestedByMe: false, requestedByOpponent: false, triggerCounter: 0 });
            setMatchMode('ONLINE_ROOM');
            setCurrentView('MATCH');
            break;
          }

          case 'ROOM_JOINED': {
            turnSeqRef.current = msg.turnSeq ?? 0;
            setOnlineTurnSeq(turnSeqRef.current);
            setOnlineRole('player2');
            setOnlineRoomCode(msg.roomCode);
            if (msg.sessionToken) {
              saveOnlineSession(msg.roomCode, msg.sessionToken);
            }
            setActiveOpponentName(msg.opponentName || 'Room Host');
            setActiveOpponentAvatar('👑');
            setActiveOpponentPenId(msg.opponentPen);
            if (msg.opponentPlatform) setActiveOpponentPlatform(msg.opponentPlatform);
            setOpponentConnectionStatus('ONLINE');
            setForfeitWinner(null);
            setOnlineSyncSnapshot(null);
            setIncomingOnlineFlick(null);
            setOnlineNotice(null);
            setRematchState({ requestedByMe: false, requestedByOpponent: false, triggerCounter: 0 });
            setMatchMode('ONLINE_ROOM');
            setCurrentView('MATCH');
            break;
          }

          case 'ROOM_RECONNECTED': {
            turnSeqRef.current = msg.turnSeq ?? 0;
            setOnlineTurnSeq(turnSeqRef.current);
            setOnlineRole(msg.role === 'player2' ? 'player2' : 'player1');
            setOnlineRoomCode(msg.roomCode);
            setActiveOpponentName(msg.opponentName || 'Online Rival');
            setActiveOpponentPenId(msg.opponentPen);
            if (msg.opponentPlatform) setActiveOpponentPlatform(msg.opponentPlatform);
            setOpponentConnectionStatus(msg.opponentConnected ? 'ONLINE' : 'RECONNECTING');
            setOnlineNotice('Reconnected cleanly to live desk.');
            setTimeout(() => setOnlineNotice(null), 3000);
            if (msg.snapshot) {
              setOnlineSyncSnapshot(msg.snapshot);
            }
            setMatchMode('ONLINE_ROOM');
            setCurrentView('MATCH');
            break;
          }

          case 'RECONNECT_FAILED': {
            clearOnlineSession();
            setOnlineConnectionStatus('DISCONNECTED');
            setRoomError(msg.message || 'Session expired.');
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
            setOnlineNotice(msg.message || 'Action rejected by server.');
            setTimeout(() => setOnlineNotice(null), 2500);
            if (typeof msg.turnSeq === 'number') {
              turnSeqRef.current = msg.turnSeq;
              setOnlineTurnSeq(msg.turnSeq);
            }
            if (msg.snapshot) {
              setOnlineSyncSnapshot(msg.snapshot);
            }
            break;
          }

          case 'OPPONENT_FLICKED': {
            if (typeof msg.turnSeq === 'number') {
              turnSeqRef.current = msg.turnSeq;
              setOnlineTurnSeq(msg.turnSeq);
            }
            setIncomingOnlineFlick({
              power: msg.power,
              angle: msg.angle,
              curve: msg.curve,
              styleId: msg.flickStyleId,
              actor: msg.actor === 'player1' ? 'player1' : 'player2',
              turnSeq: msg.turnSeq ?? turnSeqRef.current,
            });
            break;
          }

          case 'PEER_STATE_SYNC': {
            if (typeof msg.turnSeq === 'number') {
              turnSeqRef.current = msg.turnSeq;
              setOnlineTurnSeq(msg.turnSeq);
            }
            setOnlineSyncSnapshot({
              pens: msg.pens || [],
              activeTurn: msg.activeTurn === 'player2' ? 'player2' : 'player1',
              roundScore: msg.roundScore || [0, 0],
              currentRound: msg.currentRound || 1,
              turnSeq: msg.turnSeq ?? turnSeqRef.current,
              matchWinner: msg.matchWinner || null,
            });
            break;
          }

          case 'OPPONENT_DISCONNECTED_TEMP': {
            setOpponentConnectionStatus('RECONNECTING');
            setOpponentGraceSeconds(msg.graceSeconds || 30);
            setOnlineNotice(msg.message || 'Opponent lost connection...');
            break;
          }

          case 'OPPONENT_RECONNECTED': {
            setOpponentConnectionStatus('ONLINE');
            setOnlineNotice(msg.message || 'Opponent reconnected!');
            setTimeout(() => setOnlineNotice(null), 3000);
            break;
          }

          case 'OPPONENT_FORFEITED':
          case 'OPPONENT_LEFT': {
            setOpponentConnectionStatus('LEFT');
            setOnlineNotice(msg.message || 'Opponent left the match.');
            if (msg.winner === 'player1' || msg.winner === 'player2') {
              setForfeitWinner(msg.winner);
            }
            clearOnlineSession();
            break;
          }

          case 'REMATCH_REQUESTED': {
            setRematchState((prev) => ({ ...prev, requestedByOpponent: true }));
            break;
          }

          case 'REMATCH_STARTED': {
            turnSeqRef.current = msg.turnSeq ?? 0;
            setOnlineTurnSeq(turnSeqRef.current);
            setOnlineSyncSnapshot(null);
            setIncomingOnlineFlick(null);
            setForfeitWinner(null);
            setRematchState((prev) => ({
              requestedByMe: false,
              requestedByOpponent: false,
              triggerCounter: prev.triggerCounter + 1,
            }));
            break;
          }

          case 'ERROR': {
            setRoomError(msg.message || 'Room connection error.');
            break;
          }

          default:
            break;
        }
      } catch (e) {
        console.error('Socket message parse error', e);
      }
    };

    socket.onclose = () => {
      if (intentionalCloseRef.current) return;

      // Auto-reconnect with exponential backoff if an active online session exists
      if (onlineSessionRef.current && reconnectAttemptsRef.current < 5) {
        setOnlineConnectionStatus('RECONNECTING');
        const delayMs = Math.min(8000, 1000 * Math.pow(2, reconnectAttemptsRef.current));
        reconnectAttemptsRef.current += 1;
        reconnectTimerRef.current = setTimeout(() => {
          initWebSocket(true);
        }, delayMs);
      } else {
        setOnlineConnectionStatus('DISCONNECTED');
      }
    };

    wsRef.current = socket;
    return socket;
  }, []);

  // Attempt auto-recovery if user refreshed mid-match within grace window
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('pfa27_online_session');
      if (saved && profile && !onlineSessionRef.current) {
        const parsed = JSON.parse(saved);
        if (parsed?.roomCode && parsed?.sessionToken) {
          onlineSessionRef.current = parsed;
          initWebSocket(true);
        }
      }
    } catch {}
  }, [profile, initWebSocket]);

  const handleToggleMute = () => {
    const muted = sounds.toggleMute();
    setIsMuted(muted);
  };

  const handleQuickRanked = () => {
    // Ranked Duel: Redirects exclusively to live human multiplayer matchmaking lobby
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
    setCurrentActiveTournament(tournament);
    setCurrentActiveMatch(match);
    setMatchMode('TOURNAMENT');
    const opponent = match.player1.isUser ? match.player2 : match.player1;
    setActiveOpponentName(opponent.name);
    setActiveOpponentAvatar(opponent.avatar);
    setCurrentView('MATCH');
  };

  const handleJoinOnlineRoom = (roomCode: string, isHost: boolean) => {
    if (!profile) return;
    setRoomError(null);
    const socket = initWebSocket(false);
    setOnlineRoomCode(roomCode);

    const checkAndSend = () => {
      if (socket.readyState === WebSocket.OPEN) {
        if (isHost) {
          socket.send(
            JSON.stringify({
              type: 'CREATE_ROOM',
              roomCode,
              playerName: profile.username,
              penId: profile.equippedPenId,
              platform: currentPlatform,
              crossplay: crossplaySetting === 'CROSSPLAY_ENABLED',
            })
          );
        } else {
          socket.send(
            JSON.stringify({
              type: 'JOIN_ROOM',
              roomCode,
              playerName: profile.username,
              penId: profile.equippedPenId,
              platform: currentPlatform,
              crossplay: crossplaySetting === 'CROSSPLAY_ENABLED',
            })
          );
        }
      } else if (socket.readyState === WebSocket.CONNECTING) {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  };

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

  const handleRequestRematchOnline = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setRematchState((prev) => ({ ...prev, requestedByMe: true }));
      wsRef.current.send(JSON.stringify({ type: 'REQUEST_REMATCH' }));
    }
  }, []);

  const handleExitMatch = () => {
    if (matchMode === 'ONLINE_ROOM') {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
      }
      intentionalCloseRef.current = true;
      wsRef.current?.close();
      wsRef.current = null;
      clearOnlineSession();
      setOnlineRoomCode(null);
      setForfeitWinner(null);
      setOnlineSyncSnapshot(null);
      setIncomingOnlineFlick(null);
    }
    setCurrentView('HUB');
  };

  const handleMatchComplete = (winner: 'player1' | 'player2') => {
    if (!profile) return;
    const isVictory = winner === 'player1';
    const isRankedMatch = matchMode === 'ONLINE_ROOM' || matchMode === 'TOURNAMENT';

    // Award XP and Paperclips; strictly isolate Bot Lab and local Pass & Play from Ranked division ladder
    updateProfileData((prev) => {
      const { updatedProfile } = awardMatchWin(
        prev,
        isVictory,
        matchMode === 'TOURNAMENT' ? 80 : matchMode === 'ONLINE_ROOM' ? 35 : 20,
        isRankedMatch
      );
      return updatedProfile;
    });

    if (isVictory) {
      sounds.playPaperclipReward();
    }

    if (matchMode === 'TOURNAMENT' && currentActiveTournament && currentActiveMatch) {
      const tourney = { ...currentActiveTournament };
      const matchIndex = tourney.matches.findIndex((m) => m.id === currentActiveMatch.id);
      if (matchIndex !== -1) {
        tourney.matches[matchIndex].status = 'COMPLETED';
        tourney.matches[matchIndex].winner = isVictory ? 1 : 2;
        tourney.matches[matchIndex].score = isVictory ? [2, 0] : [0, 2];

        if (isVictory && tourney.currentRound < 3) {
          tourney.currentRound += 1;
        }
      }
      setCurrentActiveTournament(tourney);
    }
  };

  const handleEquipNow = (penId: string, skinId: string) => {
    updateProfileData((prev) => ({
      ...prev,
      equippedPenId: penId,
      equippedSkinId: skinId,
    }));
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

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] bg-graph-paper flex flex-col items-center justify-center text-white font-sans p-4">
        <div className="w-16 h-16 border-4 border-black border-t-[#ffe500] animate-spin mb-6 bg-white shadow-brutal-yellow" />
        <span className="font-broadcast text-4xl sm:text-5xl font-black italic tracking-wide text-white">
          PFA <span className="bg-[#ffe500] text-black px-2 py-0.5 border-2 border-black inline-block -rotate-1 shadow-brutal-white">27</span>
        </span>
        <p className="font-mono text-xs uppercase tracking-widest text-[#ffe500] mt-3">
          VERIFYING FIGHTER CREDENTIALS & SESSIONS...
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
        onSignOut={signOutUser}
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
            onEquipPen={(penId) =>
              updateProfileData((p) => ({ ...p, equippedPenId: penId }))
            }
            onSendFlick={handleSendFlickOnline}
            onSendSyncState={handleSendSyncStateOnline}
            onRequestRematch={handleRequestRematchOnline}
            incomingOnlineFlick={incomingOnlineFlick}
            onlineSyncSnapshot={onlineSyncSnapshot}
            onlineTurnSeq={onlineTurnSeq}
            onlineConnectionStatus={onlineConnectionStatus}
            opponentConnectionStatus={opponentConnectionStatus}
            opponentGraceSeconds={opponentGraceSeconds}
            onlineNotice={onlineNotice}
            forfeitWinner={forfeitWinner}
            latencyMs={latencyMs}
            rematchState={rematchState}
            isAdminUser={isAdminUser}
            godModePower={isAdminUser ? godModePower : 1.0}
            playerPlatform={currentPlatform}
            opponentPlatform={activeOpponentPlatform}
            crossplay={crossplaySetting === 'CROSSPLAY_ENABLED'}
          />
        )}

        {currentView === 'TOURNAMENT' && (
          <TournamentBracketView
            profile={profile}
            isAdminUser={isAdminUser}
            onStartTournamentMatch={handleStartTournamentMatch}
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
            onEquipPen={(penId) =>
              updateProfileData((p) => ({ ...p, equippedPenId: penId }))
            }
            onEquipSkin={(skinId) =>
              updateProfileData((p) => ({ ...p, equippedSkinId: skinId }))
            }
            onEquipFlickStyle={(styleId) =>
              updateProfileData((p) => ({ ...p, equippedFlickStyleId: styleId }))
            }
          />
        )}

        {currentView === 'MULTIPLAYER' && (
          <MultiplayerLobby
            profile={profile}
            onJoinRoom={handleJoinOnlineRoom}
            onStartRankedMatch={handleQuickRanked}
            crossplaySetting={crossplaySetting}
            onToggleCrossplay={handleToggleCrossplay}
            platform={currentPlatform}
            serverRoomCode={onlineRoomCode}
            roomError={roomError}
            onClearError={() => setRoomError(null)}
          />
        )}

        {currentView === 'DIVISIONS' && (
          <MultiplayerLobby
            profile={profile}
            onJoinRoom={handleJoinOnlineRoom}
            onStartRankedMatch={handleQuickRanked}
            crossplaySetting={crossplaySetting}
            onToggleCrossplay={handleToggleCrossplay}
            platform={currentPlatform}
            serverRoomCode={onlineRoomCode}
            roomError={roomError}
            onClearError={() => setRoomError(null)}
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
            <span className={crossplaySetting === 'CROSSPLAY_ENABLED' ? 'text-emerald-700' : 'text-blue-700'}>
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

      {/* Admin Developer Console Modal (strictly verified admin only) */}
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
