/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-time CLI utility to assign the custom claim `{ admin: true }` to a Firebase user.
 * Usage:
 *   npx tsx scripts/setAdminClaim.ts samwdoesthings@gmail.com
 *   npx tsx scripts/setAdminClaim.ts --revoke user@example.com
 */

import 'dotenv/config';
import { getFirebaseAdmin } from '../firebaseAdmin';

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const identifier = args.find((a) => !a.startsWith('--'));

  if (!identifier) {
    console.error('Usage: npx tsx scripts/setAdminClaim.ts [--revoke] <email-or-uid>');
    process.exit(1);
  }

  const { auth, error } = getFirebaseAdmin();
  if (!auth) {
    console.error('Firebase Admin SDK initialization error:', error);
    process.exit(1);
  }

  const userRecord = identifier.includes('@')
    ? await auth.getUserByEmail(identifier)
    : await auth.getUser(identifier);

  const existingClaims = userRecord.customClaims || {};
  const nextClaims = revoke
    ? { ...existingClaims, admin: false }
    : { ...existingClaims, admin: true };

  await auth.setCustomUserClaims(userRecord.uid, nextClaims);
  console.log(
    `Successfully ${revoke ? 'revoked' : 'granted'} admin custom claim for UID=${userRecord.uid} (${userRecord.email || 'no-email'}).`
  );
  console.log('The user must sign out and sign back in (or call getIdToken(true)) to refresh their ID token.');
}

main().catch((err) => {
  console.error('Failed to set admin claim:', err);
  process.exit(1);
});
