const WPPrivateRoomKeys = (() => {
  'use strict';

  function normalize(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return /^[A-Za-z0-9_-]{16,200}$/.test(trimmed) ? trimmed : null;
  }

  function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function generateAccessKey() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
  }

  async function generateE2eKey() {
    if (typeof WPCrypto === 'undefined') return null;
    WPCrypto.clear();
    await WPCrypto.generateKey();
    return WPCrypto.exportKey();
  }

  async function resolveCreateKeys(command = {}) {
    const accessKey = normalize(command.accessKey) || generateAccessKey();
    const e2eKey = normalize(command.e2eKey) || await generateE2eKey();
    return accessKey && e2eKey ? { accessKey, e2eKey } : null;
  }

  return {
    normalize,
    generateAccessKey,
    generateE2eKey,
    resolveCreateKeys,
  };
})();
