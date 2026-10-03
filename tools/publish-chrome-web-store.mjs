import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readStorePackage } from './validate-store-package.mjs';

// Official API v2 only. Mutations are never automatically retried: after an
// ambiguous network failure, inspect --status before deciding to run again.
// https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish
// https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/cancelSubmission
const API = 'https://chromewebstore.googleapis.com';
const ID_ENV = ['CHROME_EXTENSION_ID', 'CHROME_PUBLISHER_ID'];
const OAUTH_AUTH_ENV = ['CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN'];
const ACTIVE_STATES = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);
const KNOWN_STATES = new Set([...ACTIVE_STATES, 'REJECTED', 'CANCELLED']);
// The UploadState schema calls this IN_PROGRESS; method prose also mentions
// UPLOAD_IN_PROGRESS. Handle both without treating any unknown state as success.
const IN_PROGRESS = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);

export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function validateReleasePackage(zipBytes, releaseTag) {
  if (typeof releaseTag !== 'string' || !/^v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(releaseTag)) {
    throw new Error('A stable version tag such as v2.0.2 is required.');
  }
  const { manifest } = readStorePackage(zipBytes);
  if (releaseTag !== `v${manifest.version}`) throw new Error('Release tag does not exactly match the ZIP manifest version.');
  return manifest.version;
}

function versions(revision) {
  return (revision?.distributionChannels || []).map(channel => channel.crxVersion).filter(value => typeof value === 'string' && /^\d+(?:\.\d+){0,3}$/.test(value));
}

function validExpectedVersion(version) {
  return typeof version === 'string'
    && /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(version)
    && version.split('.').every(part => Number(part) <= 65535);
}

function matchesExactVersion(revision, version) {
  return Array.isArray(revision?.distributionChannels) && revision.distributionChannels.length > 0
    && revision.distributionChannels.every(channel => channel?.crxVersion === version);
}

function summarize(status) {
  return {
    publishedState: status.publishedItemRevisionStatus?.state || null,
    publishedVersions: versions(status.publishedItemRevisionStatus),
    submittedState: status.submittedItemRevisionStatus?.state || null,
    submittedVersions: versions(status.submittedItemRevisionStatus),
    uploadState: status.lastAsyncUploadState || null,
    takenDown: status.takenDown === true,
    warned: status.warned === true,
  };
}

export async function runPublisher({ env = process.env, submit = false, cancelReview = false, publishStaged = false,
  expectedPendingVersion = env.CHROME_EXPECTED_PENDING_VERSION, expectedStagedVersion = env.CHROME_EXPECTED_STAGED_VERSION,
  zipBytes, expectedTag = env.CHROME_RELEASE_TAG,
  fetchImpl = globalThis.fetch, sleep = delay, now = Date.now, log = console.log,
  pollIntervalMs = 5000, maxPolls = 24, uploadDeadlineMs = 180000 } = {}) {
  const suppliedToken = env.CHROME_ACCESS_TOKEN !== undefined;
  const missing = [...ID_ENV, ...(suppliedToken ? [] : OAUTH_AUTH_ENV)].filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}.`);
  if (!/^[a-p]{32}$/.test(env.CHROME_EXTENSION_ID) || !/^[A-Za-z0-9_-]+$/.test(env.CHROME_PUBLISHER_ID)) throw new Error('Invalid Chrome item or publisher ID.');
  if ([submit, cancelReview, publishStaged].filter(Boolean).length > 1) {
    throw new Error('Submit, cancel review and publish staged are separate operations; they cannot run together.');
  }
  if (cancelReview) {
    if (!validExpectedVersion(expectedPendingVersion)) {
      throw new Error('Cancel review requires the exact expected pending version, such as 2.0.3.');
    }
    if (zipBytes !== undefined) throw new Error('Cancel review must not receive a release package.');
    if (env.GITHUB_ACTIONS === 'true' && (env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'MertD95/watchparty'
      || env.CHROME_PUBLISH_ENABLED !== 'true')) {
      throw new Error('CI cancellation requires an explicitly enabled manual dispatch from trusted main.');
    }
  }
  if (publishStaged) {
    if (!validExpectedVersion(expectedStagedVersion)) throw new Error('Publish staged requires the exact expected staged version, such as 2.1.0.');
    if (zipBytes !== undefined) throw new Error('Publish staged must not receive a release package.');
    if (env.GITHUB_ACTIONS === 'true' && (env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'MertD95/watchparty'
      || env.CHROME_PUBLISH_ENABLED !== 'true')) {
      throw new Error('CI staged publication requires an explicitly enabled manual dispatch from trusted main.');
    }
  }
  if (submit && env.GITHUB_ACTIONS === 'true' && env.CHROME_PUBLISH_ENABLED !== 'true') throw new Error('Chrome submission is disabled; CHROME_PUBLISH_ENABLED must be true.');
  if (submit && env.GITHUB_ACTIONS === 'true' && !expectedTag) throw new Error('A release tag is required for CI submission.');
  const version = publishStaged ? expectedStagedVersion : cancelReview ? expectedPendingVersion
    : submit ? (expectedTag === undefined ? readStorePackage(zipBytes).manifest.version : validateReleasePackage(zipBytes, expectedTag)) : null;
  const name = `publishers/${env.CHROME_PUBLISHER_ID}/items/${env.CHROME_EXTENSION_ID}`;
  const endpoint = `${API}/v2/${name}`;
  let token;

  async function request(label, url, options = {}, timeoutMs = 15000, expectEmpty = false) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new Error(`${label} request failed or timed out; no automatic retry. Check store status before changing store state again.`);
    }
    // Do not echo response bodies, OAuth data, HTTP headers or provider error
    // descriptions: these can contain credentials or publisher-only metadata.
    if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}). Check the Chrome Web Store dashboard or OAuth configuration.`);
    if (expectEmpty) {
      // cancelSubmission documents an empty response, unlike all other methods.
      let body;
      try { body = await response.text(); } catch { throw new Error(`${label} response could not be read. Check store status before retrying.`); }
      if (!body.trim()) return {};
      try {
        const empty = JSON.parse(body);
        if (empty && typeof empty === 'object' && !Array.isArray(empty) && Object.keys(empty).length === 0) return {};
      } catch {}
      throw new Error(`${label} returned unexpected data. Check store status before retrying.`);
    }
    let data;
    try { data = await response.json(); } catch { throw new Error(`${label} returned invalid JSON.`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label} returned invalid data.`);
    return data;
  }

  if (suppliedToken) {
    // CI supplies only a short-lived, chromewebstore-scoped WIF token. Never
    // fall back to a stored refresh token when an explicitly supplied token fails.
    token = env.CHROME_ACCESS_TOKEN;
  } else {
    // Explicit OAuth mode for local operators or an OAuth-configured release.
    const authorization = await request('OAuth token refresh', 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.CHROME_CLIENT_ID,
        client_secret: env.CHROME_CLIENT_SECRET, refresh_token: env.CHROME_REFRESH_TOKEN }),
    });
    token = authorization.access_token;
  }
  if (typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error('A valid OAuth access token is required.');
  const headers = { Authorization: `Bearer ${token}` };

  async function fetchStatus(timeoutMs) {
    const status = await request('Fetch store status', `${endpoint}:fetchStatus`, { headers }, timeoutMs);
    if (status.name !== name || status.itemId !== env.CHROME_EXTENSION_ID) throw new Error('Store returned a different item identity.');
    return status;
  }
  function report(event, status, extra = {}) {
    const result = { event, itemId: env.CHROME_EXTENSION_ID, requestedVersion: version, ...summarize(status), ...extra };
    log(JSON.stringify(result));
    return result;
  }
  const initial = await fetchStatus();
  report('initial-status', initial);
  if (publishStaged) {
    const alreadyPublished = status => status.publishedItemRevisionStatus?.state === 'PUBLISHED'
      && matchesExactVersion(status.publishedItemRevisionStatus, expectedStagedVersion);
    const assertPublicationTarget = status => {
      if (status.takenDown || status.warned || IN_PROGRESS.has(status.lastAsyncUploadState)) {
        throw new Error('Store policy or upload state requires inspection; no staged publication was performed.');
      }
      if (alreadyPublished(status)) return;
      const published = status.publishedItemRevisionStatus;
      if (published && (!['PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(published.state)
        || !Array.isArray(published.distributionChannels) || !published.distributionChannels.length
        || published.distributionChannels.some(channel => !validExpectedVersion(channel?.crxVersion)))) {
        throw new Error('Published version is unknown; no staged publication was performed.');
      }
      if (versions(published).some(current => compareVersions(current, expectedStagedVersion) >= 0)) {
        throw new Error('The expected version or a newer version is already published in a different state; no staged publication was performed.');
      }
      if (status.submittedItemRevisionStatus?.state !== 'STAGED'
        || !matchesExactVersion(status.submittedItemRevisionStatus, expectedStagedVersion)) {
        throw new Error('The approved staged item does not exactly match the expected version; no staged publication was performed.');
      }
    };
    assertPublicationTarget(initial);
    if (alreadyPublished(initial)) return report('already-published-no-changes', initial);
    // Google supplies no atomic version/etag precondition. Serialize workflows,
    // re-read immediately before the one mutation, and avoid dashboard edits.
    const preflight = await fetchStatus();
    assertPublicationTarget(preflight);
    if (alreadyPublished(preflight)) return report('already-published-no-changes', preflight);
    report('staged-publication-preflight', preflight);
    const result = await request('Publish approved staged item', `${endpoint}:publish`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }),
    });
    if (result.name !== name || result.itemId !== env.CHROME_EXTENSION_ID || result.state !== 'PUBLISHED') {
      throw new Error('Staged publication returned an unexpected response. Check --status before proceeding; publication was not retried.');
    }
    log(JSON.stringify({ event: 'staged-publication-accepted', itemId: env.CHROME_EXTENSION_ID,
      requestedVersion: version, state: result.state }));
    for (let poll = 0; poll <= maxPolls; poll++) {
      let status;
      try { status = await fetchStatus(); }
      catch { throw new Error('Staged publication was accepted but status confirmation failed. Check --status before proceeding; do not automatically retry publication.'); }
      if (status.takenDown || status.warned || IN_PROGRESS.has(status.lastAsyncUploadState)) {
        throw new Error('Store policy or upload state changed after staged publication. Inspect --status before proceeding.');
      }
      if (alreadyPublished(status)) return report('staged-publication-confirmed', status);
      // Waiting is read-only; a changed item or another submission is not success.
      try { assertPublicationTarget(status); }
      catch { throw new Error('Store state changed after staged publication. Inspect --status before proceeding; publication was not retried.'); }
      if (poll < maxPolls) await sleep(pollIntervalMs);
    }
    throw new Error('Staged publication was accepted but the expected published version is not confirmed. Check --status before proceeding; publication was not retried.');
  }
  if (cancelReview) {
    const matchesExpectedVersion = revision => matchesExactVersion(revision, expectedPendingVersion);
    const assertCancellationTarget = status => {
      if (status.takenDown || status.warned || IN_PROGRESS.has(status.lastAsyncUploadState)) {
        throw new Error('Store policy or upload state requires inspection; no cancellation was performed.');
      }
      if (status.submittedItemRevisionStatus?.state !== 'PENDING_REVIEW'
        || !matchesExpectedVersion(status.submittedItemRevisionStatus)) {
        throw new Error('The active pending review does not exactly match the expected version; no cancellation was performed.');
      }
      if (versions(status.publishedItemRevisionStatus).some(current => compareVersions(current, expectedPendingVersion) >= 0)) {
        throw new Error('The expected review version or a newer version is already published; no cancellation was performed.');
      }
    };
    assertCancellationTarget(initial);
    // The API exposes no version/etag precondition. Re-read immediately before
    // the single mutation; CI serializes this with every other store operation.
    // Operators must also avoid changing this item in the dashboard concurrently.
    const preflight = await fetchStatus();
    assertCancellationTarget(preflight);
    const publishedBefore = JSON.stringify(preflight.publishedItemRevisionStatus ?? null);
    report('cancellation-preflight', preflight);
    await request('Cancel pending review', `${endpoint}:cancelSubmission`, { method: 'POST', headers }, 15000, true);
    log(JSON.stringify({ event: 'cancellation-accepted', itemId: env.CHROME_EXTENSION_ID, requestedVersion: version }));
    // Never retry the mutation. Only bounded read-only status polling follows.
    for (let poll = 0; poll <= maxPolls; poll++) {
      let status;
      try { status = await fetchStatus(); }
      catch { throw new Error('Cancellation was accepted but status confirmation failed. Check --status before proceeding; do not automatically retry cancellation.'); }
      if (JSON.stringify(status.publishedItemRevisionStatus ?? null) !== publishedBefore) {
        throw new Error('Published store state changed during cancellation. Inspect --status before proceeding.');
      }
      const pending = status.submittedItemRevisionStatus;
      if (!pending || (pending.state === 'CANCELLED' && matchesExpectedVersion(pending))) {
        return report('cancellation-confirmed', status);
      }
      if (pending.state !== 'PENDING_REVIEW' || !matchesExpectedVersion(pending)) {
        throw new Error('Submitted store state changed during cancellation. Inspect --status before proceeding.');
      }
      if (poll < maxPolls) await sleep(pollIntervalMs);
    }
    throw new Error('Cancellation was accepted but the expected review is still pending. Check --status before proceeding; cancellation was not retried.');
  }
  if (!submit) return report('status-only-no-changes', initial);
  if (initial.takenDown || initial.warned) throw new Error('Store policy warning or takedown requires manual resolution before submission.');
  if (IN_PROGRESS.has(initial.lastAsyncUploadState)) throw new Error('An upload is already in progress; no additional upload was started.');

  const pending = initial.submittedItemRevisionStatus;
  if (pending && !KNOWN_STATES.has(pending.state)) throw new Error('Unrecognized submitted item state; inspect the dashboard before proceeding.');
  if (pending && ACTIVE_STATES.has(pending.state)) {
    if (versions(pending).some(current => compareVersions(current, version) === 0)) return report('already-submitted-no-changes', initial);
    throw new Error('A different or unidentified version has an active submission; no upload or cancellation was performed.');
  }
  const published = initial.publishedItemRevisionStatus;
  if (published && (!KNOWN_STATES.has(published.state) || !versions(published).length)) throw new Error('Published version is unknown; inspect the dashboard before proceeding.');
  if (versions(published).some(current => compareVersions(current, version) > 0)) throw new Error('Refusing to upload an older version than the published item.');
  if (versions(published).some(current => compareVersions(current, version) === 0)) return report('already-published-no-changes', initial);

  const upload = await request('Upload store package', `${API}/upload/v2/${name}:upload`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: zipBytes,
  }, 60000);
  if (upload.name !== name || upload.itemId !== env.CHROME_EXTENSION_ID) throw new Error('Upload returned a different item identity; submission was not requested.');
  if ((upload.uploadState === 'SUCCEEDED' || upload.crxVersion !== undefined)
    && (typeof upload.crxVersion !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(upload.crxVersion)
    || compareVersions(upload.crxVersion, version) !== 0)) throw new Error('Uploaded version is missing or differs from the ZIP; submission was not requested.');
  let uploadState = upload.uploadState;
  const deadline = now() + uploadDeadlineMs;
  let status = initial;
  for (let poll = 0; IN_PROGRESS.has(uploadState) && poll < maxPolls; poll++) {
    if (now() + pollIntervalMs >= deadline) break;
    await sleep(pollIntervalMs);
    const remaining = deadline - now();
    if (remaining <= 0) break;
    status = await fetchStatus(Math.min(15000, remaining));
    uploadState = status.lastAsyncUploadState;
    report('upload-status', status);
  }
  if (uploadState !== 'SUCCEEDED') throw new Error('Upload failed, remained pending, or returned an unknown state; submission was not requested. Check status before retrying.');
  // Recheck state immediately before publishing so another operator's active
  // submission or a policy warning cannot be silently overwritten.
  status = await fetchStatus();
  if (status.takenDown || status.warned || IN_PROGRESS.has(status.lastAsyncUploadState)) throw new Error('Store state changed after upload; inspect the dashboard before submission.');
  if (status.submittedItemRevisionStatus && !KNOWN_STATES.has(status.submittedItemRevisionStatus.state)) throw new Error('Unrecognized submitted item state after upload; inspect the dashboard before proceeding.');
  if (status.submittedItemRevisionStatus && ACTIVE_STATES.has(status.submittedItemRevisionStatus.state)) {
    if (versions(status.submittedItemRevisionStatus).some(current => compareVersions(current, version) === 0)) return report('already-submitted-no-changes', status);
    throw new Error('Another submission became active after upload; submission was not requested.');
  }
  const publishedResult = await request('Submit for review', `${endpoint}:publish`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'STAGED_PUBLISH', skipReview: false, blockOnWarnings: true }),
  });
  if (publishedResult.name !== name || publishedResult.itemId !== env.CHROME_EXTENSION_ID
    || !ACTIVE_STATES.has(publishedResult.state)) throw new Error('Submission returned an unexpected response; inspect store status before retrying.');
  log(JSON.stringify({ event: 'submission-accepted', itemId: env.CHROME_EXTENSION_ID, requestedVersion: version, state: publishedResult.state,
    approved: publishedResult.state === 'STAGED', stagedPublication: true,
    note: 'Google controls review and approval. An approved staged version requires a separate explicit publication.' }));
  // Preserve the confirmed submission result if the read-only follow-up fails.
  try { return report('final-status', await fetchStatus(), { submissionState: publishedResult.state }); }
  catch { return { event: 'submission-accepted-status-unavailable', state: publishedResult.state, requestedVersion: version }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, argument, ...extra] = process.argv.slice(2);
    if (extra.length || !['--status', '--submit', '--cancel-review', '--publish-staged'].includes(mode) || (mode === '--status' ? argument : !argument)) {
      throw new Error('Usage: node tools/publish-chrome-web-store.mjs --status | --submit <package.zip> | --cancel-review <expected-pending-version> | --publish-staged <expected-staged-version>');
    }
    const result = await runPublisher({ submit: mode === '--submit', cancelReview: mode === '--cancel-review', publishStaged: mode === '--publish-staged',
      expectedPendingVersion: mode === '--cancel-review' ? argument : undefined,
      expectedStagedVersion: mode === '--publish-staged' ? argument : undefined,
      zipBytes: mode === '--submit' ? await fs.readFile(argument) : undefined });
    if (result.event === 'submission-accepted-status-unavailable') console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
