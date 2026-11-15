/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PlayerProfile } from '../types/game';
import { PENS_CATALOG, FLICK_STYLES } from '../data/initialData';

export const DEFAULT_STARTER_PROFILE: PlayerProfile = {
  username: 'DeskStriker27',
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
  role: 'PLAYER',
  isAdmin: false,
  tutorialCompleted: false,
};

export interface CosmeticPrefsCache {
  username: string;
  equippedPenId: string;
  equippedSkinId: string;
  equippedFlickStyleId: string;
  platform: 'mobile' | 'desktop';
  crossplaySetting: 'CROSSPLAY_ENABLED' | 'SAME_PLATFORM_ONLY';
}

export function sanitizeProfileInvariants(
  profile: PlayerProfile,
  allowAdmin: boolean
): PlayerProfile {
  const safePens = Array.from(
    new Set(
      (Array.isArray(profile.unlockedPens) ? profile.unlockedPens : []).filter((id) =>
        PENS_CATALOG.some((p) => p.id === id)
      )
    )
  );
  if (!safePens.includes('bic_cristal')) safePens.unshift('bic_cristal');
  if (!safePens.includes('pilot_g2')) safePens.push('pilot_g2');

  const safeSkins = Array.from(
    new Set(
      (Array.isArray(profile.unlockedSkins) ? profile.unlockedSkins : []).filter((id) =>
        PENS_CATALOG.some((p) => p.availableSkins.some((s) => s.id === id))
      )
    )
  );
  if (!safeSkins.includes('skin_bic_classic_blue')) safeSkins.unshift('skin_bic_classic_blue');
  if (!safeSkins.includes('skin_g2_midnight')) safeSkins.push('skin_g2_midnight');

  const safeStyles = Array.from(
    new Set(
      (Array.isArray(profile.unlockedFlickStyles) ? profile.unlockedFlickStyles : []).filter(
        (id) => FLICK_STYLES.some((s) => s.id === id)
      )
    )
  );
  if (!safeStyles.includes('style_classic_thumb')) safeStyles.unshift('style_classic_thumb');

  let equippedPenId = PENS_CATALOG.some((p) => p.id === profile.equippedPenId)
    ? profile.equippedPenId
    : 'bic_cristal';
  if (!safePens.includes(equippedPenId)) {
    equippedPenId = safePens[0] || 'bic_cristal';
  }

  let equippedSkinId = PENS_CATALOG.some((p) =>
    p.availableSkins.some((s) => s.id === profile.equippedSkinId)
  )
    ? profile.equippedSkinId
    : 'skin_bic_classic_blue';
  if (!safeSkins.includes(equippedSkinId)) {
    equippedSkinId = safeSkins[0] || 'skin_bic_classic_blue';
  }

  let equippedFlickStyleId = FLICK_STYLES.some((s) => s.id === profile.equippedFlickStyleId)
    ? profile.equippedFlickStyleId
    : 'style_classic_thumb';
  if (!safeStyles.includes(equippedFlickStyleId)) {
    equippedFlickStyleId = safeStyles[0] || 'style_classic_thumb';
  }

  const totalMatches = Math.max(0, Math.min(100000, Math.floor(Number(profile.totalMatches) || 0)));
  const totalWins = Math.max(
    0,
    Math.min(totalMatches, Math.floor(Number(profile.totalWins) || 0))
  );
  const winStreak = Math.max(
    0,
    Math.min(totalWins, Math.floor(Number(profile.winStreak) || 0))
  );

  return {
    ...profile,
    username: String(profile.username || 'DeskStriker27').trim().slice(0, 64) || 'DeskStriker27',
    level: Math.max(1, Math.min(100, Math.floor(Number(profile.level) || 1))),
    xp: Math.max(0, Math.min(10000000, Math.floor(Number(profile.xp) || 0))),
    xpNextLevel: Math.max(100, Math.min(10000000, Math.floor(Number(profile.xpNextLevel) || 100))),
    paperclips: Math.max(0, Math.min(999999, Math.floor(Number(profile.paperclips) || 0))),
    division: Math.max(1, Math.min(10, Math.floor(Number(profile.division) || 10))),
    divisionPoints: Math.max(0, Math.min(100, Math.floor(Number(profile.divisionPoints) || 0))),
    totalWins,
    totalMatches,
    winStreak,
    equippedPenId,
    equippedSkinId,
    equippedFlickStyleId,
    unlockedPens: safePens.slice(0, 50),
    unlockedSkins: safeSkins.slice(0, 100),
    unlockedFlickStyles: safeStyles.slice(0, 20),
    role: allowAdmin && profile.role === 'ADMIN' ? 'ADMIN' : 'PLAYER',
    isAdmin: allowAdmin ? Boolean(profile.isAdmin) : false,
    platform: profile.platform === 'mobile' ? 'mobile' : 'desktop',
    crossplaySetting:
      profile.crossplaySetting === 'SAME_PLATFORM_ONLY'
        ? 'SAME_PLATFORM_ONLY'
        : 'CROSSPLAY_ENABLED',
    tutorialCompleted: Boolean(profile.tutorialCompleted),
  };
}
