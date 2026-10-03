import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ACCOUNT_ID = '746a45a10fa0fc109de9f77a9955349c';
export const WORKER = 'watchparty';
export const ORIGIN = 'https://watchparty.mertd.me';
const REPO = 'MertD95/watchparty';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`;
const PUBLIC_HANDLER_NAMES = new Set(['fetch', 'scheduled', 'alarm', 'queue', 'email', 'tail', 'trace', 'connect', 'test']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => value != null && value !== false && value !== '' &&
  (!Array.isArray(value) || value.length > 0) && (!isObject(value) || Object.keys(value).length > 0);
const stable = value => Array.isArray(value) ? value.map(stable) : isObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

// Fingerprint-only defaults from Wrangler 4.147.0 normalizeObservability in
// @cloudflare/deploy-helpers/src/deploy/helpers/config-diffs.ts. Never emit these
// defaults as configuration: omitted nested fields can inherit parent values.
// Keep unknown fields in the fingerprint, but reject them before deployment.
function normalizeObservability(value, blockers) {
  if (value != null && !isObject(value)) {
    blockers.push('unrecognized observability settings');
    return value;
  }
  const enabled = value?.enabled === true;
  const defaults = { enabled, head_sampling_rate: 1, redact_query_string: false,
    logs: { enabled, head_sampling_rate: 1, invocation_logs: true, persist: true },
    traces: { enabled: false, persist: true, head_sampling_rate: 1 } };
  if (value?.head_sampling_rate !== undefined && value.head_sampling_rate !== 1) {
    // A comparison helper's default is not proof that an omitted nested rate
    // is equivalent to an explicit rate when a parent rate is non-default.
    // Preserve that distinction until a real remote representation is reviewed.
    delete defaults.logs.head_sampling_rate;
    delete defaults.traces.head_sampling_rate;
  }
  const result = structuredClone(value ?? {});
  const fill = (target, fallback) => {
    for (const [key, defaultValue] of Object.entries(fallback)) {
      if (target[key] === undefined) target[key] = structuredClone(defaultValue);
      else if (isObject(defaultValue) && isObject(target[key])) fill(target[key], defaultValue);
    }
  };
  fill(result, defaults);
  const allowed = { root: new Set(['enabled', 'head_sampling_rate', 'redact_query_string', 'logs', 'traces', 'issues']),
    logs: new Set(['enabled', 'head_sampling_rate', 'invocation_logs', 'persist', 'destinations']),
    traces: new Set(['enabled', 'head_sampling_rate', 'persist', 'destinations']), issues: new Set(['enabled']) };
  for (const [section, fields] of [['root', result], ['logs', result.logs], ['traces', result.traces], ['issues', result.issues]]) {
    if (fields === undefined) continue;
    if (!isObject(fields)) { blockers.push(`unrecognized observability ${section} settings`); continue; }
    for (const [key, setting] of Object.entries(fields)) {
      if (!allowed[section].has(key)) { blockers.push(`unsupported observability ${section} setting: ${key}`); continue; }
      if (['enabled', 'redact_query_string', 'invocation_logs', 'persist'].includes(key) && typeof setting !== 'boolean') {
        blockers.push(`invalid observability ${section} setting: ${key}`);
      }
      if (key === 'head_sampling_rate' && (typeof setting !== 'number' || !Number.isFinite(setting) || setting < 0 || setting > 1)) {
        blockers.push(`invalid observability ${section} sampling rate`);
      }
      if (key === 'destinations' && (!Array.isArray(setting) || setting.some(item => typeof item !== 'string'))) {
        blockers.push(`invalid observability ${section} destinations`);
      }
    }
  }
  return result;
}

export function verifySource({ repository, event, ref, sha, head, remoteMain }) {
  if (repository !== REPO || !['push', 'workflow_dispatch'].includes(event) || ref !== 'refs/heads/main') {
    throw new Error('Website deployment requires the trusted repository and main branch.');
  }
  if (!/^[a-f0-9]{40}$/.test(sha || '') || sha !== head || sha !== remoteMain) {
    throw new Error('Stale or mismatched source: dispatch a fresh run for current main.');
  }
  return sha;
}

function verifyCurrentSource(env = process.env) {
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const remote = git(['ls-remote', 'https://github.com/MertD95/watchparty.git', 'refs/heads/main']);
  return verifySource({ repository: env.GITHUB_REPOSITORY, event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF, sha: env.GITHUB_SHA, head: git(['rev-parse', 'HEAD']),
    remoteMain: remote.split(/\s+/)[0] });
}

export function validatePolicy(policy) {
  if (!isObject(policy) || policy.accountId !== ACCOUNT_ID || policy.workerName !== WORKER ||
    policy.origin !== ORIGIN || policy.assetsDirectory !== 'landing' || policy.wranglerVersion !== '4.147.0' ||
    Object.keys(policy).length !== 5) throw new Error('Unexpected production website identity or deployment policy.');
}

// Never return API error bodies, script source, variable values, or auth tokens
// to Actions logs. Inspection is deliberately read-only, including on errors.
async function getJson(url, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch { throw new Error('Cloudflare read failed; no deployment was attempted.'); }
  let body;
  try { body = await response.json(); } catch { throw new Error(`Cloudflare returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok || body.success !== true) throw new Error(`Cloudflare read was rejected (HTTP ${response.status}). Check token permissions.`);
  return body.result;
}

export async function inspectWorker({ token, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Set CLOUDFLARE_API_TOKEN in the cloudflare-production environment.');
  // Same specific-Worker endpoint used by Wrangler's preUploadApiChecks. Do
  // not enumerate account Workers: per-Worker Editor credentials must work.
  const service = await getJson(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/services/${WORKER}`, token, fetchImpl);
  if (service?.id !== WORKER || !isObject(service.default_environment?.script)) {
    throw new Error('The existing watchparty Worker metadata was not recognized; no Worker will be created.');
  }
  const metadata = { ...service.default_environment.script, id: service.id };
  const settings = await getJson(`${API}/${WORKER}/settings`, token, fetchImpl);
  const subdomain = await getJson(`${API}/${WORKER}/subdomain`, token, fetchImpl);
  let response;
  try {
    response = await fetchImpl(`${API}/${WORKER}/content/v2`, { method: 'GET',
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch { throw new Error('Unable to inspect existing Worker content safely.'); }
  const body = await response.text();
  let content = { kind: 'custom-or-unknown', status: response.status, bytes: Buffer.byteLength(body) };
  if ((response.ok && !body.trim()) || response.status === 204) content = { kind: 'empty', status: response.status, bytes: 0 };
  else if (response.status === 404) {
    // Assets-only Workers have no downloadable user script. Require the
    // specific missing-script API code, plus independent metadata checks below.
    try {
      const error = JSON.parse(body);
      if (error.success === false && error.errors?.length === 1 && error.errors[0].code === 10007) {
        content = { kind: 'no-user-script', status: 404, bytes: 0 };
      }
    } catch { /* Unknown 404 remains blocked. */ }
  }
  return { metadata, settings, subdomain, content };
}

// Approved fingerprints describe stable configuration, never version IDs,
// modified timestamps, asset upload JWTs/hashes, annotations, or asset sizes.
// Replacing only landing files therefore does not require updating the pin.
export function buildPlan(snapshot, assetsDirectory = path.join(ROOT, 'landing')) {
  const { metadata = {}, settings = {}, subdomain = {}, content = {} } = snapshot || {};
  const blockers = [];
  if (metadata.id !== WORKER || metadata.has_assets !== true || metadata.has_modules !== false) {
    blockers.push('metadata does not confirm an existing assets-only Worker');
  }
  // Observed assets-only Workers expose the platform's fetch handler despite
  // having no user script. Wrangler's /content/v2 reader covers both classic
  // and module scripts; allow this exact shape only after the independent
  // empty-content, asset, binding and named-handler checks all agree.
  const platformAssetFetch = Array.isArray(metadata.handlers) && metadata.handlers.length === 1
    && metadata.handlers[0] === 'fetch' && metadata.has_assets === true && metadata.has_modules === false
    && content.kind === 'empty' && content.status === 204 && content.bytes === 0
    && Array.isArray(settings.bindings) && settings.bindings.length === 0 && !nonempty(metadata.named_handlers);
  if (!Array.isArray(metadata.handlers) || (metadata.handlers.length > 0 && !platformAssetFetch)) {
    blockers.push('Worker has custom runtime handlers');
  }
  if (nonempty(metadata.named_handlers)) blockers.push('Worker has named runtime handlers');
  if (!['empty', 'no-user-script'].includes(content.kind)) blockers.push('Worker contains custom or unrecognized source');
  if (!isObject(settings)) blockers.push('unrecognized settings shape');
  if (!Array.isArray(settings.bindings) || settings.bindings.length) blockers.push('Worker bindings require an explicit reviewed migration');
  if (typeof subdomain.enabled !== 'boolean' || typeof subdomain.previews_enabled !== 'boolean') blockers.push('unknown workers.dev settings');
  const configurable = ['compatibility_date', 'compatibility_flags', 'usage_model', 'logpush', 'observability', 'tail_consumers', 'placement', 'limits'];
  const known = new Set([...configurable, 'bindings', 'annotations', 'migration_tag', 'tags', 'assets']);
  for (const key of Object.keys(settings)) if (!known.has(key) && nonempty(settings[key])) blockers.push(`unsupported setting: ${key}`);
  for (const key of ['migration_tag', 'tags']) if (nonempty(settings[key])) blockers.push(`unsupported setting: ${key}`);
  if (nonempty(settings.tail_consumers)) blockers.push('tail consumers require a reviewed migration');

  const config = { name: WORKER, account_id: ACCOUNT_ID, keep_vars: true, send_metrics: false,
    workers_dev: subdomain.enabled, preview_urls: subdomain.previews_enabled,
    assets: { directory: assetsDirectory, html_handling: 'auto-trailing-slash', not_found_handling: 'none' } };
  const normalizedSettings = { compatibility_date: settings.compatibility_date || '2026-10-03',
    compatibility_flags: settings.compatibility_flags ?? [], usage_model: settings.usage_model ?? 'standard',
    logpush: settings.logpush ?? false, observability: normalizeObservability(settings.observability, blockers),
    tail_consumers: settings.tail_consumers ?? [], placement: settings.placement ?? { mode: 'off' },
    limits: settings.limits ?? null };
  // Wrangler 4 no longer supports usage_model in configuration. An older
  // nonstandard plan must be inspected instead of silently changing it.
  if (normalizedSettings.usage_model !== 'standard') blockers.push('nonstandard usage model requires a reviewed migration');
  for (const key of configurable) if (key !== 'usage_model' && normalizedSettings[key] != null) config[key] = normalizedSettings[key];
  // Preserve the exact validated remote object instead of expanding defaults.
  // E.g. parent head_sampling_rate:0.1 must not gain an explicit nested rate:1.
  config.observability = structuredClone(settings.observability ?? { enabled: false });
  if (config.compatibility_date && !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date)) blockers.push('unrecognized compatibility date');
  if (config.compatibility_flags && (!Array.isArray(config.compatibility_flags) || config.compatibility_flags.some(flag => typeof flag !== 'string'))) blockers.push('unrecognized compatibility flags');
  // Runtime bindings and routing code are intentionally not inferred from the
  // dashboard. Unknown assets options block rather than being discarded.
  if (settings.assets != null) {
    const enveloped = isObject(settings.assets) && Object.hasOwn(settings.assets, 'config');
    if (enveloped) {
      for (const [key, value] of Object.entries(settings.assets)) {
        if (!['config', 'jwt', 'hash', 'manifest'].includes(key) && nonempty(value)) {
          blockers.push(`unsupported outer asset configuration: ${key}`);
        }
      }
    }
    const assetOptions = enveloped ? settings.assets.config : settings.assets;
    if (!isObject(assetOptions)) blockers.push('unrecognized assets configuration');
    else for (const [key, value] of Object.entries(assetOptions)) {
      if (['html_handling', 'not_found_handling'].includes(key)) {
        if (value !== config.assets[key]) blockers.push(`non-default asset routing: ${key}`);
      } else if (!['jwt', 'hash', 'manifest', 'redirects', 'headers'].includes(key) && nonempty(value)) {
        blockers.push(`unsupported asset configuration: ${key}`);
      } else if (['redirects', 'headers'].includes(key) && nonempty(value)) {
        blockers.push(`remote asset ${key} require an explicit reviewed migration`);
      }
    }
  }
  // Canonicalize absent/default forms returned by different Workers API versions.
  const fingerprint = { worker: WORKER, account: ACCOUNT_ID, assetsOnly: metadata.has_assets === true && metadata.has_modules === false,
    settings: normalizedSettings, bindings: settings.bindings, subdomain: { enabled: subdomain.enabled, previews_enabled: subdomain.previews_enabled },
    assetRouting: { html_handling: config.assets.html_handling, not_found_handling: config.assets.not_found_handling } };
  return { config, blockers, fingerprint: sha256(JSON.stringify(stable(fingerprint))), summary: {
    worker: WORKER, account: ACCOUNT_ID, hasAssets: metadata.has_assets === true, hasModules: metadata.has_modules,
    contentKind: content.kind, contentStatus: content.status, contentBytes: content.bytes,
    runtimeHandlers: Array.isArray(metadata.handlers) ? metadata.handlers.filter(name => PUBLIC_HANDLER_NAMES.has(name)) : [],
    unknownHandlerCount: Array.isArray(metadata.handlers) ? metadata.handlers.filter(name => !PUBLIC_HANDLER_NAMES.has(name)).length : null,
    handlerShapeRecognized: Array.isArray(metadata.handlers),
    hasNamedHandlers: nonempty(metadata.named_handlers),
    platformAssetFetch,
    bindingCount: Array.isArray(settings.bindings) ? settings.bindings.length : null,
    settingKeys: Object.keys(settings).sort(), workersDev: subdomain.enabled, previewUrls: subdomain.previews_enabled,
  } };
}

export function authorizePlan(plan, env) {
  if (env.CLOUDFLARE_DEPLOY_ENABLED !== 'true' || env.CLOUDFLARE_BUILDS_DISCONNECTED !== 'true' ||
    env.CLOUDFLARE_ASSETS_ONLY_CONFIRMED !== 'true') {
    throw new Error('Deployment is disabled until inspection, assets-only confirmation, and Workers Builds disconnection are complete.');
  }
  if (plan.blockers.length) throw new Error(`Unsafe Worker migration blocked: ${plan.blockers.join('; ')}.`);
  if (!/^[a-f0-9]{64}$/.test(env.CLOUDFLARE_EXPECTED_SETTINGS_SHA256 || '') ||
    env.CLOUDFLARE_EXPECTED_SETTINGS_SHA256 !== plan.fingerprint) {
    throw new Error('Existing Worker settings changed or have not been approved. Run inspect and review before updating the settings fingerprint.');
  }
}

export function readAssets(directory = path.join(ROOT, 'landing')) {
  const root = realpathSync(directory), files = [];
  for (const name of readdirSync(root).sort()) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith('.')) throw new Error('Unexpected website asset name.');
    const target = path.join(root, name);
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) throw new Error('Website upload accepts only ordinary files, not links or nested directories.');
    if (path.dirname(realpathSync(target)) !== root) throw new Error('Website asset escaped the landing directory.');
    if (!/\.(?:html|css|js|svg|png|ico|webp|txt|json)$/.test(name) && !['_redirects', '_headers'].includes(name)) throw new Error('Unexpected website asset type.');
    const bytes = readFileSync(target);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Website asset exceeds the 5 MiB safety limit.');
    files.push({ name, bytes, hash: sha256(bytes) });
  }
  if (!files.some(file => file.name === 'index.html') || !files.some(file => file.name === 'privacy.html')) throw new Error('Required website pages are missing.');
  return files;
}

export async function verifyLive({ files = readAssets(), fetchImpl = fetch } = {}) {
  const cases = files.filter(file => !file.name.startsWith('_')).map(file => ({
    path: file.name === 'index.html' ? '/' : file.name === 'privacy.html' ? '/privacy' : `/${file.name}`, hash: file.hash,
  }));
  cases.push({ path: '/r/deployment-check', hash: files.find(file => file.name === 'index.html').hash });
  for (const item of cases) {
    let response;
    try { response = await fetchImpl(`${ORIGIN}${item.path}`, { redirect: 'error', cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error(`Live website verification failed for ${item.path}.`); }
    if (response.status !== 200 || sha256(Buffer.from(await response.arrayBuffer())) !== item.hash) {
      throw new Error(`Live website does not match this commit at ${item.path}. No automatic rollback was attempted.`);
    }
  }
  const missing = await fetchImpl(`${ORIGIN}/__watchparty_deployment_missing__`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (missing.status !== 404) throw new Error('Live website unknown-path behavior changed.');
  return { matchedPaths: cases.length, missingPath: 404 };
}

async function main() {
  const mode = process.argv[2];
  if (!['source', 'inspect', 'prepare', 'verify'].includes(mode)) throw new Error('Use source, inspect, prepare, or verify.');
  validatePolicy(JSON.parse(readFileSync(path.join(ROOT, 'cloudflare/production.json'), 'utf8')));
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT_ID) throw new Error('Unexpected Cloudflare account.');
  if (mode === 'source') { verifyCurrentSource(); console.log('Trusted current-main website source verified.'); return; }
  if (mode === 'verify') { console.log(JSON.stringify(await verifyLive())); return; }
  verifyCurrentSource();
  const plan = buildPlan(await inspectWorker({ token: process.env.CLOUDFLARE_API_TOKEN }));
  const report = { ...plan.summary, settingsSha256: plan.fingerprint, eligible: !plan.blockers.length, blockers: plan.blockers };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Cloudflare ${mode}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  if (mode === 'inspect') return;
  authorizePlan(plan, process.env);
  readAssets();
  const directory = path.join(ROOT, 'dist/cloudflare');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'wrangler.json'), `${JSON.stringify(plan.config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Prepared an assets-only configuration preserving audited workers.dev and runtime settings. Routes and DNS are unmanaged.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
