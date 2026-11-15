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
import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { auth, db } from './config';
import { handleFirestoreError, OperationType } from './errors';
import { PenDefinition, PenSkin, PlayerProfile } from '../types/game';
import {
  ADMIN_EMAIL,
  ALL_PEN_IDS,
  ALL_SKIN_IDS,
  ALL_FLICK_STYLE_IDS,
  GEOMETRY_BOXES,
} from '../data/initialData';
import { detectDevicePlatform } from '../utils/device';
import {
  DEFAULT_STARTER_PROFILE,
  rollGeometryBoxDrop,
  sanitizeProfileInvariants,
} from '../utils/storage';

interface AuthContextType {
  user: FirebaseUser | null;
  profile: PlayerProfile | null;
  loading: boolean;
  isAdminUser: boolean;
  godModePower: number;
  setGodModePower: (power: number) => void;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  updateProfileData: (updater: (prev: PlayerProfile) => PlayerProfile) => Promise<void>;
  purchaseGeometryBox: (boxId: string) => Promise<{ pen: PenDefinition; skin: PenSkin }>;
  claimTutorialReward: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const isVerifiedAdminAccount = (firebaseUser: FirebaseUser | null): boolean =>
  Boolean(
    firebaseUser &&
      firebaseUser.emailVerified &&
      firebaseUser.email?.toLowerCase().trim() === ADMIN_EMAIL.toLowerCase().trim()
  );

const getLocalProfile = (uid: string, allowAdmin: boolean): PlayerProfile | null => {
  try {
    const raw = localStorage.getItem(`pfa27_profile_${uid}`);
    if (raw) {
      return sanitizeProfileInvariants({ ...DEFAULT_STARTER_PROFILE, ...JSON.parse(raw) }, allowAdmin);
    }
  } catch (err) {
    console.warn('Error reading local profile cache:', err);
  }
  return null;
};

const saveLocalProfile = (uid: string, p: PlayerProfile, allowAdmin: boolean) => {
  try {
    const clean = sanitizeProfileInvariants(p, allowAdmin);
    localStorage.setItem(`pfa27_profile_${uid}`, JSON.stringify(clean));
  } catch (err) {
    console.warn('Error persisting local profile cache:', err);
  }
};

const getAdminProfile = (): PlayerProfile => ({
  username: 'Admin Developer (Sam)',
  level: 99,
  xp: 999999,
  xpNextLevel: 1000000,
  paperclips: 999999,
  division: 1,
  divisionPoints: 100,
  totalWins: 777,
  totalMatches: 777,
  winStreak: 777,
  equippedPenId: 'rotring_600',
  equippedSkinId: 'skin_rotring_gold',
  equippedFlickStyleId: 'style_knuckle_cannon',
  unlockedPens: [...ALL_PEN_IDS],
  unlockedSkins: [...ALL_SKIN_IDS],
  unlockedFlickStyles: [...ALL_FLICK_STYLE_IDS],
  role: 'ADMIN',
  isAdmin: true,
  platform: detectDevicePlatform(),
  crossplaySetting: 'CROSSPLAY_ENABLED',
  tutorialCompleted: true,
});

function buildUserDocPayload(
  uid: string,
  email: string,
  p: PlayerProfile,
  allowAdmin: boolean,
  createdAtValue: unknown
) {
  const clean = sanitizeProfileInvariants(p, allowAdmin);
  return {
    userId: uid,
    email: (email || `${uid}@pfa27.local`).slice(0, 256),
    username: clean.username,
    level: clean.level,
    xp: clean.xp,
    xpNextLevel: clean.xpNextLevel,
    paperclips: clean.paperclips,
    division: clean.division,
    divisionPoints: clean.divisionPoints,
    totalWins: clean.totalWins,
    totalMatches: clean.totalMatches,
    winStreak: clean.winStreak,
    equippedPenId: clean.equippedPenId,
    equippedSkinId: clean.equippedSkinId,
    equippedFlickStyleId: clean.equippedFlickStyleId,
    unlockedPens: clean.unlockedPens,
    unlockedSkins: clean.unlockedSkins,
    unlockedFlickStyles: clean.unlockedFlickStyles,
    role: allowAdmin ? 'ADMIN' : 'PLAYER',
    isAdmin: allowAdmin,
    platform: clean.platform || 'desktop',
    crossplaySetting: clean.crossplaySetting || 'CROSSPLAY_ENABLED',
    tutorialCompleted: Boolean(clean.tutorialCompleted),
    createdAt: createdAtValue || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function buildLeaderboardPayload(uid: string, p: PlayerProfile, allowAdmin: boolean) {
  const clean = sanitizeProfileInvariants(p, allowAdmin);
  return {
    userId: uid,
    username: clean.username,
    division: clean.division,
    divisionPoints: clean.divisionPoints,
    totalWins: clean.totalWins,
    totalMatches: clean.totalMatches,
    winStreak: clean.winStreak,
    equippedPenId: clean.equippedPenId,
    isAdmin: allowAdmin,
    updatedAt: serverTimestamp(),
  };
}

function docDataToProfile(
  data: Record<string, any>,
  firebaseUser: FirebaseUser,
  isTargetAdmin: boolean
): PlayerProfile {
  const isAdmin = isTargetAdmin;
  const rawProfile: PlayerProfile = {
    username:
      data.username ||
      firebaseUser.displayName ||
      (isAdmin ? 'Admin Developer (Sam)' : 'DeskFighter'),
    level: isAdmin ? Math.max(data.level || 1, 99) : data.level || 1,
    xp: isAdmin ? Math.max(data.xp || 0, 999999) : data.xp || 0,
    xpNextLevel: isAdmin ? 1000000 : data.xpNextLevel || 100,
    paperclips: isAdmin ? Math.max(data.paperclips ?? 0, 999999) : data.paperclips ?? 240,
    division: isAdmin ? 1 : data.division || 10,
    divisionPoints: isAdmin ? 100 : data.divisionPoints || 0,
    totalWins: isAdmin ? Math.max(data.totalWins || 0, 777) : data.totalWins || 0,
    totalMatches: isAdmin ? Math.max(data.totalMatches || 0, 777) : data.totalMatches || 0,
    winStreak: isAdmin ? Math.max(data.winStreak || 0, 777) : data.winStreak || 0,
    equippedPenId: data.equippedPenId || (isAdmin ? 'rotring_600' : 'bic_cristal'),
    equippedSkinId: data.equippedSkinId || (isAdmin ? 'skin_rotring_gold' : 'skin_bic_classic_blue'),
    equippedFlickStyleId:
      data.equippedFlickStyleId || (isAdmin ? 'style_knuckle_cannon' : 'style_classic_thumb'),
    unlockedPens: isAdmin
      ? [...ALL_PEN_IDS]
      : Array.isArray(data.unlockedPens)
        ? data.unlockedPens
        : ['bic_cristal', 'pilot_g2'],
    unlockedSkins: isAdmin
      ? [...ALL_SKIN_IDS]
      : Array.isArray(data.unlockedSkins)
        ? data.unlockedSkins
        : ['skin_bic_classic_blue', 'skin_g2_midnight'],
    unlockedFlickStyles: isAdmin
      ? [...ALL_FLICK_STYLE_IDS]
      : Array.isArray(data.unlockedFlickStyles)
        ? data.unlockedFlickStyles
        : ['style_classic_thumb'],
    role: isAdmin ? 'ADMIN' : 'PLAYER',
    isAdmin,
    platform: data.platform || detectDevicePlatform(),
    crossplaySetting: data.crossplaySetting || 'CROSSPLAY_ENABLED',
    tutorialCompleted: Boolean(data.tutorialCompleted ?? isAdmin),
  };
  return sanitizeProfileInvariants(rawProfile, isAdmin);
}

function isOfflineOrUnavailableError(err: any): boolean {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'unavailable' ||
    code === 'failed-precondition' ||
    msg.includes('offline') ||
    msg.includes('unavailable') ||
    msg.includes('network')
  );
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [godModePower, setGodModePowerState] = useState<number>(1.0);

  const profileRef = useRef<PlayerProfile | null>(null);
  const userRef = useRef<FirebaseUser | null>(null);
  const createdAtRef = useRef<Timestamp | null>(null);
  const updateQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const setSyncedProfile = useCallback((next: PlayerProfile | null) => {
    profileRef.current = next;
    setProfile(next);
  }, []);

  const isAdminUser = isVerifiedAdminAccount(user);

  // Strict enforcement: reset God Mode to 1.0x immediately whenever session is not a verified admin
  useEffect(() => {
    if (!isAdminUser && godModePower !== 1.0) {
      setGodModePowerState(1.0);
    }
  }, [isAdminUser, godModePower]);

  const setGodModePower = useCallback(
    (power: number) => {
      if (!isVerifiedAdminAccount(userRef.current)) {
        setGodModePowerState(1.0);
        return;
      }
      const clamped = Math.min(5.0, Math.max(1.0, Number(power) || 1.0));
      setGodModePowerState(clamped);
    },
    []
  );

  // Sync with Firestore profile + public PII-free leaderboard projection
  const loadOrCreateUserProfile = useCallback(
    async (firebaseUser: FirebaseUser) => {
      const userDocRef = doc(db, 'users', firebaseUser.uid);
      const leaderboardDocRef = doc(db, 'leaderboard', firebaseUser.uid);
      const isTargetAdmin = isVerifiedAdminAccount(firebaseUser);

      // 1. Hydrate sanitized local cache immediately so UI renders smoothly
      const cached = getLocalProfile(firebaseUser.uid, isTargetAdmin);
      let activeProfile: PlayerProfile;

      if (cached) {
        activeProfile = isTargetAdmin
          ? {
              ...cached,
              ...getAdminProfile(),
              username: cached.username || 'Admin Developer (Sam)',
            }
          : cached;
      } else if (isTargetAdmin) {
        activeProfile = getAdminProfile();
      } else {
        activeProfile = sanitizeProfileInvariants(
          {
            ...DEFAULT_STARTER_PROFILE,
            username: firebaseUser.displayName || 'DeskStriker27',
            platform: detectDevicePlatform(),
          },
          false
        );
      }

      setSyncedProfile(activeProfile);
      saveLocalProfile(firebaseUser.uid, activeProfile, isTargetAdmin);

      // 2. Fetch authoritative cloud profile & ensure /leaderboard projection exists atomically
      try {
        await runTransaction(db, async (tx) => {
          const userSnap = await tx.get(userDocRef);
          const lbSnap = await tx.get(leaderboardDocRef);

          if (userSnap.exists()) {
            const data = userSnap.data();
            if (data.createdAt) {
              createdAtRef.current = data.createdAt;
            }
            const loadedProfile = docDataToProfile(data, firebaseUser, isTargetAdmin);
            activeProfile = loadedProfile;

            const needsAdminSync =
              isTargetAdmin &&
              (!data.isAdmin ||
                (data.paperclips ?? 0) < 999999 ||
                (data.unlockedPens?.length || 0) < ALL_PEN_IDS.length);
            const needsSchemaMigration =
              data.tutorialCompleted === undefined ||
              data.createdAt === undefined ||
              data.crossplaySetting === undefined ||
              data.platform === undefined;

            if (needsAdminSync || needsSchemaMigration) {
              tx.set(
                userDocRef,
                buildUserDocPayload(
                  firebaseUser.uid,
                  firebaseUser.email || '',
                  loadedProfile,
                  isTargetAdmin,
                  data.createdAt || serverTimestamp()
                )
              );
            }

            if (!lbSnap.exists() || needsAdminSync || lbSnap.data()?.username !== loadedProfile.username) {
              tx.set(
                leaderboardDocRef,
                buildLeaderboardPayload(firebaseUser.uid, loadedProfile, isTargetAdmin)
              );
            }
          } else {
            const initialProfile: PlayerProfile = isTargetAdmin
              ? getAdminProfile()
              : sanitizeProfileInvariants(
                  {
                    ...DEFAULT_STARTER_PROFILE,
                    username: firebaseUser.displayName || 'DeskStriker27',
                    platform: detectDevicePlatform(),
                  },
                  false
                );
            activeProfile = initialProfile;

            tx.set(
              userDocRef,
              buildUserDocPayload(
                firebaseUser.uid,
                firebaseUser.email || '',
                initialProfile,
                isTargetAdmin,
                serverTimestamp()
              )
            );
            tx.set(
              leaderboardDocRef,
              buildLeaderboardPayload(firebaseUser.uid, initialProfile, isTargetAdmin)
            );
          }
        });

        setSyncedProfile(activeProfile);
        saveLocalProfile(firebaseUser.uid, activeProfile, isTargetAdmin);
      } catch (err: any) {
        if (isOfflineOrUnavailableError(err)) {
          console.warn('Firestore offline or auth token pending, using sanitized local profile.');
          return;
        }
        // Fallback read to inspect existing doc safely if transaction couldn't run
        try {
          const snap = await getDoc(userDocRef);
          if (snap.exists()) {
            const data = snap.data();
            if (data.createdAt) createdAtRef.current = data.createdAt;
            const loaded = docDataToProfile(data, firebaseUser, isTargetAdmin);
            setSyncedProfile(loaded);
            saveLocalProfile(firebaseUser.uid, loaded, isTargetAdmin);
          }
        } catch (readErr: any) {
          if (!isOfflineOrUnavailableError(readErr)) {
            console.warn('Cloud profile sync deferred:', readErr?.message || readErr);
          }
        }
      }
    },
    [setSyncedProfile]
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      userRef.current = currentUser;
      setUser(currentUser);
      createdAtRef.current = null;
      try {
        if (currentUser) {
          await loadOrCreateUserProfile(currentUser);
        } else {
          setSyncedProfile(null);
          setGodModePowerState(1.0);
        }
      } catch (err) {
        console.warn('Auth state subscription error handled:', err);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [loadOrCreateUserProfile, setSyncedProfile]);

  const signInWithGoogle = async () => {
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      if (result.user) {
        userRef.current = result.user;
        await loadOrCreateUserProfile(result.user);
      }
    } catch (err) {
      console.error('Sign in failed:', err);
      throw err;
    }
  };

  const signOutUser = async () => {
    try {
      await signOut(auth);
      userRef.current = null;
      createdAtRef.current = null;
      setUser(null);
      setSyncedProfile(null);
      setGodModePowerState(1.0);
    } catch (err) {
      console.error('Sign out failed:', err);
    }
  };

  // Serialized, transaction-safe profile mutation + atomic leaderboard projection update
  const enqueueTransaction = useCallback(
    <T,>(
      executor: (current: PlayerProfile, allowAdmin: boolean) => { nextProfile: PlayerProfile; result: T }
    ): Promise<T> => {
      const task = updateQueueRef.current.then(async (): Promise<T> => {
        const activeUser = userRef.current;
        const currentProfile = profileRef.current;
        if (!activeUser || !currentProfile) {
          throw new Error('Not authenticated.');
        }

        const allowAdmin = isVerifiedAdminAccount(activeUser);
        const userDocRef = doc(db, 'users', activeUser.uid);
        const leaderboardDocRef = doc(db, 'leaderboard', activeUser.uid);

        try {
          let txOutcome!: { nextProfile: PlayerProfile; result: T };

          await runTransaction(db, async (tx) => {
            const snap = await tx.get(userDocRef);
            const authoritativeBase = snap.exists()
              ? docDataToProfile(snap.data(), activeUser, allowAdmin)
              : sanitizeProfileInvariants(currentProfile, allowAdmin);
            const existingCreatedAt = snap.exists()
              ? snap.data().createdAt || createdAtRef.current || serverTimestamp()
              : serverTimestamp();

            if (snap.exists() && snap.data().createdAt) {
              createdAtRef.current = snap.data().createdAt;
            }

            txOutcome = executor(authoritativeBase, allowAdmin);
            const cleanNext = sanitizeProfileInvariants(txOutcome.nextProfile, allowAdmin);
            txOutcome.nextProfile = cleanNext;

            tx.set(
              userDocRef,
              buildUserDocPayload(
                activeUser.uid,
                activeUser.email || '',
                cleanNext,
                allowAdmin,
                existingCreatedAt
              )
            );
            tx.set(
              leaderboardDocRef,
              buildLeaderboardPayload(activeUser.uid, cleanNext, allowAdmin)
            );
          });

          setSyncedProfile(txOutcome.nextProfile);
          saveLocalProfile(activeUser.uid, txOutcome.nextProfile, allowAdmin);
          return txOutcome.result;
        } catch (err: any) {
          if (err?.message === 'INSUFFICIENT_CLIPS') {
            throw err;
          }
          if (isOfflineOrUnavailableError(err)) {
            const outcome = executor(
              sanitizeProfileInvariants(currentProfile, allowAdmin),
              allowAdmin
            );
            const cleanNext = sanitizeProfileInvariants(outcome.nextProfile, allowAdmin);
            setSyncedProfile(cleanNext);
            saveLocalProfile(activeUser.uid, cleanNext, allowAdmin);
            return outcome.result;
          }
          handleFirestoreError(err, OperationType.WRITE, `users/${activeUser.uid}`);
        }
      });

      updateQueueRef.current = task.catch(() => undefined);
      return task;
    },
    [setSyncedProfile]
  );

  const updateProfileData = useCallback(
    async (updater: (prev: PlayerProfile) => PlayerProfile) => {
      if (!userRef.current || !profileRef.current) return;
      try {
        await enqueueTransaction((current, allowAdmin) => ({
          nextProfile: sanitizeProfileInvariants(updater(current), allowAdmin),
          result: undefined,
        }));
      } catch (err) {
        console.warn('Profile update failed validation or permission check:', err);
      }
    },
    [enqueueTransaction]
  );

  const purchaseGeometryBox = useCallback(
    async (boxId: string): Promise<{ pen: PenDefinition; skin: PenSkin }> => {
      const box = GEOMETRY_BOXES.find((b) => b.id === boxId);
      if (!box) {
        throw new Error('INVALID_BOX');
      }

      return enqueueTransaction((current) => {
        if (current.paperclips < box.costPaperclips) {
          throw new Error('INSUFFICIENT_CLIPS');
        }

        const drop = rollGeometryBoxDrop(box.id);
        const nextPens = current.unlockedPens.includes(drop.pen.id)
          ? [...current.unlockedPens]
          : [...current.unlockedPens, drop.pen.id];
        const nextSkins = current.unlockedSkins.includes(drop.skin.id)
          ? [...current.unlockedSkins]
          : [...current.unlockedSkins, drop.skin.id];

        return {
          nextProfile: {
            ...current,
            paperclips: Math.max(0, current.paperclips - box.costPaperclips),
            unlockedPens: nextPens,
            unlockedSkins: nextSkins,
          },
          result: { pen: drop.pen, skin: drop.skin },
        };
      });
    },
    [enqueueTransaction]
  );

  const claimTutorialReward = useCallback(async (): Promise<boolean> => {
    if (!userRef.current || !profileRef.current) return false;
    return enqueueTransaction((current) => {
      if (current.tutorialCompleted) {
        return { nextProfile: current, result: false };
      }
      const nextSkins = current.unlockedSkins.includes('skin_gold_leaf')
        ? [...current.unlockedSkins]
        : [...current.unlockedSkins, 'skin_gold_leaf'];
      return {
        nextProfile: {
          ...current,
          tutorialCompleted: true,
          paperclips: Math.min(999999, current.paperclips + 100),
          unlockedSkins: nextSkins,
        },
        result: true,
      };
    });
  }, [enqueueTransaction]);

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
        updateProfileData,
        purchaseGeometryBox,
        claimTutorialReward,
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
