const WPRuntimeState = (() => {
  'use strict';

  const SESSION_KEYS = new Set([
    ...WPConstants.STORAGE_CONTRACT.SESSION_RUNTIME,
    ...WPConstants.STORAGE_CONTRACT.BOOTSTRAP_SESSION,
    ...WPConstants.STORAGE_CONTRACT.SENSITIVE_SESSION,
  ]);

  function normalizeKeyList(keys) {
    return Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
  }

  async function get(keys) {
    const keyList = normalizeKeyList(keys);
    if (keyList.length === 0) return {};

    const sessionKeys = keyList.filter((key) => SESSION_KEYS.has(key));
    const localKeys = keyList.filter((key) => !SESSION_KEYS.has(key));

    const [sessionValues, localValues] = await Promise.all([
      sessionKeys.length > 0 ? chrome.storage.session.get(sessionKeys).catch(() => ({})) : Promise.resolve({}),
      localKeys.length > 0 ? chrome.storage.local.get(localKeys).catch(() => ({})) : Promise.resolve({}),
    ]);

    return { ...localValues, ...sessionValues };
  }

  async function set(values) {
    if (!values || typeof values !== 'object') return;

    const sessionValues = {};
    const localValues = {};
    for (const [key, value] of Object.entries(values)) {
      if (SESSION_KEYS.has(key)) sessionValues[key] = value;
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
    const sessionKeys = keyList.filter((key) => SESSION_KEYS.has(key));
    await Promise.all([
      chrome.storage.local.remove(keyList).catch(() => {}),
      sessionKeys.length > 0 ? chrome.storage.session.remove(sessionKeys).catch(() => {}) : Promise.resolve(),
    ]);
  }

  return {
    SESSION_KEYS,
    get,
    set,
    remove,
  };
})();
