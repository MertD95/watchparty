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

Restrict both environments to `main` and stable `v*` tags. Optional required reviewers pause release jobs for approval; leave that gate off only when trusted release creators should trigger unattended delivery. Protect tags against moving/deletion and do not bypass environment or branch protections to release.

## Cloudflare Workers Builds

In the connected Workers Builds project:

- verify the connected GitHub repository
- verify the production branch
- disable automatic production deploys if you want manual promotion only
- restrict preview branch patterns
- restrict project/account access to trusted operators only

## Chrome Web Store

### One-time authentication and activation

Keep the **repository variable** `CHROME_PUBLISH_ENABLED=false` until authentication and listing configuration have been checked. It must be repository-scoped because the automatic upload gate is evaluated before the job enters its environment; do not override it in the environment.

Configure `CHROME_EXTENSION_ID` and `CHROME_PUBLISHER_ID` as variables in the `chrome-web-store` environment. The item ID is the 32-character ID in the store URL; obtain the owning publisher ID from **Publisher > Settings** in the developer dashboard. Existing secrets with these two names are accepted if their variables are absent.

Choose exactly one authentication mode with the environment variable `CHROME_AUTH_MODE`:

- **`wif` (recommended):** use GitHub OIDC Workload Identity Federation to impersonate a dedicated Google service account. Run the one-time [setup helper](tools/setup-chrome-wif.sh) with its `--help` instructions in an authorized Google Cloud environment, then set environment variables `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` and `GOOGLE_SERVICE_ACCOUNT` from its output. In the Chrome Web Store Developer Dashboard's **Account** section, link that service-account email to the existing publisher. Google currently permits only one linked service account; inspect any existing link before changing it. No service-account private key or OAuth refresh token is stored in GitHub. The Google trust policy must restrict the numeric repository/owner IDs, the `chrome-web-store` environment, this exact `release.yml` workflow, and main dispatches or release tags. Grant the external principal only `roles/iam.workloadIdentityUser` on this dedicated account, not project-wide administrative roles.
- **`oauth`:** explicitly use publisher OAuth credentials instead. Store `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, and `CHROME_REFRESH_TOKEN` as protected secrets in `chrome-web-store`. Authorize only `https://www.googleapis.com/auth/chromewebstore`. Use a durable OAuth consent configuration rather than a temporary testing token. This mode does not use WIF or require service-account keys, but the long-lived refresh token must be protected and revoked if compromised.

The workflow never silently switches authentication modes. Enable 2-Step Verification on the publisher account and complete the existing listing's privacy disclosures and review requirements. Neither authentication method bypasses Google's review or account requirements.

1. Run **Actions > Extension Release > Run workflow** from `main`, with `mode=status` and no tag. This performs only a read-only API check: no packaging, dependency installation, tests, uploads, or review submission. It is allowed while publishing is disabled.
2. After that succeeds, set the repository variable `CHROME_PUBLISH_ENABLED=true`.
3. To prepare an existing tested tag, dispatch from `main` with `mode=upload` and the exact `release_tag`. Save the listing and privacy changes in the dashboard, then explicitly dispatch `mode=submit` for that tag. Both operations use current trusted publisher code and the exact tagged source; do not move the tag or recreate its release.
4. For ordinary subsequent versions, run all tests locally, merge the tested commit to `main`, create a matching stable version tag, and publish a non-prerelease GitHub release. Packaging and **upload only** then run automatically. Releases never automatically request review or activate the extension. Turning the enablement variable off skips automatic upload. Use the held-candidate procedure below when website/backend changes must not deploy before extension approval.

Use `mode=package` plus an existing `release_tag` to build an artifact without Google authentication. All manual operations require dispatch from `main`. Tagged package sources must be reachable from `main` or match the one explicitly authorized descendant candidate described below; the candidate exception never changes the main workflow/publisher used for a manual dispatch. Every tag must exactly match `v` plus the ZIP's manifest version. The package checksum and version are checked again before authentication. Disabled upload/submission requests fail closed.

Only the Chrome job can request a GitHub OIDC token. In WIF mode it obtains a short-lived token immediately before API calls, scoped only to `chromewebstore`, without writing a credentials file or exporting general Google environment credentials. The authentication action is pinned to an official release commit. No release job runs tests or installs dependencies; local pre-release checks remain required.

The checked-in Node publisher calls the official Chrome Web Store API v2 directly. It reads the version from the actual ZIP, checks existing published/submitted versions before uploading, refuses conflicting submissions and policy warnings, and bounds asynchronous upload polling. `--upload` stops without review or publication. Only explicit `--submit` requests review with `STAGED_PUBLISH`, `skipReview=false` and `blockOnWarnings=true`. Google approval leaves the new version staged, not automatically available to users. The helper never automatically activates a staged release, cancels a submission, skips review, or retries an ambiguous mutation. Submission acceptance is not approval.

The status API does **not** expose an unsubmitted draft package's version or hash. After a human dashboard-edit pause, a previous upload receipt cannot prove which draft is currently present. Therefore explicit submission rebuilds and reuploads the exact pinned source package immediately before requesting review; it does not blindly submit an unverified existing draft. Separate builds may have different ZIP timestamps/checksums while their tagged file contents, version and permissions remain identical. Each run validates its own archive. Save the listing, screenshots and privacy/permission justifications before submission, and do not edit the package/dashboard concurrently with that run.

### Held release candidate and coordinated production cutover

The website's Cloudflare integration and the backend's Azure workflow deploy production `main` pushes. The strict extension bridge/backend contract is not compatible with all earlier installed versions or cached website tabs. Hold application changes off both production branches until Google approves the matching extension. Publishing a new extension before the matching website is ready can also break old website actions. Store publication does not force existing installations to update immediately.

1. If the production branch does not yet contain these staging tools, first merge a **tooling-only** bootstrap: `.github/workflows/release.yml`, `tools/publish-chrome-web-store.mjs`, `tools/verify-release-source.mjs`, `tests/store-release.test.mjs`, and this document. Do not include extension/landing assets or the application version bump. Verify the resulting Cloudflare build still serves the unchanged production assets. This makes later status/activation dispatches available on trusted `main` without deploying the candidate UI or protocol.
2. Branch from that main commit, complete the new version and local verification, commit the full candidate, then create its matching immutable stable tag (for example, `v2.1.0`). Keep the backend candidate on its own release branch as well.
3. Set the **repository variable** `CHROME_RELEASE_CANDIDATE_SHA` to the exact lowercase 40-character candidate commit. Do not override this variable in an environment. Publish the non-prerelease GitHub release for the tag. Its event tag ref, workflow SHA, package source and authorized SHA must agree, and candidate history must contain current `origin/main`. The release uploads the package but does not request review, allowing new permissions to appear in the dashboard. The exception also permits later manual packaging/upload/submission of that same pinned tag from trusted `main`; only the separately checked-out package source changes. It never trusts an arbitrary `release/*` workflow or changes environment restrictions.
4. After `upload-only-complete`, save the updated description, screenshots, privacy declarations and all required permission justifications in the dashboard. Then dispatch from `main` with `mode=submit` and `release_tag=v2.1.0`. This reuploads the verified pinned-source package and requests staged review. Confirm the exact submitted version; keep production application branches unchanged while review is pending. Proceed only when Google reports that exact version as `STAGED` with no policy warnings or conflicting upload. A rejected or unknown state requires inspection, not automatic cancellation/resubmission.
5. Prepare a short coordinated upgrade window and rollback plan. Dispatch `publish-staged` only when website/backend cutover is ready, promote the tested application commits, verify the published version plus exact production revisions, and ask existing users to update the extension and refresh Stremio/WatchParty tabs. Publication/installation propagation means this is not a zero-interruption or mixed-version rollout guarantee.
6. Remove the candidate SHA variable after the completed cutover, or when abandoning that candidate. Never move a reviewed tag; changed code requires a new version and review.

### Explicitly publishing an approved staged version

Dispatch **Extension Release** from `main` with `mode=publish-staged`, `expected_version=2.1.0` (the exact approved version, without `v`), and no release tag. The protected `chrome-web-store` environment and `CHROME_PUBLISH_ENABLED=true` are required. This operation does not package, upload, cancel or submit an unapproved item.

The helper verifies every submitted distribution channel matches the expected version in `STAGED`, checks policy/upload/published state, and repeats the status check immediately before its single `DEFAULT_PUBLISH` request. An already published exact version is an idempotent no-op. Other versions, pending reviews and ambiguous channel/version data fail closed. Read-only polling confirms publication; after an ambiguous failure inspect `mode=status` instead of blindly repeating the mutation. A successful request does not prove all installed browsers have updated.

For an explicitly authorized local activation using process-environment credentials:

```bash
node tools/publish-chrome-web-store.mjs --publish-staged 2.1.0
```

### Explicitly replacing a pending review

Only after the publisher has authorized replacing a particular pending version, dispatch **Extension Release** from `main` with `mode=cancel-review` and `expected_version` set to that exact version (for example, `2.0.3`, without `v`). Leave `release_tag` empty. This operation uses the same protected `chrome-web-store` environment and configured WIF/OAuth identity; `CHROME_PUBLISH_ENABLED` must be `true`. It does not package, upload or submit anything.

The helper fetches status twice, requires every submitted distribution channel to match the expected version in `PENDING_REVIEW`, and refuses mismatched, missing, staged, published or policy-blocked reviews. It calls the official `cancelSubmission` endpoint once with an empty body, then performs bounded read-only checks until cancellation is confirmed. No mutation is automatically retried. Confirm the `cancellation-confirmed` result (or run `mode=status` after an ambiguous failure) before creating/submitting the tested replacement release normally.

All store workflow runs share one concurrency group. Google does not offer an atomic version/etag precondition on these cancellation/publication endpoints, so do not edit or submit the same item in the developer dashboard concurrently. If the cancellation target has already been approved or the reported version changes, cancellation stops without a mutation; inspect status before deciding the next step. For an explicitly authorized local operation using process-environment credentials, the equivalent command is `node tools/publish-chrome-web-store.mjs --cancel-review 2.0.3`. Never put credentials in its arguments.

For a read-only local status check, provide the two identity variables plus a short-lived `CHROME_ACCESS_TOKEN` in the process environment:

```bash
node tools/publish-chrome-web-store.mjs --status
```

For a deliberate local upload of an already tested ZIP, without requesting review:

```bash
node tools/validate-store-package.mjs dist/chrome-web-store/watchparty-for-stremio.zip
node tools/publish-chrome-web-store.mjs --upload dist/chrome-web-store/watchparty-for-stremio.zip
```

After saving the dashboard listing/privacy changes, deliberate local staged review submission reuploads the validated package:

```bash
node tools/validate-store-package.mjs dist/chrome-web-store/watchparty-for-stremio.zip
node tools/publish-chrome-web-store.mjs --submit dist/chrome-web-store/watchparty-for-stremio.zip
```

The local helper also supports the three active OAuth variables listed above when no `CHROME_ACCESS_TOKEN` is supplied. It never refreshes or falls back if a supplied access token fails. Do not paste tokens into chat, command-line arguments, source files, or logs. Credentials must belong to the publisher that owns the listing. After any timeout or ambiguous response, use `--status` and the dashboard before retrying.

API references: [authentication and setup](https://developer.chrome.com/docs/webstore/using-api), [GitHub OIDC authentication](https://github.com/google-github-actions/auth), [status](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus), [upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload), [review submission](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish), [explicit review cancellation](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/cancelSubmission).
