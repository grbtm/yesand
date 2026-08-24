// Shared password-based encryption helpers.
// Runs unmodified in both the browser (main.js) and Node (build-content.js) —
// both environments expose the same global Web Crypto API (crypto.subtle, btoa/atob).
//
// Scheme: PBKDF2 (600k iterations, SHA-256) derives an AES-256-GCM key from the
// password + a random salt. GCM's authentication tag makes "is this the right
// password" and "decrypt the content" the same operation: decrypt() throws if
// the tag doesn't verify, and returns nothing at all when it fails.
//
// One derived key protects everything. The salt is stored once, in the text
// payload (content.enc.js); the media blobs (media/<id>.enc) reuse the key
// derived from it. Every sealed value carries its own random IV as a 12-byte
// prefix, so the layout is uniformly [12-byte IV][ciphertext+tag]. Reusing an IV
// under a single AES-GCM key is the one catastrophic mistake available here,
// which is why sealBytes() is the only way to produce one and always draws fresh.

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on anything
  // larger than a few hundred KB, which media payloads comfortably exceed.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sealBytes(key, plainBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return out;
}

// Throws on a wrong key or a tampered blob (GCM tag mismatch). Callers should
// catch and show a generic "incorrect" state, never inspect the error detail.
export async function openBytes(key, sealed) {
  const bytes = new Uint8Array(sealed);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) },
    key,
    bytes.subarray(IV_BYTES),
  );
}

export async function sealJSON(key, data) {
  return bytesToBase64(await sealBytes(key, encoder.encode(JSON.stringify(data))));
}

export async function openJSON(key, b64) {
  return JSON.parse(decoder.decode(await openBytes(key, base64ToBytes(b64))));
}
