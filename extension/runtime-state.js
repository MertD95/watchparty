const WPRuntimeState = (() => {
  'use strict';

  /** @type {Set<string>} */
  const SESSION_KEYS = new Set([
    ...WPConstants.STORAGE_CONTRACT.SESSION_RUNTIME,
    ...WPConstants.STORAGE_CONTRACT.BOOTSTRAP_SESSION,
    ...WPConstants.STORAGE_CONTRACT.SENSITIVE_SESSION,
  ]);
  const SESSION_KEY_PREFIXES = [
    'wpRoomChatHistory:',
  ];

  function isSessionKey(key) {
    return SESSION_KEYS.has(key)
      || SESSION_KEY_PREFIXES.some((prefix) => typeof key === 'string' && key.startsWith(prefix));
  }

  function normalizeKeyList(keys) {
    return Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
  }

  async function get(keys) {
    const keyList = normalizeKeyList(keys);
    if (keyList.length === 0) return {};

    const sessionKeys = keyList.filter(isSessionKey);
    const localKeys = keyList.filter((key) => !isSessionKey(key));

    const [sessionValues, localValues] = await Promise.all([
      sessionKeys.length > 0 ? chrome.storage.session.get(sessionKeys).catch(() => ({})) : Promise.resolve({}),
      localKeys.length > 0 ? chrome.storage.local.get(localKeys).catch(() => ({})) : Promise.resolve({}),
    ]);

    return { ...localValues, ...sessionValues };
  }

  async function set(values) {
    if (!values || typeof values !== 'object') return;

    /** @type {Record<string, any>} */
    const sessionValues = {};
    /** @type {Record<string, any>} */
    const localValues = {};
    for (const [key, value] of Object.entries(values)) {
      if (isSessionKey(key)) sessionValues[key] = value;
      else localValues[key] = value;
    }

    await Promise.all([
      Object.keys(localValues).length > 0 ? chrome.storage.local.set(localValues).catch(() => {}) : Promise.resolve(),
      Object.keys(sessionValues).length > 0 ? chrome.storage.session.set(sessionValues).catch(() => {}) : Promise.resolve(),
    ]);

    if (Object.keys(sessionValues).length > 0) {
      chrome.storage.local.remove(Object.keys(sessionValues)).catch(() => {});
    }
  }

  async function remove(keys) {
    const keyList = normalizeKeyList(keys);
    if (keyList.length === 0) return;
    const sessionKeys = keyList.filter(isSessionKey);
    await Promise.all([
      chrome.storage.local.remove(keyList).catch(() => {}),
      sessionKeys.length > 0 ? chrome.storage.session.remove(sessionKeys).catch(() => {}) : Promise.resolve(),
    ]);
  }

  return {
    SESSION_KEYS,
    isSessionKey,
    get,
    set,
    remove,
  };
})();
