// Creates the first owner account for a clean (non-demo) installation.
// Usage: OWNER_EMAIL=... OWNER_PASSWORD=... OWNER_NAME="..." npm run create-owner
import { get, getDb } from './db.ts';
import { createOwner, ensureDefaults } from './setup.ts';

getDb();
ensureDefaults();
const { OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_NAME: name } = process.env;

if (get("SELECT 1 FROM users WHERE role = 'owner'")) {
  console.log('An owner account already exists. Nothing to do.');
} else if (!email || !password || password.length < 10 || !name) {
  console.error('Set OWNER_EMAIL, OWNER_NAME and OWNER_PASSWORD (at least 10 characters) in .env or the environment, then run again.');
  process.exitCode = 1;
} else {
  createOwner({ email, password, name });
  console.log(`Owner account created for ${email}. Sign in and complete the shop settings, services and team.`);
}
