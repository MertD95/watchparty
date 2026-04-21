const WPRoomKeys = (() => {
  'use strict';

  const ROOM_KEY_PREFIX = 'wpRoomKey:';

  function getStorageKey(roomId) {
    const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
    return normalizedRoomId ? WPConstants.STORAGE.roomKey(normalizedRoomId) : null;
  }

  async function get(roomId) {
    const storageKey = getStorageKey(roomId);
    if (!storageKey) return null;

    const sessionValues = await chrome.storage.session.get(storageKey).catch(() => ({}));
    if (sessionValues?.[storageKey]) return sessionValues[storageKey];

    const localValues = await chrome.storage.local.get(storageKey).catch(() => ({}));
    const decoded = WPConstants.ROOM_KEYS.decodeFromLocal(localValues?.[storageKey]);
    if (decoded.expired) {
      chrome.storage.local.remove(storageKey).catch(() => {});
    }
    return decoded.value || null;
  }

  async function set(roomId, roomKey) {
    const storageKey = getStorageKey(roomId);
    const normalizedRoomKey = typeof roomKey === 'string' ? roomKey.trim() : '';
    if (!storageKey || !normalizedRoomKey) return;

    const encodedRoomKey = WPConstants.ROOM_KEYS.encodeForLocal(normalizedRoomKey);
    await chrome.storage.session.set({ [storageKey]: normalizedRoomKey }).catch(() => {});
    if (encodedRoomKey) {
      await chrome.storage.local.set({ [storageKey]: encodedRoomKey }).catch(() => {});
    }
  }

  async function remove(roomId) {
    const storageKey = getStorageKey(roomId);
    if (!storageKey) return;
    await chrome.storage.session.remove(storageKey).catch(() => {});
    await chrome.storage.local.remove(storageKey).catch(() => {});
  }

  async function appendToInviteUrl(roomId, inviteUrl) {
    const roomKey = await get(roomId);
    return roomKey ? `${inviteUrl}#key=${roomKey}` : inviteUrl;
  }

  async function loadIntoCrypto(roomId) {
    if (typeof WPCrypto === 'undefined' || WPCrypto.isEnabled()) return null;
    const roomKey = await get(roomId);
    if (!roomKey) return null;
    try {
      await WPCrypto.importKey(roomKey);
      return roomKey;
    } catch {
      return null;
    }
  }

  async function collectStorageKeys() {
    const [localValues, sessionValues] = await Promise.all([
      chrome.storage.local.get(null).catch(() => ({})),
      chrome.storage.session.get(null).catch(() => ({})),
    ]);
    const localKeys = Object.keys(localValues).filter((key) => key.startsWith(ROOM_KEY_PREFIX));
    const sessionKeys = Object.keys(sessionValues).filter((key) => key.startsWith(ROOM_KEY_PREFIX));
    return { localKeys, sessionKeys };
  }

  return {
    ROOM_KEY_PREFIX,
    getStorageKey,
    get,
    set,
    remove,
    appendToInviteUrl,
    loadIntoCrypto,
    collectStorageKeys,
  };
})();
