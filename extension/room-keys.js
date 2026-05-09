const WPRoomKeys = (() => {
  'use strict';

  const ROOM_ACCESS_KEY_PREFIX = 'wpRoomAccessKey:';
  const ROOM_E2E_KEY_PREFIX = 'wpRoomE2eKey:';
  const ROOM_INVITE_ACCESS_TOKEN_PREFIX = 'wpRoomInviteAccessToken:';
  const ROOM_KEY_PREFIXES = Object.freeze([
    ROOM_ACCESS_KEY_PREFIX,
    ROOM_E2E_KEY_PREFIX,
    ROOM_INVITE_ACCESS_TOKEN_PREFIX,
  ]);

  function getAccessStorageKey(roomId) {
    const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
    return normalizedRoomId ? WPConstants.STORAGE.roomAccessKey(normalizedRoomId) : null;
  }

  function getE2eStorageKey(roomId) {
    const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
    return normalizedRoomId ? WPConstants.STORAGE.roomE2eKey(normalizedRoomId) : null;
  }

  function getInviteAccessTokenStorageKey(roomId) {
    const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
    return normalizedRoomId ? WPConstants.STORAGE.roomInviteAccessToken(normalizedRoomId) : null;
  }

  function normalizePrivateKey(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return /^[A-Za-z0-9_-]{16,200}$/.test(normalized) ? normalized : '';
  }

  async function readKey(storageKey, options = {}) {
    if (!storageKey) return null;
    const allowLocal = options.allowLocal !== false;

    const sessionValues = await chrome.storage.session.get(storageKey).catch(() => ({}));
    if (sessionValues?.[storageKey]) return sessionValues[storageKey];
    if (!allowLocal) return null;

    const localValues = await chrome.storage.local.get(storageKey).catch(() => ({}));
    const decoded = WPConstants.ROOM_KEYS.decodeFromLocal(localValues?.[storageKey]);
    if (decoded.expired) {
      chrome.storage.local.remove(storageKey).catch(() => {});
    }
    return decoded.value || null;
  }

  async function writeKey(storageKey, keyValue, options = {}) {
    const normalizedKey = normalizePrivateKey(keyValue);
    if (!storageKey || !normalizedKey) return;
    const persistLocal = options.persistLocal !== false;

    await chrome.storage.session.set({ [storageKey]: normalizedKey }).catch(() => {});
    if (!persistLocal) {
      await chrome.storage.local.remove(storageKey).catch(() => {});
      return;
    }
    const encodedKey = WPConstants.ROOM_KEYS.encodeForLocal(normalizedKey);
    if (encodedKey) {
      await chrome.storage.local.set({ [storageKey]: encodedKey }).catch(() => {});
    }
  }

  async function removeKey(storageKey) {
    if (!storageKey) return;
    await chrome.storage.session.remove(storageKey).catch(() => {});
    await chrome.storage.local.remove(storageKey).catch(() => {});
  }

  async function getAccessKey(roomId) {
    return readKey(getAccessStorageKey(roomId));
  }

  async function setAccessKey(roomId, accessKey) {
    await writeKey(getAccessStorageKey(roomId), accessKey);
  }

  async function getE2eKey(roomId) {
    return readKey(getE2eStorageKey(roomId), { allowLocal: false });
  }

  async function setE2eKey(roomId, e2eKey) {
    await writeKey(getE2eStorageKey(roomId), e2eKey, { persistLocal: false });
  }

  async function getInviteAccessToken(roomId) {
    return readKey(getInviteAccessTokenStorageKey(roomId));
  }

  async function setInviteAccessToken(roomId, inviteAccessToken) {
    await writeKey(getInviteAccessTokenStorageKey(roomId), inviteAccessToken);
  }

  async function setKeys(roomId, keys = {}) {
    const accessKey = keys.accessKey;
    const e2eKey = keys.e2eKey;
    const inviteAccessToken = keys.inviteAccessToken;
    await Promise.all([
      accessKey ? setAccessKey(roomId, accessKey) : Promise.resolve(),
      e2eKey ? setE2eKey(roomId, e2eKey) : Promise.resolve(),
      inviteAccessToken ? setInviteAccessToken(roomId, inviteAccessToken) : Promise.resolve(),
    ]);
  }

  async function remove(roomId) {
    await Promise.all([
      removeKey(getAccessStorageKey(roomId)),
      removeKey(getE2eStorageKey(roomId)),
      removeKey(getInviteAccessTokenStorageKey(roomId)),
    ]);
  }

  async function appendToInviteUrl(roomId, inviteUrl) {
    const [accessKey, e2eKey] = await Promise.all([
      getAccessKey(roomId),
      getE2eKey(roomId),
    ]);
    if (!accessKey && !e2eKey) return inviteUrl;
    const params = new URLSearchParams();
    if (accessKey) params.set('accessKey', accessKey);
    if (e2eKey) params.set('e2eKey', e2eKey);
    return `${inviteUrl}#${params.toString()}`;
  }

  async function loadIntoCrypto(roomId) {
    if (typeof WPCrypto === 'undefined' || WPCrypto.isEnabled()) return null;
    const e2eKey = await getE2eKey(roomId);
    if (!e2eKey) return null;
    try {
      await WPCrypto.importKey(e2eKey);
      return e2eKey;
    } catch {
      return null;
    }
  }

  async function collectStorageKeys() {
    const [localValues, sessionValues] = await Promise.all([
      chrome.storage.local.get(null).catch(() => ({})),
      chrome.storage.session.get(null).catch(() => ({})),
    ]);
    const localKeys = Object.keys(localValues).filter((key) => ROOM_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
    const sessionKeys = Object.keys(sessionValues).filter((key) => ROOM_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
    return { localKeys, sessionKeys };
  }

  async function clearAll() {
    const { localKeys, sessionKeys } = await collectStorageKeys();
    await Promise.all([
      localKeys.length > 0 ? chrome.storage.local.remove(localKeys).catch(() => {}) : Promise.resolve(),
      sessionKeys.length > 0 ? chrome.storage.session.remove(sessionKeys).catch(() => {}) : Promise.resolve(),
    ]);
    return {
      localKeys,
      sessionKeys,
      count: new Set([...localKeys, ...sessionKeys]).size,
    };
  }

  return {
    ROOM_ACCESS_KEY_PREFIX,
    ROOM_E2E_KEY_PREFIX,
    ROOM_INVITE_ACCESS_TOKEN_PREFIX,
    getAccessStorageKey,
    getE2eStorageKey,
    getInviteAccessTokenStorageKey,
    getAccessKey,
    setAccessKey,
    getE2eKey,
    setE2eKey,
    getInviteAccessToken,
    setInviteAccessToken,
    setKeys,
    remove,
    appendToInviteUrl,
    loadIntoCrypto,
    collectStorageKeys,
    clearAll,
  };
})();
