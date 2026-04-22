# WatchParty Deployment Hardening

This repo depends on GitHub, Cloudflare Pages, and optionally the Chrome Web Store for production delivery.

## GitHub

Configure these in the `watchparty` repository:

- Protect the production branch used by Cloudflare Pages
- Require pull requests before merge
- Require status checks from the CI workflow
- Require review from Code Owners
- Restrict who can push to the protected branch
- Restrict who can create GitHub releases
- Restrict who can edit repository secrets, variables, and environments

Recommended environments:

- `release-artifacts`
- `chrome-web-store`

Required repository secrets for cross-repo validation:

- `SERVER_REPO_TOKEN` - a fine-grained token with read-only `Contents` access to `MertD95/watchparty-server`

If you use environment protection rules, require reviewer approval before:

- uploading release assets
- publishing to the Chrome Web Store

## Cloudflare Pages

In the Cloudflare Pages project:

- verify the connected GitHub repository
- verify the production branch
- disable automatic production deploys if you want manual promotion only
- restrict preview branch patterns
- restrict project/account access to trusted operators only

## Chrome Web Store

If Chrome Web Store publishing is enabled:

- keep `CHROME_PUBLISH_ENABLED` off until the listing is ready
- store `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, and `CHROME_REFRESH_TOKEN` as protected GitHub secrets
- restrict the `chrome-web-store` environment to trusted reviewers
- enable 2-Step Verification on the publisher account
- use verified uploads if available for your publisher setup
