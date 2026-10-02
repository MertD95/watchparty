# WatchParty Deployment Hardening

This repo depends on GitHub, Cloudflare Workers Builds, and the Chrome Web Store for production delivery.

## GitHub

Configure these in the `watchparty` repository:

- Protect the production branch used by Cloudflare Workers Builds
- Require pull requests before merge
- Run `npm run verify:static` and the sibling backend checks locally before pushing; test suites do not run in GitHub Actions
- Require review from Code Owners
- Restrict who can push to the protected branch
- Restrict who can create GitHub releases
- Restrict who can edit repository secrets, variables, and environments

Recommended environments:

- `release-artifacts`
- `chrome-web-store`

The manual package workflow needs no credentials or dependency installation. The security audit is manual-only, with no scheduled Actions use. Cross-repo protocol validation runs locally and no longer needs `SERVER_REPO_TOKEN` in release Actions.

If you use environment protection rules, require reviewer approval before:

- uploading release assets
- publishing to the Chrome Web Store

## Cloudflare Workers Builds

In the connected Workers Builds project:

- verify the connected GitHub repository
- verify the production branch
- disable automatic production deploys if you want manual promotion only
- restrict preview branch patterns
- restrict project/account access to trusted operators only

## Chrome Web Store

If Chrome Web Store publishing is enabled:

- keep `CHROME_PUBLISH_ENABLED` off until the listing is ready
- store `CHROME_EXTENSION_ID`, `CHROME_PUBLISHER_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, and `CHROME_REFRESH_TOKEN` as protected GitHub secrets in the `chrome-web-store` environment
- restrict the `chrome-web-store` environment to trusted reviewers
- enable 2-Step Verification on the publisher account
- use verified uploads if available for your publisher setup

Publishing a GitHub release only creates the store ZIP and checksum. To submit an extension version, explicitly dispatch **Extension Release** from the intended tested commit/tag with `submit_for_review=true`. This also requires `CHROME_PUBLISH_ENABLED=true` and any configured environment approval. Never bypass environment or branch protections to release.

The checked-in Node publisher calls the official Chrome Web Store API v2 directly. It reads the version from the actual ZIP, checks existing published/submitted versions before uploading, refuses conflicting submissions and policy warnings, bounds asynchronous upload polling, and requests review with `skipReview=false` and `blockOnWarnings=true`. It never automatically cancels a submission, skips review, or retries an ambiguous mutation. `DEFAULT_PUBLISH` means Google publishes the extension if it approves the review; submission acceptance is not approval.

For a read-only status check with the five credentials provided in the environment:

```bash
node tools/publish-chrome-web-store.mjs --status
```

For a deliberate local submission of an already tested ZIP:

```bash
node tools/validate-store-package.mjs dist/chrome-web-store/watchparty-for-stremio.zip
node tools/publish-chrome-web-store.mjs --submit dist/chrome-web-store/watchparty-for-stremio.zip
```

Credentials must belong to the publisher that owns the listing, and the refresh token must authorize the `https://www.googleapis.com/auth/chromewebstore` scope. Obtain the publisher ID from Publisher > Settings in the developer dashboard. Complete store listing/privacy disclosures and account 2-Step Verification before submission. After any timeout or ambiguous response, use `--status` and the dashboard before retrying.

API references: [authentication and setup](https://developer.chrome.com/docs/webstore/using-api), [status](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus), [upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload), [review submission](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish).
