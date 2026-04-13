// WatchParty — Crypto module unit tests
// Tests AES-256-GCM encryption, key export/import, base64url encoding.
// Runs in Node.js 20+ (uses globalThis.crypto Web Crypto API).
//
// Usage: node extension/test/crypto.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the IIFE — it assigns to globalThis since there's no `window` in Node
const src = readFileSync(join(__dirname, '..', 'stremio-crypto.js'), 'utf8');
const patched = src.replace('const WPCrypto =', 'globalThis.WPCrypto =');
new Function(patched)();
const WPCrypto = globalThis.WPCrypto;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function testKeyGeneration() {
  console.log('\n── Key Generation ──');
  const key = await WPCrypto.generateKey();
  assert(key !== null, 'generateKey returns a CryptoKey');
  assert(WPCrypto.isEnabled(), 'isEnabled() returns true after generateKey');
}

async function testKeyExportImport() {
  console.log('\n── Key Export / Import ──');
  await WPCrypto.generateKey();
  const exported = await WPCrypto.exportKey();
  assert(typeof exported === 'string', 'exportKey returns a string');
  assert(exported.length > 0, 'exported key is non-empty');
  assert(!/[+/=]/.test(exported), 'exported key is base64url (no +, /, =)');

  // Import the key in a fresh state
  WPCrypto.clear();
  assert(!WPCrypto.isEnabled(), 'isEnabled() false after clear');
  await WPCrypto.importKey(exported);
  assert(WPCrypto.isEnabled(), 'isEnabled() true after importKey');
}

async function testEncryptDecrypt() {
  console.log('\n── Encrypt / Decrypt ──');
  await WPCrypto.generateKey();

  const plaintext = 'Hello, WatchParty!';
  const ciphertext = await WPCrypto.encrypt(plaintext);
  assert(ciphertext.startsWith('e2e:'), 'ciphertext has e2e: prefix');
  assert(ciphertext !== plaintext, 'ciphertext differs from plaintext');
  assert(WPCrypto.isEncrypted(ciphertext), 'isEncrypted returns true for ciphertext');
  assert(!WPCrypto.isEncrypted(plaintext), 'isEncrypted returns false for plaintext');

  const decrypted = await WPCrypto.decrypt(ciphertext);
  assert(decrypted === plaintext, 'decrypt recovers original plaintext');
}

async function testUniqueIVPerMessage() {
  console.log('\n── Unique IV per message ──');
  await WPCrypto.generateKey();

  const ct1 = await WPCrypto.encrypt('same text');
  const ct2 = await WPCrypto.encrypt('same text');
  assert(ct1 !== ct2, 'same plaintext produces different ciphertext (random IV)');

  const pt1 = await WPCrypto.decrypt(ct1);
  const pt2 = await WPCrypto.decrypt(ct2);
  assert(pt1 === 'same text' && pt2 === 'same text', 'both decrypt correctly');
}

async function testCrossKeyDecryptionFails() {
  console.log('\n── Cross-key decryption fails gracefully ──');
  await WPCrypto.generateKey();
  const ciphertext = await WPCrypto.encrypt('secret message');

  // Generate a different key
  await WPCrypto.generateKey();
  const result = await WPCrypto.decrypt(ciphertext);
  assert(result === '[encrypted message]', 'wrong key returns placeholder, not error');
}

async function testExportImportRoundtrip() {
  console.log('\n── Export → Import → Decrypt roundtrip ──');
  await WPCrypto.generateKey();
  const exported = await WPCrypto.exportKey();
  const ciphertext = await WPCrypto.encrypt('roundtrip test');

  // Simulate a second client importing the shared key
  WPCrypto.clear();
  await WPCrypto.importKey(exported);
  const decrypted = await WPCrypto.decrypt(ciphertext);
  assert(decrypted === 'roundtrip test', 'imported key decrypts ciphertext from original key');
}

async function testPassthroughWithoutKey() {
  console.log('\n── Passthrough without key ──');
  WPCrypto.clear();
  const plaintext = 'unencrypted message';
  const result = await WPCrypto.encrypt(plaintext);
  assert(result === plaintext, 'encrypt returns plaintext when no key set');

  const decResult = await WPCrypto.decrypt(plaintext);
  assert(decResult === plaintext, 'decrypt returns plaintext when no e2e: prefix');
}

async function testEmptyAndSpecialStrings() {
  console.log('\n── Empty and special strings ──');
  await WPCrypto.generateKey();

  const empty = await WPCrypto.encrypt('');
  const decEmpty = await WPCrypto.decrypt(empty);
  assert(decEmpty === '', 'empty string round-trips');

  const unicode = 'Hello 🎉🍿 WatchParty!';
  const ctUnicode = await WPCrypto.encrypt(unicode);
  const decUnicode = await WPCrypto.decrypt(ctUnicode);
  assert(decUnicode === unicode, 'unicode + emoji round-trips');

  const long = 'x'.repeat(10000);
  const ctLong = await WPCrypto.encrypt(long);
  const decLong = await WPCrypto.decrypt(ctLong);
  assert(decLong === long, '10KB string round-trips');
}

async function testCorruptedCiphertext() {
  console.log('\n── Corrupted ciphertext ──');
  await WPCrypto.generateKey();
  const result = await WPCrypto.decrypt('e2e:invalidbase64!!!');
  assert(result === '[encrypted message]', 'corrupted data returns placeholder');

  const result2 = await WPCrypto.decrypt('e2e:AAAA');
  assert(result2 === '[encrypted message]', 'truncated data returns placeholder');
}

// ── Run ──
const tests = [
  testKeyGeneration,
  testKeyExportImport,
  testEncryptDecrypt,
  testUniqueIVPerMessage,
  testCrossKeyDecryptionFails,
  testExportImportRoundtrip,
  testPassthroughWithoutKey,
  testEmptyAndSpecialStrings,
  testCorruptedCiphertext,
];

console.log('WatchParty Crypto Unit Tests');
for (const test of tests) {
  try { await test(); } catch (e) { console.error(`  ✗ FATAL: ${e.message}`); failed++; }
}
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
