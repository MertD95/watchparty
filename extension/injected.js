// WatchParty for Stremio — Injected into page context
// CORS bypass is now handled by declarativeNetRequest rules (rules.json).
// This script is kept minimal — only needed for future page-context hooks if any.

(function () {
  'use strict';
  // No fetch/XHR interception needed — declarativeNetRequest rules inject
  // Access-Control-Allow-Origin headers on all localhost:11470 requests at the
  // browser level, so direct fetch/XHR works without proxy overhead.
})();
