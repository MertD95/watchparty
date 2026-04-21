// WatchParty — Stremio Profile Reader
// Reads user profile from Stremio Web's localStorage and caches in chrome.storage.local.
// Only writes to storage when the profile actually changes.

const WPProfile = (() => {
  'use strict';

  const READ_INTERVAL_MS = 10_000;
  let lastHash = '';

  function readAndCache() {
    try {
      const raw = localStorage.getItem('profile');
      if (!raw) return;

      // Quick change detection: hash the raw string (skip readAt which always changes)
      const hash = raw.length + ':' + raw.slice(0, 200);
      if (hash === lastHash) return;
      lastHash = hash;

      const profile = JSON.parse(raw);
      const data = {
        authKey: profile.auth?.key ?? null,
        user: profile.auth?.user
          ? { id: profile.auth.user._id, email: profile.auth.user.email }
          : null,
        addons: (profile.addons ?? []).map(a => ({
          transportUrl: a.transportUrl,
          manifest: a.manifest,
          flags: a.flags,
        })),
        settings: {
          audioLanguage: profile.settings?.audioLanguage ?? null,
          secondaryAudioLanguage: profile.settings?.secondaryAudioLanguage ?? null,
          subtitlesLanguage: profile.settings?.subtitlesLanguage ?? null,
          secondarySubtitlesLanguage: profile.settings?.secondarySubtitlesLanguage ?? null,
          interfaceLanguage: profile.settings?.interfaceLanguage ?? null,
          streamingServerUrl: profile.settings?.streamingServerUrl ?? null,
        },
        readAt: Date.now(),
      };
      chrome.storage.local.set({ [WPConstants.STORAGE.STREMIO_PROFILE]: data });
        chrome.runtime.sendMessage({
        type: 'watchparty-ext', action: WPConstants.ACTION.PROFILE_UPDATED, data,
      }).catch(() => {});
    } catch { /* localStorage read failed or JSON parse error */ }
  }

  let intervalId = null;

  function start() {
    readAndCache();
    intervalId = setInterval(readAndCache, READ_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') readAndCache();
    });
  }

  function stop() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }

  return { start, stop, readAndCache };
})();
