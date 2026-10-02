import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readStorePackage } from './validate-store-package.mjs';

// Official API v2 only. Mutations are never automatically retried: after an
// ambiguous network failure, inspect --status before deciding to run again.
// https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish
const API = 'https://chromewebstore.googleapis.com';
const REQUIRED_ENV = ['CHROME_EXTENSION_ID', 'CHROME_PUBLISHER_ID', 'CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN'];
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

function versions(revision) {
  return (revision?.distributionChannels || []).map(channel => channel.crxVersion).filter(value => typeof value === 'string' && /^\d+(?:\.\d+){0,3}$/.test(value));
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

export async function runPublisher({ env = process.env, submit = false, zipBytes,
  fetchImpl = globalThis.fetch, sleep = delay, now = Date.now, log = console.log,
  pollIntervalMs = 5000, maxPolls = 24, uploadDeadlineMs = 180000 } = {}) {
  const missing = REQUIRED_ENV.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}.`);
  if (!/^[a-p]{32}$/.test(env.CHROME_EXTENSION_ID) || !/^[A-Za-z0-9_-]+$/.test(env.CHROME_PUBLISHER_ID)) throw new Error('Invalid Chrome item or publisher ID.');
  const version = submit ? readStorePackage(zipBytes).manifest.version : null;
  const name = `publishers/${env.CHROME_PUBLISHER_ID}/items/${env.CHROME_EXTENSION_ID}`;
  const endpoint = `${API}/v2/${name}`;
  let token;

  async function request(label, url, options = {}, timeoutMs = 15000) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new Error(`${label} request failed or timed out; no automatic retry. Check store status before retrying a submission.`);
    }
    // Do not echo response bodies, OAuth data, HTTP headers or provider error
    // descriptions: these can contain credentials or publisher-only metadata.
    if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}). Check the Chrome Web Store dashboard or OAuth configuration.`);
    let data;
    try { data = await response.json(); } catch { throw new Error(`${label} returned invalid JSON.`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label} returned invalid data.`);
    return data;
  }

  const authorization = await request('OAuth token refresh', 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.CHROME_CLIENT_ID,
      client_secret: env.CHROME_CLIENT_SECRET, refresh_token: env.CHROME_REFRESH_TOKEN }),
  });
  token = authorization.access_token;
  if (typeof token !== 'string' || !token) throw new Error('OAuth response did not contain an access token.');
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
  if (upload.crxVersion && (typeof upload.crxVersion !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(upload.crxVersion)
    || compareVersions(upload.crxVersion, version) !== 0)) throw new Error('Uploaded version differs from the ZIP; submission was not requested.');
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
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }),
  });
  if (publishedResult.name !== name || publishedResult.itemId !== env.CHROME_EXTENSION_ID
    || !ACTIVE_STATES.has(publishedResult.state)) throw new Error('Submission returned an unexpected response; inspect store status before retrying.');
  log(JSON.stringify({ event: 'submission-accepted', itemId: env.CHROME_EXTENSION_ID, requestedVersion: version, state: publishedResult.state,
    approved: publishedResult.state === 'PUBLISHED', note: 'Google controls review and approval; accepted does not imply approved.' }));
  // Preserve the confirmed submission result if the read-only follow-up fails.
  try { return report('final-status', await fetchStatus(), { submissionState: publishedResult.state }); }
  catch { return { event: 'submission-accepted-status-unavailable', state: publishedResult.state, requestedVersion: version }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, archive, ...extra] = process.argv.slice(2);
    if (extra.length || !['--status', '--submit'].includes(mode) || (mode === '--submit' ? !archive : archive)) {
      throw new Error('Usage: node tools/publish-chrome-web-store.mjs --status | --submit <package.zip>');
    }
    const result = await runPublisher({ submit: mode === '--submit', zipBytes: archive ? await fs.readFile(archive) : undefined });
    if (result.event === 'submission-accepted-status-unavailable') console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
