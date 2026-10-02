// WatchParty — E2E Encryption Module
// Provides AES-256-GCM encryption for chat messages using the Web Crypto API.
// E2E key is shared via the invite URL fragment and is distinct from the
// private-room access key sent to the server.
// Exposes: WPCrypto global used by stremio-content.js

const WPCrypto = (() => {
  'use strict';

  let cryptoKey = null; // CryptoKey for AES-GCM
  let enabled = false;
  let generation = 0;
  let onKeyLoadedCallback = null;

  function beginKeyChange() {
    generation += 1;
    cryptoKey = null;
    enabled = false;
    return generation;
  }

  function installKey(key, expectedGeneration) {
    if (generation !== expectedGeneration) throw new Error('Encryption context changed. Please retry.');
    cryptoKey = key;
    enabled = true;
    if (onKeyLoadedCallback) onKeyLoadedCallback();
    return key;
  }

  // --- Key generation ---
  async function generateKey() {
    const expectedGeneration = beginKeyChange();
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true, // extractable — needed to export for URL sharing
      ['encrypt', 'decrypt']
    );
    return installKey(key, expectedGeneration);
  }

  // Preparing an invitation must not replace the current room's active key.
  async function generateKeyString() {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    return arrayBufferToBase64Url(await crypto.subtle.exportKey('raw', key));
  }

  // --- Export key to base64url string (for invite URL fragment) ---
  async function exportKey() {
    if (!cryptoKey) return null;
    const expectedGeneration = generation;
    const raw = await crypto.subtle.exportKey('raw', cryptoKey);
    if (generation !== expectedGeneration) throw new Error('Encryption context changed. Please retry.');
    return arrayBufferToBase64Url(raw);
  }

  // --- Import key from base64url string (from invite URL fragment) ---
  async function importKey(base64url) {
    const expectedGeneration = beginKeyChange();
    if (typeof base64url !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(base64url)) {
      throw new Error('Invalid room encryption key. Paste the full invite link.');
    }
    const raw = base64UrlToArrayBuffer(base64url);
    if (raw.byteLength !== 32) throw new Error('Invalid room encryption key.');
    const key = await crypto.subtle.importKey(
      'raw', raw,
      { name: 'AES-GCM', length: 256 },
      false, // not extractable after import
      ['encrypt', 'decrypt']
    );
    return installKey(key, expectedGeneration);
  }

  // --- Encrypt a plaintext string → base64url ciphertext ---
  async function encrypt(plaintext) {
    if (!cryptoKey) throw new Error('Room encryption key is missing. Rejoin using the full invite link.');
    const expectedGeneration = generation;
    const key = cryptoKey;
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );
    if (generation !== expectedGeneration) throw new Error('Encryption context changed. Message was not sent.');
    // Prepend IV to ciphertext (IV is not secret, needed for decryption)
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return 'e2e:' + arrayBufferToBase64Url(combined.buffer);
  }

  // --- Decrypt a base64url ciphertext → plaintext string ---
  async function decryptResult(data) {
    if (!isEncrypted(data)) return { ok: true, content: data };
    if (!cryptoKey) return { ok: false, content: null };
    const expectedGeneration = generation;
    const key = cryptoKey;
    try {
      const combined = base64UrlToArrayBuffer(data.slice(4));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        key,
        ciphertext
      );
      if (generation !== expectedGeneration) return { ok: false, content: null };
      return { ok: true, content: new TextDecoder().decode(decrypted) };
    } catch {
      return { ok: false, content: null }; // Wrong key, missing key, or corrupted data.
    }
  }

  async function decrypt(data) {
    const result = await decryptResult(data);
    return result.ok ? result.content : '[encrypted message]';
  }

  // --- Check if a message is encrypted ---
  function isEncrypted(content) {
    return typeof content === 'string' && content.startsWith('e2e:');
  }

  function isEnabled() { return enabled; }
  function getGeneration() { return generation; }

  function clear() {
    beginKeyChange();
  }

  // --- Base64url helpers (URL-safe, no padding) ---
  function arrayBufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToArrayBuffer(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function onKeyLoaded(cb) { onKeyLoadedCallback = cb; }

  return {
    generateKey, generateKeyString, exportKey, importKey,
    encrypt, decrypt, decryptResult, isEncrypted, isEnabled, getGeneration, clear, onKeyLoaded,
  };
})();
