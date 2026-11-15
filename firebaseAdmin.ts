/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cert, getApps, initializeApp, applicationDefault, App } from 'firebase-admin/app';
import { getAuth, Auth, DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import type { Request } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FirebaseAppletConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

function loadAppletConfig(): FirebaseAppletConfig {
  const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as FirebaseAppletConfig;
}

const appletConfig = loadAppletConfig();
export const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || appletConfig.projectId;
export const FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID || appletConfig.firestoreDatabaseId || '(default)';

let adminApp: App | null = null;
let adminInitError: string | null = null;

function parseServiceAccountFromEnv(): Record<string, string> | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;

  try {
    if (raw.startsWith('{')) {
      return JSON.parse(raw) as Record<string, string>;
    }
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    return JSON.parse(decoded) as Record<string, string>;
  } catch (err) {
    adminInitError = `Invalid FIREBASE_SERVICE_ACCOUNT_JSON format: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

export function getFirebaseAdmin(): {
  app: App | null;
  auth: Auth | null;
  db: Firestore | null;
  error: string | null;
} {
  if (adminApp) {
    return {
      app: adminApp,
      auth: getAuth(adminApp),
      db: getFirestore(adminApp, FIRESTORE_DATABASE_ID),
      error: null,
    };
  }

  const existing = getApps();
  if (existing.length > 0) {
    adminApp = existing[0];
    return {
      app: adminApp,
      auth: getAuth(adminApp),
      db: getFirestore(adminApp, FIRESTORE_DATABASE_ID),
      error: null,
    };
  }

  try {
    const serviceAccount = parseServiceAccountFromEnv();
    if (serviceAccount) {
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || FIREBASE_PROJECT_ID,
      });
    } else {
      adminApp = initializeApp({
        credential: applicationDefault(),
        projectId: FIREBASE_PROJECT_ID,
      });
    }

    return {
      app: adminApp,
      auth: getAuth(adminApp),
      db: getFirestore(adminApp, FIRESTORE_DATABASE_ID),
      error: null,
    };
  } catch (err) {
    adminInitError =
      adminInitError ||
      `Firebase Admin SDK credentials not configured (${err instanceof Error ? err.message : String(err)}). Configure FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.`;
    return {
      app: null,
      auth: null,
      db: null,
      error: adminInitError,
    };
  }
}

export interface VerifiedRequestUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
  name: string;
  token: DecodedIdToken;
}

export async function verifyRequestUser(req: Request): Promise<VerifiedRequestUser> {
  const { auth, error } = getFirebaseAdmin();
  if (!auth) {
    throw new Error(error || 'ADMIN_SDK_UNAVAILABLE');
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('MISSING_AUTH_TOKEN');
  }

  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) {
    throw new Error('MISSING_AUTH_TOKEN');
  }

  const decoded = await auth.verifyIdToken(idToken);
  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email : '',
    emailVerified: Boolean(decoded.email_verified),
    isAdmin: decoded.admin === true,
    name: typeof decoded.name === 'string' && decoded.name.trim() ? decoded.name.trim() : 'DeskStriker27',
    token: decoded,
  };
}
