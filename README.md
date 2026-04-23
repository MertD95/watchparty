# WatchParty

WatchParty is the active product repo for the browser extension and public site used with Stremio.

## Repo contents

- `extension/` - MV3 extension, popup, side panel, injected sidebar, sync runtime
- `landing/` - public website at `watchparty.mertd.me`
- `test-fixtures/` - local browser fixtures for sync and direct-play testing
- `tools/` - local dev, packaging, and debug scripts

## Requirements

- Node 24+
- The sibling backend repo: `../watchparty-server`
- For full Stremio Web playback support, keep local Stremio running on the same device

## Local development

```bash
npm install
npm run dev
```

Typical local setup:

```bash
# terminal 1
cd ../watchparty-server && npm install && npm run dev

# terminal 2
npm run dev

# terminal 3 (optional local landing page)
node tools/serve-landing.mjs
```

## Main commands

```bash
npm run syntax
npm run test:fast
npm run test:landing
npm run test:sidepanel-integration
npm run test:integration
npm run test:browser
npm run test:full
npm run build:store-package
npm run gen:actions
npm run gen:icons
```

## CI strategy

- Push/PR CI runs the deterministic fast suite on every change.
- Landing browser coverage runs only when landing or bridge-related files change.
- Sidepanel integration runs only when extension/runtime-related files change.
- The full extension browser suite is kept for release validation and the manual `Runtime Full` workflow.

## Notes

- `extension/wp-protocol.js` is generated from `../watchparty-server/tools/gen-protocol.js`
- The extension and landing page both depend on `watchparty-server` for live room flows
- The default manifest no longer ships localhost landing-page access; unpacked dev installs can opt into localhost landing access from the options page when needed
- `localhost:11470` is the Stremio local service, not just a development host
- The Stremio auth key is forwarded to the background worker and kept in memory only; it is not persisted in extension storage
- `npm run test:sidepanel-integration` is the specific sidepanel-backed integration suite
- `npm run test:integration` is kept as a compatibility alias for `test:sidepanel-integration`
- The website can auto-deploy through Cloudflare Pages Git integration, but the browser extension is not published to the Chrome Web Store by a normal push
- `npm run build:store-package` creates a Chrome Web Store bundle under `dist/chrome-web-store/` and strips dev-only localhost landing origins from the packaged manifest
- Deployment and external-service hardening notes live in `SECURITY.md`
