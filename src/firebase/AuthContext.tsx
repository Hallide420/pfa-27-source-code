/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import {
  User as FirebaseUser,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { doc, onSnapshot, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './config';
import { MatchMode, PenDefinition, PenSkin, PlayerProfile } from '../types/game';
import { detectDevicePlatform } from '../utils/device';
import {
  CosmeticPrefsCache,
  DEFAULT_STARTER_PROFILE,
  sanitizeProfileInvariants,
} from '../utils/storage';

export type AdminGrantAction =
  | 'MAX_ALL'
  | 'ADD_CLIPS'
  | 'UNLOCK_PENS'
  | 'UNLOCK_SKINS'
  | 'UNLOCK_STYLES'
  | 'RESET_ROOKIE';

interface AuthContextType {
  user: FirebaseUser | null;
  profile: PlayerProfile | null;
  loading: boolean;
  isAdminUser: boolean;
  godModePower: number;
  setGodModePower: (power: number) => void;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  updateCosmeticPrefs: (patch: Partial<CosmeticPrefsCache>) => Promise<void>;
  submitMatchResult: (
    mode: MatchMode,
    isVictory: boolean,
    settlementToken?: string
  ) => Promise<void>;
  purchaseGeometryBox: (boxId: string) => Promise<{ pen: PenDefinition; skin: PenSkin }>;
  claimTutorialReward: () => Promise<boolean>;
  runAdminGrantAction: (action: AdminGrantAction, amount?: number) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function getCosmeticsCacheKey(uid: string): string {
  return `pfa27_cosmetics_${uid}`;
}

function readCosmeticPrefsCache(uid: string): Partial<CosmeticPrefsCache> | null {
  try {
    const raw = localStorage.getItem(getCosmeticsCacheKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CosmeticPrefsCache>;
    return {
      username: typeof parsed.username === 'string' ? parsed.username.slice(0, 64) : undefined,
      equippedPenId: typeof parsed.equippedPenId === 'string' ? parsed.equippedPenId : undefined,
      equippedSkinId: typeof parsed.equippedSkinId === 'string' ? parsed.equippedSkinId : undefined,
      equippedFlickStyleId:
        typeof parsed.equippedFlickStyleId === 'string' ? parsed.equippedFlickStyleId : undefined,
      platform: parsed.platform === 'mobile' ? 'mobile' : 'desktop',
      crossplaySetting:
        parsed.crossplaySetting === 'SAME_PLATFORM_ONLY'
          ? 'SAME_PLATFORM_ONLY'
          : 'CROSSPLAY_ENABLED',
    };
  } catch {
    return null;
  }
}

function writeCosmeticPrefsCache(uid: string, profile: PlayerProfile) {
  try {
    const cache: CosmeticPrefsCache = {
      username: profile.username,
      equippedPenId: profile.equippedPenId,
      equippedSkinId: profile.equippedSkinId,
      equippedFlickStyleId: profile.equippedFlickStyleId,
      platform: profile.platform === 'mobile' ? 'mobile' : 'desktop',
      crossplaySetting:
        profile.crossplaySetting === 'SAME_PLATFORM_ONLY'
          ? 'SAME_PLATFORM_ONLY'
          : 'CROSSPLAY_ENABLED',
    };
    localStorage.setItem(getCosmeticsCacheKey(uid), JSON.stringify(cache));
  } catch {}
}

function docDataToProfile(
  data: Record<string, unknown>,
  firebaseUser: FirebaseUser,
  hasAdminClaim: boolean
): PlayerProfile {
  const rawProfile: PlayerProfile = {
    username:
      typeof data.username === 'string' && data.username.trim()
        ? data.username
        : firebaseUser.displayName || 'DeskStriker27',
    level: Number(data.level) || 1,
    xp: Number(data.xp) || 0,
    xpNextLevel: Number(data.xpNextLevel) || 100,
    paperclips: data.paperclips !== undefined ? Number(data.paperclips) : 240,
    division: Number(data.division) || 10,
    divisionPoints: data.divisionPoints !== undefined ? Number(data.divisionPoints) : 20,
    totalWins: Number(data.totalWins) || 0,
    totalMatches: Number(data.totalMatches) || 0,
    winStreak: Number(data.winStreak) || 0,
    equippedPenId: typeof data.equippedPenId === 'string' ? data.equippedPenId : 'bic_cristal',
    equippedSkinId:
      typeof data.equippedSkinId === 'string' ? data.equippedSkinId : 'skin_bic_classic_blue',
    equippedFlickStyleId:
      typeof data.equippedFlickStyleId === 'string'
        ? data.equippedFlickStyleId
        : 'style_classic_thumb',
    unlockedPens: Array.isArray(data.unlockedPens)
      ? (data.unlockedPens as string[])
      : ['bic_cristal', 'pilot_g2'],
    unlockedSkins: Array.isArray(data.unlockedSkins)
      ? (data.unlockedSkins as string[])
      : ['skin_bic_classic_blue', 'skin_g2_midnight'],
    unlockedFlickStyles: Array.isArray(data.unlockedFlickStyles)
      ? (data.unlockedFlickStyles as string[])
      : ['style_classic_thumb'],
    role: hasAdminClaim ? 'ADMIN' : 'PLAYER',
    isAdmin: hasAdminClaim,
    platform: data.platform === 'mobile' ? 'mobile' : detectDevicePlatform(),
    crossplaySetting:
      data.crossplaySetting === 'SAME_PLATFORM_ONLY'
        ? 'SAME_PLATFORM_ONLY'
        : 'CROSSPLAY_ENABLED',
    tutorialCompleted: Boolean(data.tutorialCompleted),
  };

  return sanitizeProfileInvariants(rawProfile, hasAdminClaim);
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isAdminUser, setIsAdminUser] = useState<boolean>(false);
  const [godModePower, setGodModePowerState] = useState<number>(1.0);

  const userRef = useRef<FirebaseUser | null>(null);
  const profileRef = useRef<PlayerProfile | null>(null);
  const isAdminRef = useRef<boolean>(false);

  const setSyncedProfile = useCallback(
    (next: PlayerProfile | null, uid?: string) => {
      profileRef.current = next;
      setProfile(next);
      if (next && uid) {
        writeCosmeticPrefsCache(uid, next);
      }
    },
    []
  );

  // Enforce God Mode reset when user is not an admin via ID token custom claim
  useEffect(() => {
    if (!isAdminUser && godModePower !== 1.0) {
      setGodModePowerState(1.0);
    }
  }, [isAdminUser, godModePower]);

  const setGodModePower = useCallback((power: number) => {
    if (!isAdminRef.current) {
      setGodModePowerState(1.0);
      return;
    }
    const clamped = Math.min(5.0, Math.max(1.0, Number(power) || 1.0));
    setGodModePowerState(clamped);
  }, []);

  const authorizedPost = useCallback(async <T,>(url: string, body: Record<string, unknown>): Promise<T> => {
    const activeUser = userRef.current;
    if (!activeUser) {
      throw new Error('Not authenticated.');
    }
    const token = await activeUser.getIdToken();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errorCode = typeof data.error === 'string' ? data.error : `HTTP_${res.status}`;
      throw new Error(errorCode);
    }
    return data as T;
  }, []);

  const bootstrapUserSession = useCallback(
    async (firebaseUser: FirebaseUser) => {
      // Strictly check custom claim `admin === true` on ID token (never email or cached flag)
      let hasAdminClaim = false;
      try {
        const tokenResult = await firebaseUser.getIdTokenResult();
        hasAdminClaim = tokenResult.claims.admin === true;
      } catch {
        hasAdminClaim = false;
      }

      isAdminRef.current = hasAdminClaim;
      setIsAdminUser(hasAdminClaim);

      // Seed ONLY non-authoritative cosmetic UI fields until server profile loads
      const cosmeticCache = readCosmeticPrefsCache(firebaseUser.uid);
      const placeholderProfile = sanitizeProfileInvariants(
        {
          ...DEFAULT_STARTER_PROFILE,
          username: cosmeticCache?.username || firebaseUser.displayName || 'DeskStriker27',
          equippedPenId: cosmeticCache?.equippedPenId || DEFAULT_STARTER_PROFILE.equippedPenId,
          equippedSkinId: cosmeticCache?.equippedSkinId || DEFAULT_STARTER_PROFILE.equippedSkinId,
          equippedFlickStyleId:
            cosmeticCache?.equippedFlickStyleId || DEFAULT_STARTER_PROFILE.equippedFlickStyleId,
          platform: cosmeticCache?.platform || detectDevicePlatform(),
          crossplaySetting: cosmeticCache?.crossplaySetting || 'CROSSPLAY_ENABLED',
          role: hasAdminClaim ? 'ADMIN' : 'PLAYER',
          isAdmin: hasAdminClaim,
        },
        hasAdminClaim
      );
      setSyncedProfile(placeholderProfile);

      try {
        const response = await authorizedPost<{ profile: PlayerProfile }>('/api/profile/me', {
          platform: detectDevicePlatform(),
        });
        const cleanServerProfile = sanitizeProfileInvariants(response.profile, hasAdminClaim);
        setSyncedProfile(cleanServerProfile, firebaseUser.uid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Backend /api/profile/me fallback to Firestore starter read:', msg);
        // If Admin SDK env isn't configured yet, ensure starter doc exists cleanly via Firestore
        try {
          const userDocRef = doc(db, 'users', firebaseUser.uid);
          const starterPayload = {
            userId: firebaseUser.uid,
            email: (firebaseUser.email || `${firebaseUser.uid}@pfa27.local`).slice(0, 256),
            username: placeholderProfile.username,
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
            platform: detectDevicePlatform(),
            crossplaySetting: 'CROSSPLAY_ENABLED',
            tutorialCompleted: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          await setDoc(userDocRef, starterPayload, { merge: false });
        } catch {
          // Existing document already present or offline; listener below will hydrate
        }
      }
    },
    [authorizedPost, setSyncedProfile]
  );

  // Subscribe to Auth state + live Firestore user document snapshot
  useEffect(() => {
    let unsubscribeSnapshot: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }

      userRef.current = currentUser;
      setUser(currentUser);

      if (!currentUser) {
        isAdminRef.current = false;
        setIsAdminUser(false);
        setGodModePowerState(1.0);
        setSyncedProfile(null);
        setLoading(false);
        return;
      }

      try {
        await bootstrapUserSession(currentUser);

        unsubscribeSnapshot = onSnapshot(
          doc(db, 'users', currentUser.uid),
          (snap) => {
            if (snap.exists()) {
              const cloudProfile = docDataToProfile(
                snap.data() as Record<string, unknown>,
                currentUser,
                isAdminRef.current
              );
              setSyncedProfile(cloudProfile, currentUser.uid);
            }
          },
          (err) => {
            console.warn('Firestore profile listener notice:', err.message);
          }
        );
      } catch (err) {
        console.warn('Auth bootstrap notice:', err);
      } finally {
        setLoading(false);
      }
    });

    return () => {
      if (unsubscribeSnapshot) unsubscribeSnapshot();
      unsubscribeAuth();
    };
  }, [bootstrapUserSession, setSyncedProfile]);

  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    if (result.user) {
      userRef.current = result.user;
      await bootstrapUserSession(result.user);
    }
  };

  const signOutUser = async () => {
    await signOut(auth);
    userRef.current = null;
    isAdminRef.current = false;
    setIsAdminUser(false);
    setUser(null);
    setSyncedProfile(null);
    setGodModePowerState(1.0);
  };

  const updateCosmeticPrefs = useCallback(
    async (patch: Partial<CosmeticPrefsCache>) => {
      const activeUser = userRef.current;
      const current = profileRef.current;
      if (!activeUser || !current) return;

      const optimistic = sanitizeProfileInvariants({ ...current, ...patch }, isAdminRef.current);
      setSyncedProfile(optimistic, activeUser.uid);

      try {
        const res = await authorizedPost<{ profile: PlayerProfile }>('/api/profile/cosmetics', patch);
        setSyncedProfile(
          sanitizeProfileInvariants(res.profile, isAdminRef.current),
          activeUser.uid
        );
      } catch {
        // Fallback to direct client Firestore cosmetic-only update (permitted by rules)
        try {
          const allowedPatch: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.username !== undefined) allowedPatch.username = optimistic.username;
          if (patch.equippedPenId !== undefined) allowedPatch.equippedPenId = optimistic.equippedPenId;
          if (patch.equippedSkinId !== undefined) allowedPatch.equippedSkinId = optimistic.equippedSkinId;
          if (patch.equippedFlickStyleId !== undefined) {
            allowedPatch.equippedFlickStyleId = optimistic.equippedFlickStyleId;
          }
          if (patch.platform !== undefined) allowedPatch.platform = optimistic.platform;
          if (patch.crossplaySetting !== undefined) {
            allowedPatch.crossplaySetting = optimistic.crossplaySetting;
          }
          await updateDoc(doc(db, 'users', activeUser.uid), allowedPatch);
        } catch (err) {
          console.warn('Cosmetic preference update failed:', err);
        }
      }
    },
    [authorizedPost, setSyncedProfile]
  );

  const submitMatchResult = useCallback(
    async (mode: MatchMode, isVictory: boolean, settlementToken?: string) => {
      const activeUser = userRef.current;
      if (!activeUser) return;

      const res = await authorizedPost<{ profile: PlayerProfile }>('/api/economy/match-result', {
        mode,
        isVictory,
        settlementToken,
      });
      setSyncedProfile(sanitizeProfileInvariants(res.profile, isAdminRef.current), activeUser.uid);
    },
    [authorizedPost, setSyncedProfile]
  );

  const purchaseGeometryBox = useCallback(
    async (boxId: string): Promise<{ pen: PenDefinition; skin: PenSkin }> => {
      const activeUser = userRef.current;
      if (!activeUser) {
        throw new Error('Not authenticated.');
      }
      const res = await authorizedPost<{
        profile: PlayerProfile;
        pen: PenDefinition;
        skin: PenSkin;
      }>('/api/economy/purchase-box', { boxId });

      setSyncedProfile(sanitizeProfileInvariants(res.profile, isAdminRef.current), activeUser.uid);
      return { pen: res.pen, skin: res.skin };
    },
    [authorizedPost, setSyncedProfile]
  );

  const claimTutorialReward = useCallback(async (): Promise<boolean> => {
    const activeUser = userRef.current;
    if (!activeUser) return false;
    const res = await authorizedPost<{ profile: PlayerProfile; newlyClaimed: boolean }>(
      '/api/economy/tutorial-complete',
      {}
    );
    setSyncedProfile(sanitizeProfileInvariants(res.profile, isAdminRef.current), activeUser.uid);
    return res.newlyClaimed;
  }, [authorizedPost, setSyncedProfile]);

  const runAdminGrantAction = useCallback(
    async (action: AdminGrantAction, amount?: number) => {
      const activeUser = userRef.current;
      if (!activeUser || !isAdminRef.current) {
        throw new Error('Forbidden: admin claim required.');
      }
      const res = await authorizedPost<{ profile: PlayerProfile }>('/api/admin/grant', {
        action,
        amount,
      });
      setSyncedProfile(sanitizeProfileInvariants(res.profile, isAdminRef.current), activeUser.uid);
    },
    [authorizedPost, setSyncedProfile]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        isAdminUser,
        godModePower: isAdminUser ? godModePower : 1.0,
        setGodModePower,
        signInWithGoogle,
        signOutUser,
        updateCosmeticPrefs,
        submitMatchResult,
        purchaseGeometryBox,
        claimTutorialReward,
        runAdminGrantAction,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
