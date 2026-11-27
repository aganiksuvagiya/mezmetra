import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { HttpError } from './errors.js';
import { forget, hit } from './rateLimit.js';

// The demo accounts' passwords as written in seed.js. Anyone can read them, so they are never good for a real account.
export const PUBLIC_PASSWORDS = new Set(['tableseva-demo-123', 'teapost-demo-123']);

// The passwords and base words tried first by anyone guessing.
const COMMON = new Set(
  ('password password1 password12 password123 passw0rd p@ssw0rd p@ssword 12345678 123456789 1234567890 123123123 11111111 00000000 87654321 ' +
    'qwerty12 qwerty123 qwertyui qwertyuiop 1q2w3e4r 1q2w3e4r5t asdfghjk asdf1234 zxcvbnm1 iloveyou iloveyou1 sunshine princess football ' +
    'baseball superman trustno1 welcome1 welcome123 admin123 admin1234 administrator letmein1 letmein123 abc12345 abcd1234 abcdefgh ' +
    'monkey123 dragon123 master123 hello123 india123 india@123 test1234 test@123 demo1234 demo@123 restaurant restaurant1 changeme changeme1').split(' '),
);
const WEAK_WORDS = ['password', 'passw0rd', 'admin', 'welcome', 'restaurant', 'cafe', 'hotel', 'demo', 'test', 'india', 'mezmitra', 'tableseva', 'teapost', 'kitchen', 'qwerty'];

const isRun = (s) => {
  const step = s.charCodeAt(1) - s.charCodeAt(0);
  return Math.abs(step) <= 1 && [...s].every((c, i) => i === 0 || c.charCodeAt(0) - s.charCodeAt(i - 1) === step);
};

/** Why a new password is not acceptable (a sentence), or null. `email` is the login it is for. */
export function passwordProblem(password, { email } = {}) {
  const lower = password.toLowerCase();
  // To bcrypt a NUL byte ends the password.
  if (password.includes('\0')) return 'That password contains a character that cannot be used.';
  // bcrypt reads 72 bytes and no more.
  if (Buffer.byteLength(password) > 72) return 'Use at most 72 characters.';
  if (COMMON.has(lower) || PUBLIC_PASSWORDS.has(lower)) return 'That password is too well known. Choose another one.';
  if (/^\d+$/.test(password)) return 'Use letters too, not only numbers.';
  if (isRun(lower)) return 'That password is too easy to guess. Choose another one.';
  // "teapost@123", "admin2024": a common word with a few digits.
  const word = /^([a-z]+)[@!#$_.\-]?\d{0,4}[!@#]?$/.exec(lower)?.[1];
  if (word && WEAK_WORDS.includes(word)) return 'That password is too easy to guess. Choose another one.';
  const name = String(email ?? '').toLowerCase().split('@')[0];
  if (name.length >= 5 && lower.includes(name)) return 'Do not put your email in the password.';
  return null;
}

/** Throws the form error for `field` when the password is not acceptable. */
export function assertStrongPassword(password, field = 'password', hints) {
  const problem = passwordProblem(password, hints);
  if (problem) throw new HttpError(400, 'VALIDATION_ERROR', `${field}: ${problem}`, [{ field, message: problem }]);
}

export const hashPassword = (password) => bcrypt.hash(password, config.bcryptCost);

const OWN_TRIES = 10;
const OWN_WINDOW_MS = 15 * 60_000;

/**
 * The signed-in account typing its own password again (to change it, or two-step sign-in, or payment keys). Counted per session,
 * from wherever it comes: someone holding a stolen session cannot guess the password, and cannot use up the owner's own tries
 * (a new session needs the password). Resolves to true when it is right.
 */
export async function checkOwnPassword(db, { guards, vendor, session, password }) {
  const key = `ownpw:${vendor.id}:${session}`;
  if (guards && (await hit(db, key, OWN_WINDOW_MS)).hits > OWN_TRIES) {
    throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many wrong passwords. Wait 15 minutes and try again.');
  }
  const right = await bcrypt.compare(password, vendor.password_hash);
  if (right && guards) await forget(db, key);
  return right;
}
