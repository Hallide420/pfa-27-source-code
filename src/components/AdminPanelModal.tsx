/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useAuth } from '../firebase/AuthContext';
import { PENS_CATALOG, ALL_PEN_IDS, ALL_SKIN_IDS, ALL_FLICK_STYLE_IDS } from '../data/initialData';
import { sounds } from '../utils/audio';
import { ShieldCheck, Zap, Package, Sparkles, RefreshCw, X, Check, Flame, AlertTriangle } from 'lucide-react';

interface AdminPanelModalProps {
  onClose: () => void;
}

export const AdminPanelModal: React.FC<AdminPanelModalProps> = ({ onClose }) => {
  const { user, profile, isAdminUser, runAdminGrantAction, godModePower, setGodModePower } = useAuth();
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);

  if (!isAdminUser || !profile) return null;

  const showFeedback = (msg: string) => {
    setErrorMsg(null);
    setFeedbackMsg(msg);
    setTimeout(() => setFeedbackMsg(null), 3500);
  };

  const showError = (err: unknown) => {
    setFeedbackMsg(null);
    setErrorMsg(err instanceof Error ? err.message : 'Server rejected admin request.');
    setTimeout(() => setErrorMsg(null), 4000);
  };

  const handleMaxEverything = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await runAdminGrantAction('MAX_ALL');
      sounds.playPaperclipReward();
      showFeedback('SUCCESS: Server granted all pens, skins, styles & 999,999 clips!');
    } catch (err) {
      showError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleRefillPaperclips = async (amount: number) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await runAdminGrantAction('ADD_CLIPS', amount);
      sounds.playPaperclipReward();
      showFeedback(`+${amount.toLocaleString()} Paperclips granted via server!`);
    } catch (err) {
      showError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleUnlockAllSkins = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await runAdminGrantAction('UNLOCK_SKINS');
      sounds.playClick();
      showFeedback(`Unlocked all ${ALL_SKIN_IDS.length} Geometry Box skins!`);
    } catch (err) {
      showError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleUnlockAllStyles = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await runAdminGrantAction('UNLOCK_STYLES');
      sounds.playClick();
      showFeedback(`Unlocked all ${ALL_FLICK_STYLE_IDS.length} finger flicking styles!`);
    } catch (err) {
      showError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleResetToRookie = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await runAdminGrantAction('RESET_ROOKIE');
      sounds.playClick();
      showFeedback('Profile reset to rookie state (Admin custom claim preserved).');
    } catch (err) {
      showError(err);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 animate-fadeIn font-sans">
      <div className="relative w-full max-w-2xl bg-white border-4 border-black shadow-brutal-yellow flex flex-col text-black max-h-[90vh] overflow-hidden">
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b-4 border-black bg-[#ffe500]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-black text-[#ffe500] border-2 border-black flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="font-broadcast text-3xl font-black italic tracking-wide text-black leading-none">
                DEVELOPER ROOT CONSOLE // ADMIN
              </div>
              <div className="font-mono text-xs font-bold text-neutral-800 uppercase mt-0.5">
                SERVER-VERIFIED CUSTOM CLAIM PRIVILEGE
              </div>
            </div>
          </div>

          <button
            onClick={() => {
              sounds.playClick();
              onClose();
            }}
            className="p-1.5 text-black hover:text-white bg-white hover:bg-black border-2 border-black transition-colors cursor-pointer shadow-brutal-black"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 bg-neutral-50 flex-1">
          {/* Status Badge Strip */}
          <div className="p-4 border-3 border-black bg-white shadow-brutal-black font-mono text-xs space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-black pb-2">
              <span className="font-black uppercase text-neutral-700">AUTHENTICATED ADMIN:</span>
              <span className="font-black bg-[#ffe500] px-2 py-0.5 border border-black text-black">
                {user?.email || user?.uid}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
              <div>
                <span className="text-neutral-500 block text-[10px]">ROLE STATUS</span>
                <span className="font-black text-black text-sm">ADMIN CLAIM</span>
              </div>
              <div>
                <span className="text-neutral-500 block text-[10px]">CURRENT LEVEL</span>
                <span className="font-black text-black text-sm">LVL {profile.level}</span>
              </div>
              <div>
                <span className="text-neutral-500 block text-[10px]">PAPERCLIPS</span>
                <span className="font-black text-black text-sm">{profile.paperclips.toLocaleString()}</span>
              </div>
              <div>
                <span className="text-neutral-500 block text-[10px]">UNLOCKED PENS</span>
                <span className="font-black text-black text-sm">{profile.unlockedPens.length}/{PENS_CATALOG.length}</span>
              </div>
            </div>
          </div>

          {feedbackMsg && (
            <div className="p-3 bg-emerald-100 border-2 border-emerald-600 text-emerald-900 font-mono text-xs font-bold flex items-center gap-2 shadow-brutal-black animate-fadeIn">
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{feedbackMsg}</span>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 bg-red-100 border-2 border-red-600 text-red-900 font-mono text-xs font-bold flex items-center gap-2 shadow-brutal-black">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Primary Master Grant */}
          <div className="p-5 border-3 border-black bg-[#ffe500] shadow-brutal-black">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-5 h-5 text-black" />
              <h3 className="font-broadcast text-2xl sm:text-3xl font-black italic tracking-wide text-black leading-none">
                GRANT EVERYTHING (MASTER UNLOCK)
              </h3>
            </div>
            <p className="font-mono text-xs text-neutral-800 mb-4">
              Executes a server-verified Admin SDK transaction unlocking all {ALL_PEN_IDS.length} pens, {ALL_SKIN_IDS.length} skins, {ALL_FLICK_STYLE_IDS.length} flick techniques, and 999,999 paperclips.
            </p>
            <button
              onClick={handleMaxEverything}
              disabled={isBusy}
              className="w-full py-3.5 bg-black hover:bg-neutral-800 text-[#ffe500] font-broadcast font-black text-xl uppercase tracking-wider border-2 border-black shadow-brutal-black hover:translate-x-0.5 hover:translate-y-0.5 transition-all cursor-pointer disabled:opacity-60"
            >
              {isBusy ? 'PROCESSING SERVER GRANT...' : '★ ACTIVATE MASTER ALL-ACCESS PASS ★'}
            </button>
          </div>

          {/* Quick Item Granters */}
          <div>
            <div className="font-mono text-xs font-black uppercase tracking-wider text-black mb-3">
              SERVER-VERIFIED REPOSITORY CONTROLS:
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                onClick={() => handleRefillPaperclips(100000)}
                disabled={isBusy}
                className="p-3 border-2 border-black bg-white hover:bg-neutral-100 text-left font-mono shadow-brutal-black cursor-pointer hover:translate-x-0.5 hover:translate-y-0.5 transition-all disabled:opacity-60"
              >
                <div className="flex items-center gap-1.5 font-broadcast text-xl font-black italic text-black">
                  <span>📎</span> +100,000 CLIPS
                </div>
                <div className="text-[10px] text-neutral-600 mt-1">
                  Add 100k paperclips to vault
                </div>
              </button>

              <button
                onClick={handleUnlockAllSkins}
                disabled={isBusy}
                className="p-3 border-2 border-black bg-white hover:bg-neutral-100 text-left font-mono shadow-brutal-black cursor-pointer hover:translate-x-0.5 hover:translate-y-0.5 transition-all disabled:opacity-60"
              >
                <div className="flex items-center gap-1.5 font-broadcast text-xl font-black italic text-black">
                  <Package className="w-4 h-4 text-black" /> ALL 27 SKINS
                </div>
                <div className="text-[10px] text-neutral-600 mt-1">
                  Unlock every geometry skin
                </div>
              </button>

              <button
                onClick={handleUnlockAllStyles}
                disabled={isBusy}
                className="p-3 border-2 border-black bg-white hover:bg-neutral-100 text-left font-mono shadow-brutal-black cursor-pointer hover:translate-x-0.5 hover:translate-y-0.5 transition-all disabled:opacity-60"
              >
                <div className="flex items-center gap-1.5 font-broadcast text-xl font-black italic text-black">
                  <Zap className="w-4 h-4 text-black" /> ALL 6 STYLES
                </div>
                <div className="text-[10px] text-neutral-600 mt-1">
                  Unlock Cannon, Whip &amp; Hammer
                </div>
              </button>
            </div>
          </div>

          {/* God Mode Power Multiplier (Bot Lab Sandbox Only) */}
          <div className="p-4 border-2 border-black bg-white shadow-brutal-black">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-rose-600" />
                <span className="font-broadcast text-xl font-black italic text-black">
                  DEV GOD-MODE FLICK POWER (BOT LAB ONLY)
                </span>
              </div>
              <span className="font-mono text-xs font-black bg-[#ffe500] px-2 py-0.5 border border-black">
                {godModePower}x MULTIPLIER
              </span>
            </div>
            <p className="font-mono text-[11px] text-neutral-600 mb-3">
              Supercharges finger flick impulses exclusively inside AI Bot Lab matches. Online PvP and Tournament modes always run at strict 1.0x physics parity.
            </p>
            <div className="flex items-center gap-2">
              {[1.0, 2.0, 3.5, 5.0].map((multiplier) => (
                <button
                  key={multiplier}
                  onClick={() => {
                    sounds.playClick();
                    setGodModePower(multiplier);
                    showFeedback(`Bot Lab God-mode power set to ${multiplier}x!`);
                  }}
                  className={`flex-1 py-1.5 font-mono text-xs font-black uppercase border-2 border-black transition-all cursor-pointer ${
                    godModePower === multiplier
                      ? 'bg-black text-[#ffe500] shadow-brutal-black'
                      : 'bg-neutral-100 hover:bg-neutral-200 text-black'
                  }`}
                >
                  {multiplier === 1.0 ? '1.0x (Normal)' : `${multiplier}x Power`}
                </button>
              ))}
            </div>
          </div>

          {/* Test & Debug Actions */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2 border-t-2 border-black">
            <button
              onClick={handleResetToRookie}
              disabled={isBusy}
              className="w-full sm:w-auto px-4 py-2 bg-neutral-200 hover:bg-neutral-300 text-neutral-700 font-mono text-xs font-bold border border-black flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reset To Rookie Profile (For QA Test)
            </button>

            <button
              onClick={onClose}
              className="w-full sm:w-auto px-6 py-2 bg-black text-white font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black cursor-pointer shadow-brutal-black"
            >
              Done / Close Console
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
