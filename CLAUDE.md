# WatchParty (Extension)

Chrome extension for synchronized playback on Stremio Web. Primary product.

## Repository Structure

```
watchparty/
├── extension/              # Chrome Manifest V3 extension (plain JS, no build step)
│   ├── background.js       # Service worker: WS relay, room state, clock sync, Stremio detection
│   ├── stremio-content.js  # Orchestrator: wires sync + overlay + profile on Stremio Web
│   ├── stremio-sync.js     # Sync engine: drift correction, echo prevention (WPSync)
│   ├── stremio-overlay.js  # UI: sidebar, chat, reactions, emoji picker (WPOverlay)
│   ├── stremio-profile.js  # Stremio profile/addon reader (WPProfile)
│   ├── injected.js         # Page-context fetch/XHR interceptor for Stremio localhost CORS
│   ├── content.js          # Content script for WatchParty pages (landing, client)
│   ├── popup.html/js       # Extension popup UI (create/join room)
│   ├── manifest.json       # Manifest V3 config
│   └── rules.json          # Declarative net request rules
├── landing/                # Static landing page (watchparty.mertd.me)
├── dev-reload.js           # File watcher → SSE → auto-reload extension in dev
└── package.json            # Dev dependency: chokidar (for dev-reload)
```

## Related Repos

- **watchparty-server** (`../watchparty-server/`) — WebSocket sync relay (shared by extension + client)
- **watchparty-client** (`../watchparty-client/`) — Legacy standalone Vue SPA (separate product)

## Development

### Quick Start

```bash
# Terminal 1: WS sync server
cd ../watchparty-server && npm run dev    # ws://localhost:8181

# Terminal 2: Extension auto-reload
cd ../watchparty && npm run dev           # watches extension/, port 5111

# Terminal 3 (optional): Landing page
cd landing && npx serve -l 8090
```

Then load the extension **once** in Chrome:
1. `chrome://extensions` → Enable Developer Mode → Load Unpacked
2. Select `watchparty/extension/` folder
3. Extension auto-reloads on every file change (via dev-reload.js)

### How auto-reload works

`dev-reload.js` (chokidar) watches `extension/` → sends SSE event on port 5111 → `background.js` listens via `EventSource` → calls `chrome.runtime.reload()`. Silently inactive in production (no dev server running).

### Testing via MCP Playwright

The Playwright MCP config (`../playwright-mcp.config.json`) auto-loads the extension:
```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "args": [
        "--load-extension=C:\\Users\\mertd\\WatchParty\\watchparty\\extension",
        "--disable-extensions-except=C:\\Users\\mertd\\WatchParty\\watchparty\\extension"
      ]
    }
  }
}
```

**CRITICAL: Must use `browserName: "chromium"`, NOT `"chrome"`.** Google Chrome blocks `--load-extension`.

#### Verify extension is loaded
```js
// In browser_evaluate:
document.getElementById('wp-overlay') !== null              // overlay injected
document.documentElement.getAttribute('data-watchparty-ext') // '1' on WatchParty pages
```

#### Test login
Use env vars `$WATCHPARTY_TEST_EMAIL` / `$WATCHPARTY_TEST_PASSWORD` (loaded from `.env.claude`).

## Extension Architecture

### Content script loading order (on Stremio Web)
1. `stremio-sync.js` → defines `WPSync` global (sync engine)
2. `stremio-overlay.js` → defines `WPOverlay` global (UI module)
3. `stremio-profile.js` → defines `WPProfile` global (profile reader)
4. `stremio-content.js` → orchestrator, uses all three modules

### CORS bypass (how Stremio localhost works in production)
`injected.js` overrides `window.fetch` and `window.XMLHttpRequest` in page context. Requests to `localhost:11470` are intercepted → sent via `postMessage` to content script → relayed to `background.js` → fetched from extension context (no CORS) → response base64-encoded back.

### Sync protocol
- Host's video events (play/pause/seek/timeupdate) → `background.js` → WS server → broadcast to peers
- Peers receive sync state → `WPSync.applyRemote()` → soft drift correction (playbackRate) or hard seek
- Clock sync via Cristian's algorithm (6 samples, min-RTT)

## Code Quality Rules

- **No build step** — plain JavaScript, no transpilation, no bundler
- **Module pattern** — each file exposes an IIFE global (`WPSync`, `WPOverlay`, `WPProfile`)
- **HTML escaping** — all user-generated content via `escapeHtml()` (DOM textContent trick)
- **Message validation** — `background.js` validates all server message payloads before accessing nested properties
- **Echo prevention** — sync engine uses `isSyncing` flag to ignore self-triggered video events
