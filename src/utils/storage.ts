/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GeometryBox, PenDefinition, PenSkin, PlayerProfile, Rarity } from '../types/game';
import { PENS_CATALOG, FLICK_STYLES, GEOMETRY_BOXES } from '../data/initialData';

const STORAGE_KEY = 'pfa27_player_profile';

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

export function loadPlayerProfile(): PlayerProfile {
  if (typeof window === 'undefined') return DEFAULT_STARTER_PROFILE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STARTER_PROFILE;
    const parsed = JSON.parse(raw);
    return sanitizeProfileInvariants({ ...DEFAULT_STARTER_PROFILE, ...parsed }, false);
  } catch {
    return DEFAULT_STARTER_PROFILE;
  }
}

export function savePlayerProfile(profile: PlayerProfile): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {}
}

export interface MatchRewardResult {
  xpGained: number;
  clipsGained: number;
  leveledUp: boolean;
  newLevel: number;
  newFlickStylesUnlocked: string[];
  divisionPromoted: boolean;
  newDivision: number;
}

export function awardMatchWin(
  profile: PlayerProfile,
  isVictory: boolean,
  clipsBonus: number = 30,
  isRankedMatch: boolean = true
): { updatedProfile: PlayerProfile; reward: MatchRewardResult } {
  const updated: PlayerProfile = {
    ...profile,
    unlockedPens: [...profile.unlockedPens],
    unlockedSkins: [...profile.unlockedSkins],
    unlockedFlickStyles: [...profile.unlockedFlickStyles],
  };

  // Clamp single-match rewards cleanly within server/rules economic limits
  const safeBonus = Math.max(0, Math.min(80, Math.floor(clipsBonus)));
  const baseXP = isRankedMatch ? (isVictory ? 50 : 15) : isVictory ? 25 : 10;
  const clips = isRankedMatch ? (isVictory ? safeBonus : 5) : isVictory ? Math.min(20, safeBonus) : 5;

  updated.totalMatches += 1;
  if (isRankedMatch) {
    if (isVictory) {
      updated.totalWins += 1;
      updated.winStreak += 1;
    } else {
      updated.winStreak = 0;
    }
  }

  updated.paperclips = Math.min(999999, updated.paperclips + clips);
  updated.xp += baseXP;

  let leveledUp = false;
  const newStylesUnlocked: string[] = [];

  // Bounded level progression (max +1 level per settlement write)
  if (updated.xp >= updated.xpNextLevel && updated.level < 100) {
    updated.xp = Math.max(0, updated.xp - updated.xpNextLevel);
    updated.level += 1;
    updated.xpNextLevel = Math.floor(updated.xpNextLevel * 1.35);
    leveledUp = true;

    for (const style of FLICK_STYLES) {
      if (
        updated.level >= style.levelRequired &&
        !updated.unlockedFlickStyles.includes(style.id) &&
        updated.unlockedFlickStyles.length < 20
      ) {
        updated.unlockedFlickStyles.push(style.id);
        newStylesUnlocked.push(style.name);
      }
    }

    let addedPens = 0;
    for (const pen of PENS_CATALOG) {
      if (
        updated.level >= pen.requiredLevel &&
        !updated.unlockedPens.includes(pen.id) &&
        updated.unlockedPens.length < 50 &&
        addedPens < 3
      ) {
        updated.unlockedPens.push(pen.id);
        addedPens += 1;
      }
    }
  }

  // Competitive division ladder (strictly Online PvP & Tournament only)
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

  return {
    updatedProfile: updated,
    reward: {
      xpGained: baseXP,
      clipsGained: clips,
      leveledUp,
      newLevel: updated.level,
      newFlickStylesUnlocked: newStylesUnlocked,
      divisionPromoted,
      newDivision: updated.division,
    },
  };
}

export function rollGeometryBoxDrop(boxId: string): {
  box: GeometryBox;
  pen: PenDefinition;
  skin: PenSkin;
} {
  const canonicalBox = GEOMETRY_BOXES.find((b) => b.id === boxId) || GEOMETRY_BOXES[0];
  const rand = Math.random();
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
  const drop =
    matchingSkins.length > 0
      ? matchingSkins[Math.floor(Math.random() * matchingSkins.length)]
      : { pen: fallbackPen, skin: fallbackPen.availableSkins[0] };

  return {
    box: canonicalBox,
    pen: drop.pen,
    skin: drop.skin,
  };
}

export function unlockItemInProfile(
  profile: PlayerProfile,
  itemType: 'pen' | 'skin',
  itemId: string
): PlayerProfile {
  const updated: PlayerProfile = {
    ...profile,
    unlockedPens: [...profile.unlockedPens],
    unlockedSkins: [...profile.unlockedSkins],
    unlockedFlickStyles: [...profile.unlockedFlickStyles],
  };

  if (
    itemType === 'pen' &&
    PENS_CATALOG.some((p) => p.id === itemId) &&
    !updated.unlockedPens.includes(itemId) &&
    updated.unlockedPens.length < 50
  ) {
    updated.unlockedPens.push(itemId);
  } else if (
    itemType === 'skin' &&
    PENS_CATALOG.some((p) => p.availableSkins.some((s) => s.id === itemId)) &&
    !updated.unlockedSkins.includes(itemId) &&
    updated.unlockedSkins.length < 100
  ) {
    updated.unlockedSkins.push(itemId);
  }
  return updated;
}
