# WatchParty

WatchParty is the active product repo for the browser extension and public site used with Stremio.

## Repo contents

- `extension/` - MV3 extension, popup, side panel, injected sidebar, sync runtime
- `landing/` - public website at `watchparty.mertd.me`
- `manual-fixtures/` - local browser fixtures for sync and direct-play inspection
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
npm run verify:static
npm run manual:urls
npm run manual:reset
npm run manual:state
npm run manual -- seed public --name manual-open-room --users 2
npm run manual:users -- room --peers 3 --room-name manual-bot-room
npm run build:store-package
npm run gen:actions
npm run gen:icons
```

## Runtime validation

- Browser/runtime confidence comes from manual browser passes with host, peer, and clean-web profiles.
- `manual/RUNTIME-CHECKLIST.md` is the runbook for website, Stremio, player, chat, reactions, settings, private-room, reconnect, and edge-case coverage.
- Scripts under `manual:*` prepare, perturb, inspect, or provide live realtime users only. They should not be treated as proof that the product works.
- Run regression tests, syntax, typecheck, and generated action/protocol/domain checks locally before pushing. Isolated installed-extension browser checks complement these deterministic tests. GitHub Actions does not run test suites on pushes or pull requests; its manual package check and release workflow only package and validate the ZIP.

## Notes

- `extension/wp-protocol.js` is generated from `../watchparty-server/tools/gen-protocol.js`
- The extension and landing page both depend on `watchparty-server` for live room flows
- The default manifest no longer ships localhost landing-page access; unpacked dev installs can opt into localhost landing access from the options page when needed
- `localhost:11470` is the Stremio local service, not just a development host
- The Stremio auth key is forwarded to the background worker and kept in memory only; it is not persisted in extension storage
- The website auto-deploys through Cloudflare Workers Builds Git integration, but a normal push does not publish the browser extension. GitHub releases create store artifacts; only an explicit manual release dispatch can submit them for Google review.
- `npm run build:store-package` creates a Chrome Web Store bundle under `dist/chrome-web-store/` and strips dev-only localhost backend and landing origins from the packaged manifest; the release workflow uses this same package builder
- Deployment and external-service hardening notes live in `SECURITY.md`
