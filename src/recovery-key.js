import { randomBytes } from "node:crypto";

// Crockford base32: no I, L, O or U, so a key copied by hand is hard to get wrong.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 8;
const GROUP_LEN = 4;

// The recovery key is the restic repository password: 32 symbols × 5 bits = 160 bits.
export function generateRecoveryKey() {
  const bytes = randomBytes(GROUPS * GROUP_LEN);
  const chars = [...bytes].map((b) => ALPHABET[b & 31]);
  const groups = [];
  for (let i = 0; i < GROUPS; i++) groups.push(chars.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN).join(""));
  return `agouti-rk-${groups.join("-")}`;
}

// Accepts keys pasted with stray whitespace or lowercase.
export function normalizeRecoveryKey(input) {
  const key = input.trim().replace(/\s+/g, "");
  return /^agouti-rk-/i.test(key) ? "agouti-rk-" + key.slice(10).toUpperCase() : key;
}
