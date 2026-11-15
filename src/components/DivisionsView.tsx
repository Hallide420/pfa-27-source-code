/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { GameView, PlayerProfile } from '../types/game';
import { DIVISIONS, PENS_CATALOG } from '../data/initialData';
import { sounds } from '../utils/audio';
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { auth, db } from '../firebase/config';
import { Trophy, ArrowRight, ShieldAlert, TrendingUp, Award } from 'lucide-react';

interface DivisionsViewProps {
  profile: PlayerProfile;
  onNavigate: (view: GameView) => void;
}

interface LadderStanding {
  id: string;
  rank: number;
  username: string;
  division: number;
  divisionPoints: number;
  totalWins: number;
  winStreak: number;
  penName: string;
  isCurrentUser: boolean;
  isAdmin: boolean;
}

export const DivisionsView: React.FC<DivisionsViewProps> = ({ profile, onNavigate }) => {
  const [standings, setStandings] = useState<LadderStanding[]>([]);
  const [loadingStandings, setLoadingStandings] = useState<boolean>(true);

  const currentDivisionInfo =
    DIVISIONS.find((d) => d.division === profile.division) || DIVISIONS[DIVISIONS.length - 1];
  const nextDivisionInfo = DIVISIONS.find((d) => d.division === profile.division - 1) || null;
  const computedRating =
    (10 - profile.division) * 250 + profile.divisionPoints + profile.totalWins * 15;

  useEffect(() => {
    let active = true;
    const loadStandings = async () => {
      setLoadingStandings(true);
      try {
        const q = query(collection(db, 'leaderboard'), orderBy('division', 'asc'), limit(25));
        const snap = await getDocs(q);
        const currentUid = auth.currentUser?.uid;
        const rows: LadderStanding[] = [];

        snap.forEach((docSnap) => {
          const data = docSnap.data();
          const penDef = PENS_CATALOG.find((p) => p.id === data.equippedPenId) || PENS_CATALOG[0];
          const isMe = Boolean(
            (currentUid && (docSnap.id === currentUid || data.userId === currentUid)) ||
              data.username === profile.username
          );
          rows.push({
            id: docSnap.id,
            rank: 0,
            username: isMe ? `${data.username || profile.username} (You)` : String(data.username || 'Fighter'),
            division: Number(data.division) || 10,
            divisionPoints: Number(data.divisionPoints) || 0,
            totalWins: Number(data.totalWins) || 0,
            winStreak: Number(data.winStreak) || 0,
            penName: penDef.name,
            isCurrentUser: isMe,
            isAdmin: Boolean(data.isAdmin),
          });
        });

        rows.sort((a, b) => {
          if (a.division !== b.division) return a.division - b.division;
          if (b.divisionPoints !== a.divisionPoints) return b.divisionPoints - a.divisionPoints;
          return b.totalWins - a.totalWins;
        });

        rows.forEach((row, idx) => {
          row.rank = idx + 1;
        });

        if (active) setStandings(rows);
      } catch {
        if (active) setStandings([]);
      } finally {
        if (active) setLoadingStandings(false);
      }
    };

    loadStandings();
    return () => {
      active = false;
    };
  }, [profile.division, profile.divisionPoints, profile.totalWins, profile.username]);

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-6 font-sans space-y-6">
      {/* Top Division Status Header */}
      <div className="bg-white border-4 border-black p-6 shadow-brutal-yellow flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 bg-[#ffe500] border-3 border-black flex items-center justify-center text-4xl shadow-brutal-black shrink-0">
            {currentDivisionInfo.rewardBadge}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="bg-black text-[#ffe500] font-mono font-black text-xs px-2 py-0.5 uppercase tracking-wider">
                PFA 27 SEASON LADDER
              </span>
              <span className="font-mono text-xs font-bold text-neutral-600 uppercase">
                RATING {computedRating} PTS
              </span>
            </div>
            <h2 className="font-broadcast text-3xl sm:text-5xl font-black italic tracking-wide text-black mt-1 leading-none">
              {currentDivisionInfo.name}
            </h2>
            <p className="font-mono text-xs text-neutral-700 mt-2">
              {nextDivisionInfo
                ? `Earn ${Math.max(0, 100 - profile.divisionPoints)} more Division Points in Online PvP or Tournament cups to promote to ${nextDivisionInfo.name}.`
                : 'Maximum competitive tier reached! Defend your World Elite crown against top challengers.'}
            </p>
          </div>
        </div>

        <button
          onClick={() => {
            sounds.playClick();
            onNavigate('MULTIPLAYER');
          }}
          className="px-5 py-3.5 bg-[#ffe500] hover:bg-[#ebd300] text-black font-broadcast font-black text-lg uppercase tracking-wider border-3 border-black shadow-brutal-black hover:translate-x-0.5 hover:translate-y-0.5 transition-all cursor-pointer flex items-center justify-center gap-2 shrink-0"
        >
          <span>PLAY RANKED DUELS</span>
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>

      {/* Rank Progress Meter Strip */}
      <div className="bg-[#0e121b] border-4 border-white p-5 text-white shadow-brutal-black">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 font-mono text-xs mb-2">
          <span className="font-black uppercase text-[#ffe500] flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4" />
            PROMOTION PROGRESS: DIVISION {profile.division}
            {nextDivisionInfo ? ` → DIVISION ${nextDivisionInfo.division}` : ' (MAX TIER)'}
          </span>
          <span className="font-black tabular-nums text-white">
            {profile.divisionPoints} / 100 DIV PTS · {profile.totalWins}W ({profile.winStreak} STREAK)
          </span>
        </div>
        <div className="w-full h-5 bg-black border-2 border-white overflow-hidden">
          <div
            className="h-full bg-[#ffe500] transition-all duration-500"
            style={{ width: `${Math.min(100, Math.max(0, profile.divisionPoints))}%` }}
          />
        </div>
      </div>

      {/* 10-Tier Divisions Ladder + Top Standings */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 10-Tier Divisions Matrix */}
        <div className="lg:col-span-7 bg-white border-4 border-black p-5 shadow-brutal-black">
          <div className="flex items-center justify-between border-b-2 border-black pb-3 mb-4">
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-black" />
              <h3 className="font-broadcast text-2xl font-black italic uppercase text-black">
                10-TIER DIVISION LADDER
              </h3>
            </div>
            <span className="font-mono text-[10px] font-black uppercase bg-neutral-100 border border-black px-2 py-0.5 text-black">
              DIV 10 → DIV 1
            </span>
          </div>

          <div className="space-y-2.5">
            {DIVISIONS.map((tier) => {
              const isCurrent = profile.division === tier.division;
              const isCleared = profile.division < tier.division;

              return (
                <div
                  key={tier.division}
                  className={`p-3.5 border-2 flex items-center justify-between gap-3 transition-all ${
                    isCurrent
                      ? 'bg-[#ffe500] text-black border-black shadow-brutal-black'
                      : isCleared
                      ? 'bg-emerald-50 text-black border-black'
                      : 'bg-neutral-50 text-neutral-800 border-black/70'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-2xl w-9 text-center shrink-0">{tier.rewardBadge}</span>
                    <div>
                      <div className="font-broadcast text-xl font-black italic leading-none text-black">
                        {tier.name}
                      </div>
                      <div className="font-mono text-[11px] text-neutral-700 mt-1">
                        Promotion Threshold: {tier.minRating}+ Rating PTS
                      </div>
                    </div>
                  </div>

                  {isCurrent ? (
                    <span className="px-2.5 py-1 bg-black text-[#ffe500] font-mono text-[10px] font-black uppercase border border-black shrink-0">
                      CURRENT TIER
                    </span>
                  ) : isCleared ? (
                    <span className="px-2.5 py-1 bg-emerald-600 text-white font-mono text-[10px] font-black uppercase border border-black shrink-0">
                      PROMOTED ✓
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 bg-white text-neutral-600 font-mono text-[10px] font-bold uppercase border border-black/40 shrink-0">
                      DIV {tier.division}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Live Public Leaderboard Standings */}
        <div className="lg:col-span-5 bg-white border-4 border-black p-5 shadow-brutal-yellow flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b-2 border-black pb-3 mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Award className="w-4 h-4 text-black" />
                  <h3 className="font-broadcast text-2xl font-black italic uppercase text-black leading-none">
                    HUMAN RANKINGS
                  </h3>
                </div>
                <p className="font-mono text-[10px] text-neutral-600 mt-1 flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3 text-red-600" />
                  LIVE /leaderboard FEED (BOTS EXCLUDED)
                </p>
              </div>
            </div>

            {loadingStandings ? (
              <div className="p-8 text-center font-mono text-xs text-neutral-500 uppercase bg-neutral-50 border-2 border-dashed border-neutral-300">
                LOADING RANKED STANDINGS...
              </div>
            ) : standings.length === 0 ? (
              <div className="p-8 text-center font-mono text-xs text-neutral-600 uppercase bg-neutral-50 border-2 border-dashed border-neutral-300">
                NO VERIFIED MATCHES PLAYED YET. QUEUE IN MULTIPLAYER TO CLAIM #1!
              </div>
            ) : (
              <div className="space-y-2">
                {standings.map((row) => (
                  <div
                    key={row.id}
                    className={`p-3 border-2 flex items-center justify-between gap-2 ${
                      row.isCurrentUser
                        ? 'bg-[#ffe500] border-black shadow-brutal-black font-black'
                        : 'bg-neutral-50 border-black'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="font-broadcast text-xl font-black italic text-black w-7 text-center tabular-nums">
                        #{row.rank}
                      </span>
                      <div className="min-w-0">
                        <div className="font-broadcast text-base font-black uppercase text-black truncate">
                          {row.username}
                        </div>
                        <div className="font-mono text-[10px] text-neutral-600 truncate">
                          DIV {row.division} · {row.divisionPoints}pts · {row.totalWins}W · {row.penName}
                        </div>
                      </div>
                    </div>
                    {row.isAdmin && (
                      <span className="bg-red-600 text-white font-mono text-[9px] font-black px-1.5 py-0.5 border border-black shrink-0">
                        ADMIN
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => {
              sounds.playClick();
              onNavigate('MULTIPLAYER');
            }}
            className="mt-5 w-full py-3 bg-black hover:bg-neutral-800 text-[#ffe500] font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black shadow-brutal-black cursor-pointer"
          >
            OPEN ONLINE MATCHMAKING LOBBY →
          </button>
        </div>
      </div>
    </div>
  );
};
