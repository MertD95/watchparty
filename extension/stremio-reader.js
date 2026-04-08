// WatchParty for Stremio — Stremio Profile Reader
// Injected on web.strem.io / app.strem.io to read the user's profile from localStorage.
// Extracts auth key, addons, and language preferences, then caches in chrome.storage.local.

function readAndCacheProfile() {
  try {
    const raw = localStorage.getItem('profile');
    if (!raw) return;

    const profile = JSON.parse(raw);

    // Extract only what WatchParty needs (keep payload small)
    const data = {
      // Auth
      authKey: profile.auth?.key ?? null,
      user: profile.auth?.user
        ? { id: profile.auth.user._id, email: profile.auth.user.email }
        : null,

      // Addons (transport URLs + manifests for collection building)
      addons: (profile.addons ?? []).map((a) => ({
        transportUrl: a.transportUrl,
        manifest: a.manifest,
        flags: a.flags,
      })),

      // Language preferences
      settings: {
        audioLanguage: profile.settings?.audioLanguage ?? null,
        secondaryAudioLanguage: profile.settings?.secondaryAudioLanguage ?? null,
        subtitlesLanguage: profile.settings?.subtitlesLanguage ?? null,
        secondarySubtitlesLanguage: profile.settings?.secondarySubtitlesLanguage ?? null,
        interfaceLanguage: profile.settings?.interfaceLanguage ?? null,
        streamingServerUrl: profile.settings?.streamingServerUrl ?? null,
      },

      // Timestamp for staleness checks
      readAt: Date.now(),
    };

    chrome.storage.local.set({ stremioProfile: data });
    chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'profile-updated', data });
  } catch {
    // localStorage read failed or JSON parse error — ignore
  }
}

// Read immediately on page load
readAndCacheProfile();

// Re-read periodically while the tab is open (user may log in/change settings)
setInterval(readAndCacheProfile, 10_000);

// Also re-read when the page becomes visible (user switches back to Stremio tab)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') readAndCacheProfile();
});
