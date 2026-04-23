// WatchParty - Stremio Profile Reader
// Reads user profile from Stremio Web localStorage and caches non-sensitive profile
// data in chrome.storage.local. The auth key is forwarded to the background and kept
// in session storage instead of being persisted durably.

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
      const authKey = profile.auth?.key ?? null;
      const data = {
        user: profile.auth?.user
          ? { id: profile.auth.user._id, email: profile.auth.user.email }
          : null,
        addons: (profile.addons ?? []).map((addon) => ({
          transportUrl: addon.transportUrl,
          manifest: addon.manifest,
          flags: addon.flags,
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
      if (authKey) {
        chrome.runtime.sendMessage({
          type: 'watchparty-ext',
          action: WPConstants.ACTION.AUTH_KEY_SAVE,
          authKey,
        }).catch(() => {});
      }
      chrome.runtime.sendMessage({
        type: 'watchparty-ext',
        action: WPConstants.ACTION.PROFILE_UPDATED,
        data,
      }).catch(() => {});
    } catch {
      // Ignore localStorage read failures and malformed profile data.
    }
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
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { start, stop, readAndCache };
})();
