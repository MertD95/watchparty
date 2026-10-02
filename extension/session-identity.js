// Only the background worker creates credentials. Concurrent content-script
// boots must share one persisted identity, including on a fresh installation.
const WPSessionIdentity = (() => {
  'use strict';

  function create({ storage, randomUUID, sessionIdKey, sessionTokenKey }) {
    let inFlight = null;
    function ensure() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const stored = await storage.get([sessionIdKey, sessionTokenKey]);
        const sessionId = stored[sessionIdKey] || randomUUID();
        const sessionToken = stored[sessionTokenKey] || randomUUID();
        if (!stored[sessionIdKey] || !stored[sessionTokenKey]) {
          // Do not return credentials until persistence succeeds. A failure
          // must not create an unshared identity in one tab.
          await storage.set({ [sessionIdKey]: sessionId, [sessionTokenKey]: sessionToken });
        }
        return { sessionId, sessionToken };
      })().finally(() => { inFlight = null; });
      return inFlight;
    }
    return { ensure };
  }

  return { create };
})();
