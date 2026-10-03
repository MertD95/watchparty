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

For an interactive preview of the extension UI without installing it:

```bash
npm run preview:ui
```

Open `http://localhost:8091/`. Switch between the Stremio sidebar, popup,
settings and side panel, with sample host/guest/no-room states. This loopback-only
playground loads the actual UI files with a development-only browser API adapter;
rooms, chat and connection status are simulated. It does not test real syncing
or change production/installed-extension data. The page also includes setup
instructions for real testing with the unpacked extension and local backend.

The preview runs separately from the optional landing server on port 8090.
Set `WATCHPARTY_UI_PREVIEW_PORT` to change its port. Preview files stay under
`tools/` and are not included in the store package.

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
- Run regression tests, syntax, typecheck, and generated action/protocol/domain checks locally before pushing. Isolated installed-extension browser checks complement these deterministic tests. GitHub Actions does not run test suites on pushes or pull requests; release jobs only package, validate, and optionally submit the ZIP for Google review.

## Supported runtime contract

The website, extension and backend target the current contract together. Old
website fire-and-forget actions, uncorrelated membership requests and raw
playback-publish payloads are not supported. Website mutations require a
correlated extension acknowledgement; actual connected room membership is
confirmed separately before private invite data is cleared.

Treat protocol-breaking changes as a coordinated release: finish local paired
testing and obtain Chrome Web Store approval before switching production to a
backend/website that requires the new extension. The current website shows
update/refresh guidance when its installed bridge lacks correlated action
results. Already-open old pages and extensions cannot be relied on to show that
new guidance; users must update the extension and refresh both the website and
Stremio tabs. Store approval does not update every installed client immediately.

Both production paths currently deploy from `main` (Cloudflare Git integration
and the backend deployment workflow). Do not push a protocol-breaking cutover
to either production branch before the coordinated release is ready. Package
the new extension under a new version/tag; do not reuse an already released tag.

Current recovery paths (MV3 worker restart, reconnects, tab leases and pending
membership cancellation) are still required and are not deprecated compatibility
code. Likewise, the configured Google publishing OAuth flow is active CI
authentication, not an obsolete fallback.

## Notes

- `store-listing.json` is the current Chrome Web Store description, permission justification, privacy-disclosure and screenshot brief. `store-assets/chrome-web-store/` contains copy-ready dashboard instructions, text and correctly sized images. Update the signed-in developer dashboard before submitting a release; the package publishing API does not update these listing fields. Never advertise that no user data is handled or that all room data is end-to-end encrypted.
- The local Stremio network rules are scoped to HTTP port 11470 and supported Stremio initiator domains. They do not relax CORS for the local WatchParty backend, other local applications or arbitrary websites. Extension-worker service checks use the existing local-service host permission without those page-specific rules.
- DNR header changes require explicit host permission for both the local service and supported initiating Stremio pages; content-script matches alone are insufficient. Chrome's `initiatorDomains` filters include descendant subdomains, but the three Stremio host-permission patterns are exact, without subdomain wildcards.

- `extension/wp-protocol.js` is generated from `../watchparty-server/tools/gen-protocol.js`
- The extension and landing page both depend on `watchparty-server` for live room flows
- The default manifest no longer ships localhost landing-page access; unpacked dev installs can opt into localhost landing access from the options page when needed
- `localhost:11470` is the Stremio local service, not just a development host
- The Stremio auth key is forwarded to the background worker and kept in memory only; it is not persisted in extension storage
- The website auto-deploys through Cloudflare Workers Builds Git integration. Once Chrome publishing is configured and enabled, publishing a stable `v<manifest version>` GitHub release automatically packages that exact tag and uploads it as a Chrome Web Store draft. Save listing/privacy changes in the dashboard, then explicitly submit the tested tag for staged Google review. A normal push does not publish the extension, and Google approval does not activate a staged release.
- `npm run build:store-package` creates a Chrome Web Store bundle under `dist/chrome-web-store/` and strips dev-only localhost backend and landing origins from the packaged manifest; the release workflow uses this same package builder
- Deployment and one-time Google authentication setup live in `SECURITY.md`. **Extension Release** can be dispatched from `main` with `mode=status` for a read-only credential check, `mode=package` to package an existing `release_tag`, `mode=upload` to prepare its dashboard draft, or `mode=submit` to re-upload that exact tag and submit it for staged review (for example `v2.1.0`). These jobs do not install dependencies or run tests.
- Replacing a pending review or activating an approved staged release are separate, explicit operations: dispatch `mode=cancel-review` or `mode=publish-staged` with its exact `expected_version`. Release/upload/submit jobs never automatically cancel another review or activate a staged release. See the safeguards in `SECURITY.md`.
