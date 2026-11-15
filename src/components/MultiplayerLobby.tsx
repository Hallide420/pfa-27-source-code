/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { PlayerProfile } from '../types/game';
import { DIVISIONS, PENS_CATALOG } from '../data/initialData';
import { sounds } from '../utils/audio';
import { Wifi, WifiOff, Copy, Check, ArrowRight, Globe, RefreshCw, ShieldAlert, UserCheck, X, Loader2 } from 'lucide-react';
import { triggerHaptic, detectDevicePlatform } from '../utils/device';
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { auth, db } from '../firebase/config';

interface PublicRoomItem {
  code: string;
  hostName: string;
  hostPen: string;
  hostPlatform: 'mobile' | 'desktop';
  crossplay: boolean;
}

interface MultiplayerLobbyProps {
  profile: PlayerProfile;
  onCreateRoom: () => void;
  onJoinRoom: (roomCode: string) => void;
  onJoinQueue: () => void;
  onLeaveQueue: () => void;
  isSearchingQueue?: boolean;
  queueMessage?: string | null;
  crossplaySetting?: 'CROSSPLAY_ENABLED' | 'SAME_PLATFORM_ONLY';
  onToggleCrossplay?: () => void;
  platform?: 'mobile' | 'desktop';
  serverRoomCode?: string | null;
  roomError?: string | null;
  onClearError?: () => void;
}

export const MultiplayerLobby: React.FC<MultiplayerLobbyProps> = ({
  profile,
  onCreateRoom,
  onJoinRoom,
  onJoinQueue,
  onLeaveQueue,
  isSearchingQueue = false,
  queueMessage = null,
  crossplaySetting = 'CROSSPLAY_ENABLED',
  onToggleCrossplay,
  platform = detectDevicePlatform(),
  serverRoomCode = null,
  roomError = null,
  onClearError,
}) => {
  const [roomCodeInput, setRoomCodeInput] = useState<string>('');
  const [isCreatingRoom, setIsCreatingRoom] = useState<boolean>(false);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'ROOMS' | 'RANKINGS'>('ROOMS');
  const [connectionStatus, setConnectionStatus] = useState<'CONNECTING' | 'CONNECTED' | 'OFFLINE'>('CONNECTING');
  const [publicRooms, setPublicRooms] = useState<PublicRoomItem[]>([]);
  const [isLoadingRooms, setIsLoadingRooms] = useState<boolean>(false);

  // Stop pending spinner once server returns canonical room code or error
  useEffect(() => {
    if (serverRoomCode || roomError) {
      setIsCreatingRoom(false);
    }
  }, [serverRoomCode, roomError]);

  const fetchRooms = () => {
    setIsLoadingRooms(true);
    fetch('/api/rooms')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { rooms?: PublicRoomItem[] }) => {
        if (Array.isArray(data.rooms)) setPublicRooms(data.rooms);
        setConnectionStatus('CONNECTED');
      })
      .catch(() => {
        setConnectionStatus('OFFLINE');
      })
      .finally(() => setIsLoadingRooms(false));
  };

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(() => setConnectionStatus('CONNECTED'))
      .catch(() => setConnectionStatus('OFFLINE'));

    fetchRooms();
    const interval = setInterval(fetchRooms, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleCreateRoomClick = () => {
    sounds.playClick();
    onClearError?.();
    setIsCreatingRoom(true);
    onCreateRoom();
  };

  const handleJoinWithCode = () => {
    sounds.playClick();
    onClearError?.();
    const code = roomCodeInput.trim().toUpperCase();
    if (code.length >= 4) {
      onJoinRoom(code);
    }
  };

  const handleCopyCode = () => {
    if (!serverRoomCode) return;
    navigator.clipboard.writeText(serverRoomCode);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  interface LeaderboardPlayer {
    id: string;
    rank: number;
    name: string;
    division: number;
    points: number;
    penName: string;
    badge: string;
    isCurrentUser: boolean;
    isAdmin: boolean;
    totalWins: number;
    winStreak: number;
  }

  const [realLeaderboard, setRealLeaderboard] = useState<LeaderboardPlayer[]>([]);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    const loadRealHumanRankings = async () => {
      setIsLoadingLeaderboard(true);
      try {
        const lbQuery = query(
          collection(db, 'leaderboard'),
          orderBy('division', 'asc'),
          limit(50)
        );
        const lbSnap = await getDocs(lbQuery);
        const currentUid = auth.currentUser?.uid;
        const list: LeaderboardPlayer[] = [];

        lbSnap.forEach((docSnap) => {
          const data = docSnap.data();
          const penDef = PENS_CATALOG.find((p) => p.id === data.equippedPenId) || PENS_CATALOG[0];
          const isUser = Boolean(
            (currentUid && (docSnap.id === currentUid || data.userId === currentUid)) ||
              data.username === profile.username
          );
          const pts =
            (10 - (Number(data.division) || 10)) * 250 +
            (Number(data.divisionPoints) || 0) +
            (Number(data.totalWins) || 0) * 15;

          list.push({
            id: docSnap.id,
            rank: 0,
            name: isUser ? `${data.username || profile.username} (You)` : String(data.username || 'Fighter'),
            division: Number(data.division) || 10,
            points: pts,
            penName: penDef.name,
            badge: data.isAdmin ? '👑' : Number(data.division) === 1 ? '🥇' : Number(data.division) <= 3 ? '🥈' : '🎮',
            isCurrentUser: isUser,
            isAdmin: Boolean(data.isAdmin),
            totalWins: Number(data.totalWins) || 0,
            winStreak: Number(data.winStreak) || 0,
          });
        });

        list.sort((a, b) => {
          if (a.division !== b.division) return a.division - b.division;
          return b.points - a.points;
        });

        list.forEach((p, idx) => {
          p.rank = idx + 1;
        });

        if (!list.some((p) => p.isCurrentUser)) {
          const myPen = PENS_CATALOG.find((p) => p.id === profile.equippedPenId) || PENS_CATALOG[0];
          const myPts = (10 - profile.division) * 250 + profile.divisionPoints + profile.totalWins * 15;
          list.push({
            id: currentUid || 'local_user',
            rank: list.length + 1,
            name: `${profile.username} (You)`,
            division: profile.division,
            points: myPts,
            penName: myPen.name,
            badge: profile.isAdmin ? '👑' : '🎮',
            isCurrentUser: true,
            isAdmin: Boolean(profile.isAdmin),
            totalWins: profile.totalWins,
            winStreak: profile.winStreak,
          });
        }

        if (isMounted) {
          setRealLeaderboard(list);
        }
      } catch (err) {
        console.warn('Leaderboard query notice:', err);
        if (isMounted) {
          const myPen = PENS_CATALOG.find((p) => p.id === profile.equippedPenId) || PENS_CATALOG[0];
          const myPts = (10 - profile.division) * 250 + profile.divisionPoints + profile.totalWins * 15;
          setRealLeaderboard([
            {
              id: auth.currentUser?.uid || 'current_user',
              rank: 1,
              name: `${profile.username} (You)`,
              division: profile.division,
              points: myPts,
              penName: myPen.name,
              badge: profile.isAdmin ? '👑' : '🎮',
              isCurrentUser: true,
              isAdmin: Boolean(profile.isAdmin),
              totalWins: profile.totalWins,
              winStreak: profile.winStreak,
            },
          ]);
        }
      } finally {
        if (isMounted) setIsLoadingLeaderboard(false);
      }
    };

    loadRealHumanRankings();
    return () => {
      isMounted = false;
    };
  }, [profile]);

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-6 font-sans">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 bg-white border-4 border-black p-6 shadow-brutal-yellow">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="bg-[#ffe500] text-black font-mono font-black text-xs px-2 py-0.5 border border-black uppercase tracking-wider">
              ONLINE MULTIPLAYER CIRCUIT
            </span>
            <span
              className={`inline-flex items-center gap-1 font-mono text-xs font-black px-2 py-0.5 border border-black uppercase ${
                connectionStatus === 'CONNECTED'
                  ? 'bg-emerald-100 text-emerald-900'
                  : connectionStatus === 'CONNECTING'
                  ? 'bg-amber-100 text-amber-900'
                  : 'bg-red-100 text-red-900'
              }`}
            >
              {connectionStatus === 'OFFLINE' ? (
                <WifiOff className="w-3.5 h-3.5 text-red-600" />
              ) : (
                <Wifi className="w-3.5 h-3.5 text-emerald-600" />
              )}
              <span>SERVER: {connectionStatus}</span>
            </span>
          </div>
          <h2 className="font-broadcast text-4xl sm:text-5xl font-black italic tracking-wide text-black mt-2 leading-none">
            MATCHMAKING &amp; RANKINGS
          </h2>
          <p className="text-neutral-700 font-mono text-xs sm:text-sm mt-2">
            Real-time server matchmaking queue, server-minted duel room codes, and live leaderboard standings.
          </p>
        </div>

        {/* Tab switch */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              sounds.playClick();
              setActiveTab('ROOMS');
            }}
            className={`px-4 py-2 font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black transition-all cursor-pointer ${
              activeTab === 'ROOMS'
                ? 'bg-[#ffe500] text-black shadow-brutal-black -translate-x-0.5 -translate-y-0.5'
                : 'bg-white text-black hover:bg-neutral-100'
            }`}
          >
            Live Match Rooms
          </button>
          <button
            onClick={() => {
              sounds.playClick();
              setActiveTab('RANKINGS');
            }}
            className={`px-4 py-2 font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black transition-all cursor-pointer ${
              activeTab === 'RANKINGS'
                ? 'bg-[#ffe500] text-black shadow-brutal-black -translate-x-0.5 -translate-y-0.5'
                : 'bg-white text-black hover:bg-neutral-100'
            }`}
          >
            Division Ladder
          </button>
        </div>
      </div>

      {activeTab === 'ROOMS' ? (
        <div className="space-y-6">
          {/* Crossplay Configuration Banner Card */}
          <div className="bg-[#0e121b] border-4 border-white p-4 sm:p-5 text-white flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-brutal-yellow">
            <div className="flex items-start sm:items-center gap-3">
              <div className="w-12 h-12 bg-[#ffe500] text-black border-2 border-black flex items-center justify-center text-2xl shadow-brutal-black shrink-0">
                {platform === 'mobile' ? '📱' : '🖥️'}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] font-black uppercase text-[#ffe500] bg-black px-1.5 py-0.5 border border-white/20">
                    YOUR DEVICE: {platform.toUpperCase()}
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    ENGINE MATCHMAKING
                  </span>
                </div>
                <h3 className="font-broadcast text-2xl sm:text-3xl font-black italic uppercase text-white mt-0.5">
                  {crossplaySetting === 'CROSSPLAY_ENABLED'
                    ? 'CROSSPLAY: ON (PC + MOBILE)'
                    : 'CROSSPLAY: OFF (SAME PLATFORM ONLY)'}
                </h3>
                <p className="text-xs text-slate-300 font-mono mt-1">
                  {crossplaySetting === 'CROSSPLAY_ENABLED'
                    ? 'Play seamlessly with and against competitors on both Mobile and PC.'
                    : `Strict isolation: Duel only against fellow ${platform.toUpperCase()} flickers.`}
                </p>
              </div>
            </div>

            <button
              onClick={() => {
                sounds.playClick();
                triggerHaptic('medium');
                onToggleCrossplay?.();
              }}
              className={`px-4 sm:px-5 py-3 font-broadcast font-black text-xs sm:text-sm uppercase tracking-wider border-2 border-black cursor-pointer shadow-brutal-white active:scale-95 transition-all shrink-0 whitespace-nowrap ${
                crossplaySetting === 'CROSSPLAY_ENABLED'
                  ? 'bg-[#ffe500] text-black hover:bg-[#ecd400]'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
            >
              SWITCH TO {crossplaySetting === 'CROSSPLAY_ENABLED' ? 'SAME PLATFORM ONLY' : 'CROSSPLAY ENABLED'}
            </button>
          </div>

          {roomError && (
            <div className="p-3 bg-red-100 border-3 border-red-600 text-red-900 font-mono text-xs font-bold flex items-center justify-between gap-2 shadow-brutal-black">
              <span>{roomError}</span>
              {onClearError && (
                <button
                  onClick={onClearError}
                  className="px-2.5 py-1 bg-red-600 text-white text-[10px] font-black uppercase cursor-pointer"
                >
                  DISMISS
                </button>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Quick Ranked Matchmaking Queue Card */}
            <div className="p-6 bg-white border-4 border-black shadow-brutal-yellow flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between border-b-2 border-black pb-2 mb-4">
                  <span className="bg-[#ffe500] text-black font-mono font-black text-xs px-2 py-0.5 border border-black uppercase tracking-wider">
                    COMPETITIVE QUEUE
                  </span>
                  <span className="flex items-center gap-1 font-mono text-xs font-bold text-neutral-700">
                    <Wifi className={`w-4 h-4 ${connectionStatus === 'OFFLINE' ? 'text-red-600' : 'text-emerald-600'}`} />
                    {connectionStatus}
                  </span>
                </div>
                <h3 className="font-broadcast text-4xl sm:text-5xl font-black italic text-black mb-2 leading-none">
                  DIVISION RANKED DUEL
                </h3>
                <p className="font-mono text-xs text-neutral-600 mb-6">
                  Enter the real-time server queue to pair with the next online opponent near Division {profile.division}. Earn +35 Paperclips and +25 Division Points per win.
                </p>

                <div className="border-2 border-black p-4 bg-neutral-50 space-y-2 mb-6 font-mono">
                  <div className="flex justify-between text-xs font-bold text-neutral-800">
                    <span>CURRENT DIVISION</span>
                    <span className="font-black text-black">DIVISION {profile.division}</span>
                  </div>
                  <div className="flex justify-between text-xs font-bold text-neutral-800">
                    <span>PROMOTION POINTS</span>
                    <span className="font-black text-black tabular-nums">
                      {profile.divisionPoints}/100 PTS
                    </span>
                  </div>
                  <div className="w-full bg-neutral-200 border border-black h-3 overflow-hidden mt-2">
                    <div
                      className="bg-[#ffe500] border-r border-black h-full"
                      style={{ width: `${profile.divisionPoints}%` }}
                    />
                  </div>
                </div>
              </div>

              {isSearchingQueue ? (
                <div className="space-y-3">
                  <div className="p-3 bg-black text-[#ffe500] border-2 border-black font-mono text-xs font-black flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{queueMessage || 'SEARCHING FOR RANKED OPPONENT...'}</span>
                  </div>
                  <button
                    onClick={() => {
                      sounds.playClick();
                      onLeaveQueue();
                    }}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-red-600 hover:bg-red-700 text-white font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black shadow-brutal-black cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                    CANCEL QUEUE SEARCH
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    sounds.playClick();
                    onClearError?.();
                    onJoinQueue();
                  }}
                  disabled={connectionStatus === 'OFFLINE'}
                  className="w-full flex items-center justify-center gap-2 py-4 bg-[#ffe500] hover:bg-[#f2d700] text-black font-broadcast font-black text-xl uppercase tracking-wider border-3 border-black shadow-brutal-black hover:translate-x-0.5 hover:translate-y-0.5 transition-all cursor-pointer active:scale-95 disabled:opacity-50"
                >
                  SEARCH RANKED OPPONENT
                  <ArrowRight className="w-5 h-5" />
                </button>
              )}
            </div>

            {/* Private Room Codes Card */}
            <div className="p-6 bg-white border-4 border-black shadow-brutal-black flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between border-b-2 border-black pb-2 mb-4">
                  <span className="bg-black text-[#ffe500] font-mono font-black text-xs px-2 py-0.5 uppercase tracking-wider">
                    CUSTOM MATCHMAKING
                  </span>
                  <span className="font-mono text-xs font-bold text-neutral-500">
                    HOST-AUTHORITATIVE
                  </span>
                </div>
                <h3 className="font-broadcast text-4xl sm:text-5xl font-black italic text-black mb-2 leading-none">
                  PRIVATE ROOM CODES
                </h3>
                <p className="font-mono text-xs text-neutral-600 mb-6">
                  Request a canonical 5-character room code from the server or enter a friend&apos;s code to flick immediately.
                </p>

                {/* Host a Room */}
                <div className="mb-4 p-4 border-2 border-black bg-neutral-50">
                  <div className="font-mono text-xs font-black uppercase text-black mb-2">
                    OPTION A: HOST DUEL ROOM
                  </div>
                  {serverRoomCode ? (
                    <div className="flex items-center justify-between bg-white border-2 border-black p-3 shadow-brutal-black">
                      <div>
                        <div className="font-mono text-[9px] text-neutral-500 font-black uppercase">
                          SERVER ROOM CODE (WAITING FOR OPPONENT)
                        </div>
                        <div className="font-mono text-2xl font-black tracking-widest text-black">
                          {serverRoomCode}
                        </div>
                      </div>
                      <button
                        onClick={handleCopyCode}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ffe500] hover:bg-[#f2d700] text-black font-mono text-xs font-black uppercase border border-black cursor-pointer active:scale-95"
                      >
                        {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{isCopied ? 'COPIED' : 'COPY'}</span>
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleCreateRoomClick}
                      disabled={isCreatingRoom || connectionStatus === 'OFFLINE'}
                      className="w-full py-2.5 bg-black hover:bg-neutral-800 text-white font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black transition-colors cursor-pointer active:scale-95 disabled:opacity-60"
                    >
                      {isCreatingRoom ? 'REQUESTING SERVER CODE...' : 'Generate Room Key'}
                    </button>
                  )}
                </div>

                {/* Join an Existing Room */}
                <div className="p-4 border-2 border-black bg-neutral-50">
                  <div className="font-mono text-xs font-black uppercase text-black mb-2">
                    OPTION B: JOIN ROOM
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="ENTER 5-DIGIT CODE"
                      value={roomCodeInput}
                      onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                      className="flex-1 bg-white border-2 border-black p-2 font-mono text-sm text-black placeholder-neutral-400 uppercase tracking-widest focus:outline-none"
                      maxLength={8}
                    />
                    <button
                      onClick={handleJoinWithCode}
                      disabled={roomCodeInput.trim().length < 4 || connectionStatus === 'OFFLINE'}
                      className="px-5 py-2.5 bg-[#ffe500] hover:bg-[#f2d700] text-black font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black cursor-pointer shadow-brutal-black hover:translate-x-0.5 hover:translate-y-0.5 active:scale-95 disabled:opacity-50"
                    >
                      Join
                    </button>
                  </div>
                </div>
              </div>

              <div className="font-mono text-[10px] text-neutral-500 mt-4 text-center">
                15HZ HOST-AUTHORITATIVE WEBSOCKET SYNCHRONIZATION
              </div>
            </div>
          </div>

          {/* Live Open Rooms Discovery Section */}
          <div className="bg-white border-4 border-black p-5 shadow-brutal-black">
            <div className="flex items-center justify-between pb-3 border-b-2 border-black mb-4">
              <div className="flex items-center gap-2">
                <span className="bg-black text-[#ffe500] font-mono font-black text-xs px-2 py-0.5 uppercase tracking-wider">
                  LIVE ROOM DISCOVERY
                </span>
                <span className="font-mono text-xs font-bold text-neutral-600">
                  {publicRooms.length} ACTIVE LOBBIES
                </span>
              </div>
              <button
                onClick={() => {
                  triggerHaptic('light');
                  sounds.playClick();
                  fetchRooms();
                }}
                disabled={isLoadingRooms}
                className="flex items-center gap-1.5 px-3 py-1 bg-neutral-100 hover:bg-neutral-200 border border-black font-mono text-xs font-bold uppercase cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingRooms ? 'animate-spin' : ''}`} />
                <span>REFRESH</span>
              </button>
            </div>

            {publicRooms.length === 0 ? (
              <div className="p-8 text-center bg-neutral-50 border-2 border-dashed border-neutral-300">
                <p className="font-mono text-xs text-neutral-500 uppercase tracking-widest">
                  NO OPEN LOBBIES RIGHT NOW · HIT &quot;GENERATE ROOM KEY&quot; ABOVE TO HOST A MATCH!
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {publicRooms.map((r) => {
                  const isCompatible = r.crossplay || r.hostPlatform === platform;
                  return (
                    <div
                      key={r.code}
                      className="p-3 border-2 border-black bg-neutral-50 flex items-center justify-between shadow-sm hover:shadow-brutal-black transition-all"
                    >
                      <div>
                        <div className="flex items-center gap-1.5 font-mono text-[10px] font-bold text-neutral-600">
                          <span>{r.hostPlatform === 'mobile' ? '📱 Mobile' : '🖥️ PC'}</span>
                          <span>•</span>
                          <span className={r.crossplay ? 'text-emerald-700' : 'text-blue-700'}>
                            {r.crossplay ? 'Crossplay' : 'Solo Platform'}
                          </span>
                        </div>
                        <div className="font-broadcast text-base font-black uppercase text-black mt-0.5">
                          {r.hostName}
                        </div>
                        <div className="font-mono text-xs text-neutral-500">
                          CODE: <strong className="text-black">{r.code}</strong>
                        </div>
                      </div>

                      <button
                        onClick={() => {
                          sounds.playClick();
                          triggerHaptic('light');
                          onClearError?.();
                          onJoinRoom(r.code);
                        }}
                        disabled={!isCompatible || r.code === serverRoomCode}
                        className={`px-3 py-1.5 font-broadcast font-black text-xs uppercase tracking-wider border-2 border-black cursor-pointer shadow-brutal-black ${
                          isCompatible && r.code !== serverRoomCode
                            ? 'bg-[#ffe500] hover:bg-[#ecd400] text-black active:scale-95'
                            : 'bg-neutral-200 text-neutral-400 cursor-not-allowed border-neutral-300 shadow-none'
                        }`}
                        title={!isCompatible ? `Host requires ${r.hostPlatform.toUpperCase()} players` : 'Join duel room'}
                      >
                        {r.code === serverRoomCode ? 'HOSTED' : isCompatible ? 'JOIN' : 'LOCKED'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Rankings & Divisions View */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 space-y-2">
            <div className="font-mono text-xs font-black uppercase tracking-wider text-black pb-1">
              PFA SEASON 27 DIVISIONS:
            </div>
            {DIVISIONS.map((div) => {
              const isCurrent = profile.division === div.division;
              return (
                <div
                  key={div.division}
                  className={`p-3.5 border-2 flex items-center justify-between transition-all ${
                    isCurrent
                      ? 'bg-[#ffe500] text-black border-black shadow-brutal-black font-black'
                      : 'bg-white text-black border-black shadow-sm'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{div.rewardBadge}</span>
                    <div>
                      <div className="font-broadcast text-xl font-black italic leading-none">
                        {div.name}
                      </div>
                      <div className="font-mono text-[10px] text-neutral-700 mt-0.5">
                        {div.minRating}+ Rating pts
                      </div>
                    </div>
                  </div>
                  {isCurrent && (
                    <span className="px-2 py-0.5 bg-black text-[#ffe500] font-mono text-[10px] font-black uppercase border border-black">
                      YOU ARE HERE
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="lg:col-span-8 bg-white border-4 border-black p-6 shadow-brutal-yellow">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b-2 border-black mb-4 gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="bg-emerald-600 text-white font-mono font-black text-[10px] px-2 py-0.5 uppercase tracking-wider">
                    VERIFIED HUMAN LADDER
                  </span>
                  <span className="font-mono text-[10px] font-bold text-red-600 uppercase flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3 text-red-600" />
                    AI BOTS DISQUALIFIED
                  </span>
                </div>
                <h3 className="font-broadcast text-3xl font-black italic text-black leading-none mt-1">
                  GLOBAL DESK CHAMPIONSHIP LADDER
                </h3>
              </div>
              <Globe className="w-6 h-6 text-black" />
            </div>

            <div className="bg-[#ffe500] text-black px-3 py-1.5 border-2 border-black font-mono text-[11px] font-black uppercase mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <UserCheck className="w-3.5 h-3.5" />
                <span>FAIR PLAY REGULATIONS: 100% BOT-FREE COMPETITIVE CIRCUIT</span>
              </span>
            </div>

            <div className="space-y-2">
              {isLoadingLeaderboard ? (
                <div className="p-8 text-center font-mono text-xs text-neutral-500 uppercase tracking-widest bg-neutral-50 border-2 border-dashed border-neutral-300">
                  SYNCING LIVE HUMAN FIGHTER CREDENTIALS...
                </div>
              ) : (
                realLeaderboard.map((entry) => (
                  <div
                    key={entry.id}
                    className={`p-3 border-2 flex items-center justify-between transition-all ${
                      entry.isCurrentUser
                        ? 'bg-[#ffe500] border-black shadow-brutal-black font-black'
                        : 'bg-neutral-50 border-black hover:bg-neutral-100'
                    }`}
                  >
                    <div className="flex items-center gap-3 sm:gap-4">
                      <span className="font-broadcast text-2xl text-black w-8 text-center tabular-nums font-black italic">
                        #{entry.rank}
                      </span>
                      <span className="text-xl">{entry.badge}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-broadcast text-xl font-black italic text-black leading-none">
                            {entry.name}
                          </span>
                          {entry.isAdmin && (
                            <span className="bg-red-600 text-white font-mono text-[9px] font-black uppercase px-1 py-0.2 border border-black">
                              ADMIN
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-neutral-600 mt-0.5">
                          {entry.penName} · Div {entry.division} · {entry.totalWins}W ({entry.winStreak} Streak)
                        </div>
                      </div>
                    </div>

                    <span className="font-mono text-sm font-black text-black tabular-nums border border-black bg-white px-2 py-0.5 shadow-sm">
                      {entry.points} PTS
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
