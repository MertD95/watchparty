// WatchParty — E2E Encryption Module
// Provides AES-256-GCM encryption for chat messages using the Web Crypto API.
// Key is shared via the invite URL fragment (never sent to server).
// Exposes: WPCrypto global used by stremio-content.js

const WPCrypto = (() => {
  'use strict';

  let cryptoKey = null; // CryptoKey for AES-GCM
  let enabled = false;

  // --- Key generation ---
  async function generateKey() {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true, // extractable — needed to export for URL sharing
      ['encrypt', 'decrypt']
    );
    cryptoKey = key;
    enabled = true;
    return key;
  }

  // --- Export key to base64url string (for invite URL fragment) ---
  async function exportKey() {
    if (!cryptoKey) return null;
    const raw = await crypto.subtle.exportKey('raw', cryptoKey);
    return arrayBufferToBase64Url(raw);
  }

  // --- Import key from base64url string (from invite URL fragment) ---
  async function importKey(base64url) {
    const raw = base64UrlToArrayBuffer(base64url);
    cryptoKey = await crypto.subtle.importKey(
      'raw', raw,
      { name: 'AES-GCM', length: 256 },
      false, // not extractable after import
      ['encrypt', 'decrypt']
    );
    enabled = true;
    return cryptoKey;
  }

  // --- Encrypt a plaintext string → base64url ciphertext ---
  async function encrypt(plaintext) {
    if (!cryptoKey) return plaintext;
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encoded
    );
    // Prepend IV to ciphertext (IV is not secret, needed for decryption)
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return 'e2e:' + arrayBufferToBase64Url(combined.buffer);
  }

  // --- Decrypt a base64url ciphertext → plaintext string ---
  async function decrypt(data) {
    if (!cryptoKey || !data.startsWith('e2e:')) return data;
    try {
      const combined = base64UrlToArrayBuffer(data.slice(4));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        cryptoKey,
        ciphertext
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      return '[encrypted message]'; // Decryption failed — wrong key or corrupted
    }
  }

  // --- Check if a message is encrypted ---
  function isEncrypted(content) {
    return typeof content === 'string' && content.startsWith('e2e:');
  }

  function isEnabled() { return enabled; }

  function clear() {
    cryptoKey = null;
    enabled = false;
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

  return {
    generateKey, exportKey, importKey,
    encrypt, decrypt, isEncrypted, isEnabled, clear,
  };
})();
