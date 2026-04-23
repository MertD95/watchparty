// WatchParty for Stremio — Background Service Worker
// Manages: Stremio server detection, popup communication, profile sync, badge.
// NOTE: WebSocket connection lives in stremio-content.js (not here) to avoid MV3 suspension issues.

// Load shared constants (service workers don't get content_scripts injection)
importScripts('wp-actions.js');
importScripts('constants.js');
importScripts('runtime-state.js');
importScripts('room-keys.js');
importScripts('wp-protocol.js');

const BG_VERSION = chrome.runtime.getManifest().version;
const STREMIO_BASE = 'http://localhost:11470';
const STREMIO_API = 'https://api.strem.io';
const POLL_INTERVAL_MS = 5000;
const STREMIO_WEB_URLS = ['https://web.stremio.com/*', 'https://web.strem.io/*', 'https://app.strem.io/*'];
const WATCHPARTY_URLS = ['https://watchparty.mertd.me/*', 'http://localhost:8080/*', 'http://localhost:8090/*', 'http://127.0.0.1:8080/*', 'http://127.0.0.1:8090/*'];
const STREMIO_WEB_ORIGINS = new Set(['https://web.stremio.com', 'https://web.strem.io', 'https://app.strem.io']);
const WATCHPARTY_ORIGINS = new Set(['https://watchparty.mertd.me', 'http://localhost:8080', 'http://localhost:8090', 'http://127.0.0.1:8080', 'http://127.0.0.1:8090']);

// --- State ---
let stremioRunning = false;
let stremioSettings = null;
const stats = { bytesProxied: 0, requestsProxied: 0, lastLatencyMs: 0 };
const knownStremioTabIds = new Set();
const knownWatchPartyTabIds = new Set();
let offscreenDocumentPromise = null;
const COORDINATOR_EVENT_LOG_LIMIT = 20;
const coordinatorState = {
  room: null,
  userId: null,
  sessionId: null,
  mode: WPConstants.COORDINATOR_MODE.IDLE,
  bootstrapPending: false,
  wsConnected: false,
  activeBackend: null,
  activeBackendUrl: null,
  controllerTabId: null,
  controllerRuntime: null,
  adapterState: null,
  invariants: [],
  recentEvents: [],
  updatedAt: 0,
};

function pushCoordinatorEvent(type, details = null) {
  coordinatorState.recentEvents = [
    ...coordinatorState.recentEvents,
    {
      type,
      at: Date.now(),
      details: details && typeof details === 'object' ? structuredClone(details) : details,
    },
  ].slice(-COORDINATOR_EVENT_LOG_LIMIT);
}

function deriveCoordinatorInvariants(state) {
  const issues = [];
  if (state.wsConnected && state.controllerTabId == null) {
    issues.push({ code: 'ws_without_controller', severity: 'error', message: 'Coordinator reports a live socket without a controller tab.' });
  }
  if (state.room?.id && !state.sessionId) {
    issues.push({ code: 'room_without_session', severity: 'error', message: 'Coordinator holds room state before session identity is known.' });
  }
  if (state.controllerRuntime?.isControllerTab === false && state.wsConnected) {
    issues.push({ code: 'controller_runtime_mismatch', severity: 'warn', message: 'Coordinator runtime reports a disconnected controller while wsConnected is true.' });
  }
  if (Array.isArray(state.controllerRuntime?.invariants)) {
    for (const invariant of state.controllerRuntime.invariants) {
      issues.push({ ...invariant, source: 'controller-runtime' });
    }
  }
  if (Array.isArray(state.adapterState?.invariants)) {
    for (const invariant of state.adapterState.invariants) {
      issues.push({ ...invariant, source: 'adapter-runtime' });
    }
  }
  return issues;
}

function refreshCoordinatorDiagnostics() {
  coordinatorState.invariants = deriveCoordinatorInvariants(coordinatorState);
  return coordinatorState.invariants;
}

function deriveCoordinatorModeFromState(state) {
  if (state.bootstrapPending) return WPConstants.COORDINATOR_MODE.BOOTSTRAP_PENDING;
  if (state.controllerTabId != null && state.wsConnected) {
    return WPConstants.COORDINATOR_MODE.CONTROLLER_ACTIVE;
  }
  if (state.controllerTabId != null && state.room?.id) {
    return WPConstants.COORDINATOR_MODE.CONTROLLER_RECOVERING;
  }
  if (state.controllerTabId != null) {
    return WPConstants.COORDINATOR_MODE.CONTROLLER_CLAIMING;
  }
  if (state.room?.id) {
    return WPConstants.COORDINATOR_MODE.CONTROLLER_MISSING;
  }
  return WPConstants.COORDINATOR_MODE.IDLE;
}

function deriveCoordinatorMode() {
  return deriveCoordinatorModeFromState(coordinatorState);
}

function refreshCoordinatorMode() {
  coordinatorState.mode = deriveCoordinatorMode();
  return coordinatorState.mode;
}

function cloneRoomProjection(room) {
  return room && typeof room === 'object'
    ? structuredClone(room)
    : null;
}

function cloneCoordinatorState() {
  refreshCoordinatorMode();
  refreshCoordinatorDiagnostics();
  return {
    room: cloneRoomProjection(coordinatorState.room),
    userId: coordinatorState.userId,
    sessionId: coordinatorState.sessionId,
    mode: coordinatorState.mode,
    bootstrapPending: coordinatorState.bootstrapPending,
    wsConnected: coordinatorState.wsConnected,
    activeBackend: coordinatorState.activeBackend,
    activeBackendUrl: coordinatorState.activeBackendUrl,
    controllerTabId: coordinatorState.controllerTabId,
    controllerRuntime: coordinatorState.controllerRuntime ? structuredClone(coordinatorState.controllerRuntime) : null,
    adapterState: coordinatorState.adapterState ? structuredClone(coordinatorState.adapterState) : null,
    invariants: structuredClone(coordinatorState.invariants),
    recentEvents: structuredClone(coordinatorState.recentEvents),
    updatedAt: coordinatorState.updatedAt,
  };
}

function buildCoordinatorStorageState() {
  refreshCoordinatorMode();
  return {
    [WPConstants.STORAGE.ROOM_STATE]: cloneRoomProjection(coordinatorState.room),
    [WPConstants.STORAGE.USER_ID]: coordinatorState.userId,
    [WPConstants.STORAGE.SESSION_ID]: coordinatorState.sessionId,
    [WPConstants.STORAGE.WS_CONNECTED]: coordinatorState.wsConnected,
    [WPConstants.STORAGE.ACTIVE_BACKEND]: coordinatorState.activeBackend,
    [WPConstants.STORAGE.ACTIVE_BACKEND_URL]: coordinatorState.activeBackendUrl,
    [WPConstants.STORAGE.CONTROLLER_RUNTIME]: coordinatorState.controllerRuntime ? structuredClone(coordinatorState.controllerRuntime) : null,
    [WPConstants.STORAGE.ADAPTER_STATE]: coordinatorState.adapterState ? structuredClone(coordinatorState.adapterState) : null,
    [WPConstants.STORAGE.CURRENT_ROOM]: coordinatorState.room?.id || null,
  };
}

function publishCoordinatorState() {
  const payload = cloneCoordinatorState();
  relayToPanel(WPConstants.ACTION.STATUS_UPDATED, payload);
  broadcastToStremioTabs({ action: WPConstants.ACTION.STATUS_UPDATED, payload });
}

function persistCoordinatorState() {
  return setExtensionState(buildCoordinatorStorageState()).catch(() => {});
}

function clearCoordinatorController(tabId, payload = {}) {
  if (tabId == null || coordinatorState.controllerTabId !== tabId) return false;
  if ('room' in payload) coordinatorState.room = cloneRoomProjection(payload.room);
  if ('userId' in payload) coordinatorState.userId = payload.userId || null;
  if ('sessionId' in payload) coordinatorState.sessionId = payload.sessionId || null;
  if ('controllerRuntime' in payload) coordinatorState.controllerRuntime = payload.controllerRuntime ? structuredClone(payload.controllerRuntime) : null;
  if ('adapterState' in payload) coordinatorState.adapterState = payload.adapterState ? structuredClone(payload.adapterState) : null;
  coordinatorState.controllerTabId = null;
  coordinatorState.wsConnected = false;
  coordinatorState.activeBackend = null;
  coordinatorState.activeBackendUrl = null;
  coordinatorState.updatedAt = Date.now();
  refreshCoordinatorMode();
  refreshCoordinatorDiagnostics();
  pushCoordinatorEvent('controller.released', { tabId });
  persistCoordinatorState();
  publishCoordinatorState();
  return true;
}

function updateCoordinatorState(nextState, sender) {
  const payload = nextState && typeof nextState === 'object' ? nextState : {};
  if ('room' in payload) coordinatorState.room = cloneRoomProjection(payload.room);
  if ('userId' in payload) coordinatorState.userId = payload.userId || null;
  if ('sessionId' in payload) coordinatorState.sessionId = payload.sessionId || null;
  if ('wsConnected' in payload) coordinatorState.wsConnected = payload.wsConnected === true;
  if ('activeBackend' in payload) coordinatorState.activeBackend = payload.activeBackend || null;
  if ('activeBackendUrl' in payload) coordinatorState.activeBackendUrl = payload.activeBackendUrl || null;
  if ('controllerRuntime' in payload) coordinatorState.controllerRuntime = payload.controllerRuntime ? structuredClone(payload.controllerRuntime) : null;
  if ('adapterState' in payload) coordinatorState.adapterState = payload.adapterState ? structuredClone(payload.adapterState) : null;
  if (sender?.tab?.id != null) coordinatorState.controllerTabId = sender.tab.id;
  coordinatorState.updatedAt = Date.now();
  refreshCoordinatorMode();
  refreshCoordinatorDiagnostics();
  pushCoordinatorEvent('session.state.publish', {
    tabId: sender?.tab?.id ?? null,
    roomId: coordinatorState.room?.id || null,
    phase: coordinatorState.controllerRuntime?.phase || null,
    route: coordinatorState.adapterState?.route || null,
  });
  persistCoordinatorState();
  publishCoordinatorState();
}

async function getProjectedRuntimeState() {
  const result = await getExtensionState([
    WPConstants.STORAGE.ROOM_STATE,
    WPConstants.STORAGE.USER_ID,
    WPConstants.STORAGE.SESSION_ID,
    WPConstants.STORAGE.WS_CONNECTED,
    WPConstants.STORAGE.ACTIVE_BACKEND,
    WPConstants.STORAGE.ACTIVE_BACKEND_URL,
    WPConstants.STORAGE.CONTROLLER_RUNTIME,
    WPConstants.STORAGE.ADAPTER_STATE,
    WPConstants.STORAGE.CURRENT_ROOM,
    WPConstants.STORAGE.CONTROLLER_TAB,
    WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
  ]);
  const useCoordinator = coordinatorState.updatedAt > 0;
  const persistedControllerLease = WPConstants.CONTROLLER_TAB_LEASE.normalize(result[WPConstants.STORAGE.CONTROLLER_TAB]);
  const persistedBootstrapIntent = WPConstants.BOOTSTRAP_ROOM_INTENT.normalize(result[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]);
  const persistedControllerRuntime = result[WPConstants.STORAGE.CONTROLLER_RUNTIME] ?? null;
  const persistedAdapterState = result[WPConstants.STORAGE.ADAPTER_STATE] ?? null;
  const room = useCoordinator
    ? cloneRoomProjection(coordinatorState.room)
    : (result[WPConstants.STORAGE.ROOM_STATE] ?? null);
  const fallbackState = {
    room,
    wsConnected: result[WPConstants.STORAGE.WS_CONNECTED] ?? false,
    controllerTabId: persistedControllerLease?.tabId ?? null,
    bootstrapPending: !!persistedBootstrapIntent,
    controllerRuntime: persistedControllerRuntime,
    adapterState: persistedAdapterState,
  };
  const fallbackInvariants = deriveCoordinatorInvariants(fallbackState);
  refreshCoordinatorMode();
  return {
    room,
    userId: useCoordinator ? coordinatorState.userId : (result[WPConstants.STORAGE.USER_ID] ?? null),
    sessionId: useCoordinator ? coordinatorState.sessionId : (result[WPConstants.STORAGE.SESSION_ID] ?? null),
    mode: useCoordinator ? coordinatorState.mode : deriveCoordinatorModeFromState(fallbackState),
    bootstrapPending: useCoordinator ? coordinatorState.bootstrapPending : !!persistedBootstrapIntent,
    wsConnected: useCoordinator ? coordinatorState.wsConnected : (result[WPConstants.STORAGE.WS_CONNECTED] ?? false),
    activeBackend: useCoordinator ? coordinatorState.activeBackend : (result[WPConstants.STORAGE.ACTIVE_BACKEND] ?? null),
    activeBackendUrl: useCoordinator ? coordinatorState.activeBackendUrl : (result[WPConstants.STORAGE.ACTIVE_BACKEND_URL] ?? null),
    controllerRuntime: useCoordinator
      ? (coordinatorState.controllerRuntime ? structuredClone(coordinatorState.controllerRuntime) : null)
      : persistedControllerRuntime,
    adapterState: useCoordinator
      ? (coordinatorState.adapterState ? structuredClone(coordinatorState.adapterState) : null)
      : persistedAdapterState,
    invariants: useCoordinator ? structuredClone(coordinatorState.invariants) : fallbackInvariants,
    recentEvents: useCoordinator ? structuredClone(coordinatorState.recentEvents) : [],
    currentRoomId: room?.id ?? result[WPConstants.STORAGE.CURRENT_ROOM] ?? null,
  };
}

async function getExtensionState(keys) {
  return WPRuntimeState.get(keys);
}

async function setExtensionState(values) {
  return WPRuntimeState.set(values);
}

async function removeExtensionState(keys) {
  return WPRuntimeState.remove(keys);
}

// ── Stremio server detection ──

async function checkStremio() {
  const prev = stremioRunning;
  const start = Date.now();
  try {
    const res = await fetch(`${STREMIO_BASE}/stats.json`, { signal: AbortSignal.timeout(3000) });
    stremioRunning = res.ok;
    stats.lastLatencyMs = Date.now() - start;
  } catch (e) {
    stremioRunning = false;
    stats.lastLatencyMs = 0;
    // Expected when Stremio is not running — only log at debug level
  }
  updateBadge();
  if (prev !== stremioRunning) {
    broadcastToStremioTabs({ action: WPConstants.ACTION.STREMIO_STATUS_UPDATED, stremioRunning });
    broadcastToWatchParty({ action: WPConstants.ACTION.STREMIO_STATUS_UPDATED, stremioRunning });
    if (stremioRunning) {
      fetchStremioSettings();
      tryProfileSync();
    } else {
      stremioSettings = null;
    }
  }
}

async function fetchStremioSettings() {
  try {
    const res = await fetch(`${STREMIO_BASE}/settings`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      stremioSettings = {
        serverVersion: data.values?.serverVersion ?? null,
        cacheSize: data.values?.cacheSize ?? null,
        transcodeHardwareAccel: data.values?.transcodeHardwareAccel ?? null,
        transcodeMaxWidth: data.values?.transcodeMaxWidth ?? null,
        transcodeMaxBitRate: data.values?.transcodeMaxBitRate ?? null,
        transcodeProfile: data.values?.transcodeProfile ?? null,
        allTranscodeProfiles: data.values?.allTranscodeProfiles ?? null,
        remoteHttps: data.values?.remoteHttps ?? null,
      };
    }
  } catch (e) { console.warn('[WP-BG] Failed to fetch Stremio settings:', e.message); }
}

// ── Profile sync via Stremio API ──

async function tryProfileSync() {
  const { [WPConstants.STORAGE.STREMIO_PROFILE]: stremioProfile } = await chrome.storage.local.get(WPConstants.STORAGE.STREMIO_PROFILE);
  if (Array.isArray(stremioProfile?.addons) && stremioProfile.addons.length > 0) return;
  // Auth key stored in session storage (cleared on browser restart) for security
  const { [WPConstants.STORAGE.SAVED_AUTH_KEY]: savedAuthKey } = await chrome.storage.session.get(WPConstants.STORAGE.SAVED_AUTH_KEY);
  const authKey = savedAuthKey;
  if (!authKey) return;
  try {
    const res = await fetch(`${STREMIO_API}/api/addonCollectionGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'AddonCollectionGet', authKey, update: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const addons = data.result?.addons ?? [];
    if (addons.length === 0) return;
    const profile = {
      user: stremioProfile?.user ?? null,
      addons: addons.map(a => ({ transportUrl: a.transportUrl, manifest: a.manifest, flags: a.flags })),
      settings: stremioProfile?.settings ?? {
        audioLanguage: null, secondaryAudioLanguage: null,
        subtitlesLanguage: null, secondarySubtitlesLanguage: null,
        interfaceLanguage: null, streamingServerUrl: null,
      },
      readAt: Date.now(),
    };
    await chrome.storage.local.set({ [WPConstants.STORAGE.STREMIO_PROFILE]: profile });
    broadcastToWatchParty({ action: WPConstants.ACTION.PROFILE_UPDATED, data: profile });
  } catch (e) { console.warn('[WP-BG] Profile sync failed:', e.message); }
}

function updateBadge() {
  const color = stremioRunning ? '#22c55e' : '#ef4444';
  const text = stremioRunning ? 'ON' : 'OFF';
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

// ── Message handling from popup and content scripts ──

function relayToPanel(action, payload) {
  chrome.runtime.sendMessage({ type: 'watchparty-ext', action, payload }).catch(() => {});
}

function respondAsync(sendResponse, work) {
  Promise.resolve()
    .then(work)
    .then((result) => sendResponse?.(result ?? { ok: true }))
    .catch((error) => {
      const message = error?.message || String(error);
      console.warn('[WP-BG] async handler failed:', message);
      sendResponse?.({ ok: false, error: message });
    });
  return true;
}

function urlMatchesOrigins(url, origins) {
  try {
    return origins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

async function getTabsByOrigins(origins) {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => !!tab.url && urlMatchesOrigins(tab.url, origins));
  } catch {
    return [];
  }
}

function rememberSurfaceTab(surface, tabId) {
  if (tabId == null) return;
  if (surface === 'stremio') {
    knownStremioTabIds.add(tabId);
    knownWatchPartyTabIds.delete(tabId);
    return;
  }
  if (surface === 'watchparty') {
    knownWatchPartyTabIds.add(tabId);
    knownStremioTabIds.delete(tabId);
  }
}

async function clearLeaseIfOwned(storageKey, leaseContract, tabId) {
  const state = await getExtensionState(storageKey);
  const currentLease = leaseContract.normalize(state[storageKey]);
  if (!currentLease || currentLease.tabId !== tabId) return false;
  await removeExtensionState(storageKey);
  return true;
}

async function forgetSurfaceTab(tabId) {
  if (tabId == null) return;
  knownStremioTabIds.delete(tabId);
  knownWatchPartyTabIds.delete(tabId);
  clearLeaseIfOwned(WPConstants.STORAGE.ACTIVE_VIDEO_TAB, WPConstants.VIDEO_TAB_LEASE, tabId).catch(() => {});
  clearLeaseIfOwned(WPConstants.STORAGE.CONTROLLER_TAB, WPConstants.CONTROLLER_TAB_LEASE, tabId).catch(() => {});
  clearCoordinatorController(tabId);
}

async function resolveKnownTabs(tabIds) {
  const resolved = [];
  for (const tabId of Array.from(tabIds)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolved.push(tab);
    } catch {
      tabIds.delete(tabId);
    }
  }
  return resolved;
}

async function probeKnownExtensionSurfaces() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'watchparty-ext',
          action: WPConstants.ACTION.PROBE_SURFACE,
        });
        if (response?.surface) rememberSurfaceTab(response.surface, tab.id);
      } catch {
        // Ignore tabs without a WatchParty content script.
      }
    }));
  } catch {
    // Ignore probe failures and fall back to the known tab set.
  }
}

async function getStremioTabs() {
  if (knownStremioTabIds.size === 0) await probeKnownExtensionSurfaces();
  return resolveKnownTabs(knownStremioTabIds);
}

async function getWatchPartyTabs() {
  if (knownWatchPartyTabIds.size === 0) await probeKnownExtensionSurfaces();
  return resolveKnownTabs(knownWatchPartyTabIds);
}

async function clearBootstrapRoomIntent() {
  await removeExtensionState(WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT);
  coordinatorState.bootstrapPending = false;
  coordinatorState.updatedAt = Date.now();
  refreshCoordinatorMode();
  persistCoordinatorState();
  publishCoordinatorState();
}

async function stageBootstrapRoomIntent(intent) {
  const normalizedIntent = WPConstants.BOOTSTRAP_ROOM_INTENT.normalize(intent);
  if (!normalizedIntent) throw new Error('Invalid bootstrap room intent');
  await setExtensionState({ [WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]: normalizedIntent });
  coordinatorState.bootstrapPending = true;
  coordinatorState.updatedAt = Date.now();
  refreshCoordinatorMode();
  persistCoordinatorState();
  publishCoordinatorState();
}

async function getBootstrapRoomIntent() {
  const result = await getExtensionState(WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT);
  const normalized = WPConstants.BOOTSTRAP_ROOM_INTENT.normalize(result[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]);
  if (!normalized && result[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT] !== undefined) {
    await clearBootstrapRoomIntent();
  }
  coordinatorState.bootstrapPending = !!normalized;
  refreshCoordinatorMode();
  return normalized;
}

async function claimLease({ storageKey, leaseContract, lease, senderTabId, force = false }) {
  const requestedLease = leaseContract.build({
    ...lease,
    tabId: senderTabId,
  });
  if (!requestedLease) return { ok: false, claimed: false, lease: null };

  const result = await getExtensionState(storageKey);
  const currentLease = leaseContract.normalize(result[storageKey]);
  const ownsLease = leaseContract.isOwner(currentLease, requestedLease.leaseId);
  const leaseIsExpired = leaseContract.isExpired(currentLease);
  const shouldClaim = force || ownsLease || leaseIsExpired || !currentLease;

  if (!shouldClaim) {
    return { ok: true, claimed: false, lease: currentLease, ownerTabId: currentLease?.tabId ?? null };
  }

  if (!force && ownsLease && !leaseContract.shouldRenew(currentLease)) {
    return { ok: true, claimed: true, lease: currentLease, ownerTabId: currentLease?.tabId ?? null };
  }

  await setExtensionState({ [storageKey]: requestedLease });
  return { ok: true, claimed: true, lease: requestedLease, ownerTabId: requestedLease.tabId ?? null };
}

async function releaseLease({ storageKey, leaseContract, leaseId }) {
  const result = await getExtensionState(storageKey);
  const currentLease = leaseContract.normalize(result[storageKey]);
  if (!leaseContract.isOwner(currentLease, leaseId)) {
    return { ok: true, released: false, lease: currentLease, ownerTabId: currentLease?.tabId ?? null };
  }
  await removeExtensionState(storageKey);
  return { ok: true, released: true, lease: null, ownerTabId: null };
}

async function relayLiveRoomAction(message) {
  const delivered = await forwardToStremioTabWithRetry(message);
  if (!delivered) {
    return { ok: false, error: 'No active Stremio WatchParty session is available for that action.' };
  }
  return { ok: true };
}

async function removeStorageKeys(keys) {
  await removeExtensionState(keys);
}

async function cacheRoomKey(roomId, roomKey) {
  await WPRoomKeys.set(roomId, roomKey);
}

async function focusTab(tab) {
  if (!tab?.id) return null;
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch { /* tab may have closed */ }
  if (typeof tab.windowId === 'number') {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* window may have closed */ }
  }
  return tab;
}

async function openSidebarOnTab(tab, panel) {
  if (!tab?.id) return false;
  await focusTab(tab);
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'watchparty-ext',
      action: WPConstants.ACTION.OPEN_SIDEBAR,
      panel,
    });
    return true;
  } catch {
    forgetSurfaceTab(tab.id);
    return false;
  }
}

async function resolveBrowseUrl() {
  const result = await getExtensionState([
    WPConstants.STORAGE.BACKEND_MODE,
    WPConstants.STORAGE.ACTIVE_BACKEND,
  ]);
  return WPConstants.BACKEND.getBrowseUrl(
    result[WPConstants.STORAGE.BACKEND_MODE],
    result[WPConstants.STORAGE.ACTIVE_BACKEND]
  );
}

async function openOrFocusWatchParty() {
  const tabs = await getWatchPartyTabs();
  if (tabs.length > 0) {
    await focusTab(tabs[0]);
    return { opened: false, tab: tabs[0] };
  }
  const created = await chrome.tabs.create({ url: await resolveBrowseUrl() });
  rememberSurfaceTab('watchparty', created?.id ?? null);
  return { opened: true, tab: created };
}

async function openOrFocusStremio(url = 'https://web.stremio.com') {
  const tabs = await getStremioTabs();
  if (tabs.length > 0) {
    await focusTab(tabs[0]);
    return { opened: false, tab: tabs[0] };
  }
  const targetUrl = typeof url === 'string' && url.trim() ? url.trim() : 'https://web.stremio.com';
  const created = await chrome.tabs.create({ url: targetUrl });
  rememberSurfaceTab('stremio', created?.id ?? null);
  return { opened: true, tab: created };
}

async function ensureOffscreenDocument(path, reasons, justification) {
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (existingContexts.length > 0) return;

  if (!offscreenDocumentPromise) {
    offscreenDocumentPromise = chrome.offscreen.createDocument({
      url: path,
      reasons,
      justification,
    }).finally(() => {
      offscreenDocumentPromise = null;
    });
  }

  await offscreenDocumentPromise;
}

async function copyToClipboard(text) {
  const value = String(text || '');
  if (!value) return { ok: false, error: 'Missing clipboard text' };
  if (!chrome.offscreen) return { ok: false, error: 'Offscreen API unavailable' };

  await ensureOffscreenDocument(
    'offscreen.html',
    ['CLIPBOARD'],
    'Copy WatchParty room links and invite keys from extension surfaces.'
  );

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'watchparty-ext',
        target: 'offscreen',
        action: WPConstants.ACTION.OFFSCREEN_COPY,
        text: value,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response?.ok ? { ok: true } : { ok: false, error: response?.error || 'Copy failed' });
      }
    );
  });
}

async function resumeRoomInStremio() {
  const stremioTabs = await getStremioTabs();
  const runtimeState = await getProjectedRuntimeState();
  const bootstrapIntent = await getBootstrapRoomIntent();
  const room = runtimeState.room ?? null;
  const currentRoomId = runtimeState.currentRoomId ?? room?.id ?? null;
  const hasResumeTarget = !!room || !!currentRoomId || !!bootstrapIntent;
  if (!hasResumeTarget) return { ok: false, openedStremio: false };

  if (stremioTabs.length > 0) {
    if (room) await openSidebarOnTab(stremioTabs[0]);
    else await focusTab(stremioTabs[0]);
    return { ok: true, openedStremio: false };
  }

  const opened = await openOrFocusStremio('https://web.stremio.com');
  return { ok: true, openedStremio: opened.opened };
}

const messageHandlers = {
  [WPConstants.ACTION.STATUS_GET]: (_m, _s, sendResponse) => respondAsync(sendResponse, async () => {
    const stremioTabs = await getStremioTabs();
    const hasStremioTab = stremioTabs.length > 0;
  const result = await getExtensionState([
    WPConstants.STORAGE.STREMIO_PROFILE,
    WPConstants.STORAGE.USERNAME,
    WPConstants.STORAGE.BACKEND_MODE,
    WPConstants.STORAGE.LAST_ROOM_ERROR,
  ]);
    const runtimeState = await getProjectedRuntimeState();
    const bootstrapIntent = await getBootstrapRoomIntent();
    const trustedPersistedRoom = hasStremioTab || !!runtimeState.currentRoomId;
    const backendInfo = WPConstants.BACKEND.getInfo(WPConstants.BACKEND.resolveKey(
      result[WPConstants.STORAGE.BACKEND_MODE],
      runtimeState.activeBackend,
    ));
    return {
      stremioRunning, stremioSettings,
      profile: result[WPConstants.STORAGE.STREMIO_PROFILE] ?? null,
      stats,
      wsConnected: runtimeState.wsConnected,
      backendMode: result[WPConstants.STORAGE.BACKEND_MODE] ?? WPConstants.BACKEND.MODES.AUTO,
      activeBackend: runtimeState.activeBackend,
      activeBackendUrl: runtimeState.activeBackendUrl,
      activeBackendHttpUrl: backendInfo.httpUrl,
      coordinatorMode: runtimeState.mode,
      userId: runtimeState.userId,
      sessionId: runtimeState.sessionId,
      username: result[WPConstants.STORAGE.USERNAME] ?? null,
      room: trustedPersistedRoom ? runtimeState.room : null,
      controllerRuntime: runtimeState.controllerRuntime,
      adapterState: runtimeState.adapterState,
      invariants: runtimeState.invariants,
      recentEvents: runtimeState.recentEvents,
      lastRoomError: result[WPConstants.STORAGE.LAST_ROOM_ERROR] ?? null,
      currentRoomId: runtimeState.currentRoomId,
      hasStremioTab,
      bootstrapPending: !!bootstrapIntent,
      bgVersion: BG_VERSION,
    };
  }),
  [WPConstants.ACTION.SESSION_STATE_PUBLISH]: (m, sender) => {
    const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
    updateCoordinatorState(payload, sender);
    updateBadge();
  },
  [WPConstants.ACTION.CONTROLLER_RELEASED]: (m, sender) => {
    const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
    clearCoordinatorController(sender?.tab?.id, payload);
    updateBadge();
  },
  [WPConstants.ACTION.CONTROLLER_LEASE_CLAIM]: (_m, sender, sr) => respondAsync(sr, async () => {
    const senderTabId = sender?.tab?.id ?? null;
    if (senderTabId == null) return { ok: false, claimed: false, lease: null };
    const response = await claimLease({
      storageKey: WPConstants.STORAGE.CONTROLLER_TAB,
      leaseContract: WPConstants.CONTROLLER_TAB_LEASE,
      lease: _m.lease,
      senderTabId,
      force: _m.force === true,
    });
    if (response.claimed) {
      coordinatorState.controllerTabId = response.ownerTabId;
      coordinatorState.updatedAt = Date.now();
      refreshCoordinatorMode();
      refreshCoordinatorDiagnostics();
      pushCoordinatorEvent('controller.lease.claim', { tabId: response.ownerTabId });
    }
    return response;
  }),
  [WPConstants.ACTION.CONTROLLER_LEASE_RELEASE]: (_m, sender, sr) => respondAsync(sr, async () => {
    const senderTabId = sender?.tab?.id ?? null;
    const response = await releaseLease({
      storageKey: WPConstants.STORAGE.CONTROLLER_TAB,
      leaseContract: WPConstants.CONTROLLER_TAB_LEASE,
      leaseId: _m.leaseId,
    });
    if (response.released && senderTabId != null && coordinatorState.controllerTabId === senderTabId) {
      coordinatorState.controllerTabId = null;
      coordinatorState.updatedAt = Date.now();
      refreshCoordinatorMode();
      refreshCoordinatorDiagnostics();
      pushCoordinatorEvent('controller.lease.release', { tabId: senderTabId });
    }
    return response;
  }),
  [WPConstants.ACTION.ACTIVE_VIDEO_LEASE_CLAIM]: (_m, sender, sr) => respondAsync(sr, async () => {
    const senderTabId = sender?.tab?.id ?? null;
    if (senderTabId == null) return { ok: false, claimed: false, lease: null };
    return claimLease({
      storageKey: WPConstants.STORAGE.ACTIVE_VIDEO_TAB,
      leaseContract: WPConstants.VIDEO_TAB_LEASE,
      lease: _m.lease,
      senderTabId,
      force: _m.force === true,
    });
  }),
  [WPConstants.ACTION.ACTIVE_VIDEO_LEASE_RELEASE]: (_m, _s, sr) => respondAsync(sr, async () => {
    return releaseLease({
      storageKey: WPConstants.STORAGE.ACTIVE_VIDEO_TAB,
      leaseContract: WPConstants.VIDEO_TAB_LEASE,
      leaseId: _m.leaseId,
    });
  }),
  [WPConstants.ACTION.ROOM_CHAT_EVENT]: (m) => {
    relayToPanel(WPConstants.ACTION.ROOM_CHAT_EVENT, m.payload);
    broadcastToStremioTabs({ action: WPConstants.ACTION.ROOM_CHAT_EVENT, payload: m.payload });
  },
  [WPConstants.ACTION.ROOM_TYPING_EVENT]: (m) => {
    relayToPanel(WPConstants.ACTION.ROOM_TYPING_EVENT, m.payload);
    broadcastToStremioTabs({ action: WPConstants.ACTION.ROOM_TYPING_EVENT, payload: m.payload });
  },
  [WPConstants.ACTION.ROOM_BOOKMARK_EVENT]: (m) => {
    relayToPanel(WPConstants.ACTION.ROOM_BOOKMARK_EVENT, m.payload);
    broadcastToStremioTabs({ action: WPConstants.ACTION.ROOM_BOOKMARK_EVENT, payload: m.payload });
  },
  [WPConstants.ACTION.ROOM_REACTION_EVENT]: (m) => {
    broadcastToStremioTabs({ action: WPConstants.ACTION.ROOM_REACTION_EVENT, payload: m.payload });
  },
  [WPConstants.ACTION.ROOM_ERROR_EVENT]: (m) => {
    setExtensionState({ [WPConstants.STORAGE.LAST_ROOM_ERROR]: m.payload || null }).catch(() => {});
    relayToPanel(WPConstants.ACTION.ROOM_ERROR_EVENT, m.payload);
  },
  [WPConstants.ACTION.ROOM_CREATE]: (m, _s, sr) => respondAsync(sr, async () => {
    const stremioTabs = await getStremioTabs();
    const hasStremioTab = stremioTabs.length > 0;
    if (m.username) {
      await chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: m.username });
    }
    await removeExtensionState(WPConstants.STORAGE.LAST_ROOM_ERROR);
    if (await forwardToStremioTabWithRetry(m)) {
      await clearBootstrapRoomIntent();
      return { ok: true, openedStremio: false, hasStremioTab };
    }
    await removeStorageKeys([
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.ROOM_STATE,
      WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
    ]);
    await stageBootstrapRoomIntent(WPConstants.BOOTSTRAP_ROOM_INTENT.buildCreate(m));
    broadcastToStremioTabs({ action: WPConstants.ACTION.BOOTSTRAP_PENDING });
    return { ok: true, openedStremio: false, staged: true, needsStremio: true, hasStremioTab };
  }),
  [WPConstants.ACTION.ROOM_JOIN]: (m, _s, sr) => respondAsync(sr, async () => {
    const stremioTabs = await getStremioTabs();
    const hasStremioTab = stremioTabs.length > 0;
    if (m.roomKey) {
      await cacheRoomKey(m.roomId, m.roomKey);
    }
    await setExtensionState({
      [WPConstants.STORAGE.USERNAME]: m.username,
    });
    await removeExtensionState(WPConstants.STORAGE.LAST_ROOM_ERROR);
    if (await forwardToStremioTabWithRetry(m)) {
      await clearBootstrapRoomIntent();
      return { ok: true, openedStremio: false, hasStremioTab };
    }
    await removeStorageKeys([
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.ROOM_STATE,
      WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
    ]);
    await stageBootstrapRoomIntent(WPConstants.BOOTSTRAP_ROOM_INTENT.buildJoin(m));
    broadcastToStremioTabs({ action: WPConstants.ACTION.BOOTSTRAP_PENDING });
    return { ok: true, openedStremio: false, staged: true, needsStremio: true, hasStremioTab };
  }),
  [WPConstants.ACTION.ROOM_LEAVE]: (m, _s, sr) => respondAsync(sr, async () => {
    if (!await forwardToStremioTabWithRetry(m)) {
      await removeStorageKeys([
        WPConstants.STORAGE.CURRENT_ROOM,
        WPConstants.STORAGE.ROOM_STATE,
        WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
        WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
      ]);
      return { ok: true };
    }
    return { ok: true };
  }),
  [WPConstants.ACTION.ROOM_VISIBILITY_UPDATE]: (m, _s, sr) => respondAsync(sr, async () => {
    return relayLiveRoomAction(m);
  }),
  [WPConstants.ACTION.ROOM_SETTINGS_UPDATE]: (m, _s, sr) => respondAsync(sr, async () => {
    return relayLiveRoomAction(m);
  }),
  [WPConstants.ACTION.ROOM_OWNERSHIP_TRANSFER]: (m, _s, sr) => respondAsync(sr, async () => {
    return relayLiveRoomAction(m);
  }),
  [WPConstants.ACTION.SESSION_USERNAME_UPDATE]: (m, _s, sr) => respondAsync(sr, async () => {
    await chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: m.username });
    await forwardToStremioTabWithRetry(m);
    return { ok: true };
  }),
  [WPConstants.ACTION.ROOM_READY_CHECK_UPDATE]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.ROOM_BOOKMARK_ADD]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.ROOM_BOOKMARK_SEEK]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.ROOM_CHAT_SEND]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.ROOM_TYPING_SEND]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.ROOM_REACTION_SEND]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.ROOM_MEMBER_PRESENCE_PUBLISH]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.ROOM_MEMBER_PLAYBACK_STATUS_PUBLISH]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.ROOM_PLAYBACK_REQUEST_SYNC]: (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTabWithRetry(m); return { ok: true }; }),
  [WPConstants.ACTION.PROFILE_UPDATED]: (m) => broadcastToWatchParty({ action: WPConstants.ACTION.PROFILE_UPDATED, data: m.data }),
  [WPConstants.ACTION.SURFACE_READY]: (m, sender, sendResponse) => {
    rememberSurfaceTab(sender?.tab ? (m.surface || null) : null, sender?.tab?.id ?? null);
    sendResponse?.({ ok: true, tabId: sender?.tab?.id ?? null });
    return true;
  },
  [WPConstants.ACTION.ROOM_RESUME]: (_m, _s, sendResponse) => respondAsync(sendResponse, () => resumeRoomInStremio()),
  [WPConstants.ACTION.APP_OPTIONS_OPEN]: (_m, _s, sendResponse) => respondAsync(sendResponse, async () => {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }),
  [WPConstants.ACTION.APP_STREMIO_OPEN]: (m, _s, sendResponse) => respondAsync(sendResponse, async () => {
    const result = await openOrFocusStremio(m.url);
    return { ok: true, openedStremio: result.opened };
  }),
  [WPConstants.ACTION.CLIPBOARD_COPY]: (m, _s, sendResponse) => respondAsync(sendResponse, async () => {
    return copyToClipboard(m.text);
  }),
  [WPConstants.ACTION.AUTH_KEY_SAVE]: (m) => {
    if (m.authKey) { chrome.storage.session.set({ [WPConstants.STORAGE.SAVED_AUTH_KEY]: m.authKey }); tryProfileSync(); }
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'watchparty-ext') return false;
  const handler = messageHandlers[message.action];
  if (handler) return handler(message, sender, sendResponse) || false;
  return false;
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  forgetSurfaceTab(tabId);
});

chrome.action?.onClicked?.addListener(async (tab) => {
  try {
    if (tab?.id != null && tab.url && urlMatchesOrigins(tab.url, STREMIO_WEB_ORIGINS)) {
      rememberSurfaceTab('stremio', tab.id);
      if (await openSidebarOnTab(tab)) return;
      await focusTab(tab);
      return;
    }

    const resumed = await resumeRoomInStremio();
    if (resumed.ok) return;

    await openOrFocusWatchParty();
  } catch (error) {
    console.warn('[WP-BG] action click failed:', error?.message || String(error));
  }
});

// ── Forward popup commands to the active Stremio content script ──

async function forwardToStremioTab(message) {
  try {
    const tabs = await getStremioTabs();
    // Debug logging removed for production — uncomment for troubleshooting:
    // console.log(`[WP-BG] forwardToStremioTab: action=${message.action}, tabs found=${tabs.length}`);
    const controllerTabId = coordinatorState.controllerTabId;
    const orderedTabs = controllerTabId == null
      ? tabs
      : [
          ...tabs.filter((tab) => tab.id === controllerTabId),
          ...tabs.filter((tab) => tab.id !== controllerTabId),
        ];
    for (const tab of orderedTabs) {
      if (tab.id == null) continue;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message });
        if (response?.handled === false) continue;
        return true;
      } catch (e) {
        forgetSurfaceTab(tab.id);
        console.warn(`[WP-BG] sendMessage to tab ${tab.id} failed:`, e.message);
      }
    }
    return false;
  } catch (e) {
    console.warn('[WP-BG] forwardToStremioTab failed:', e.message);
    return false;
  }
}

// ── Broadcast helpers ──

async function forwardToStremioTabWithRetry(message) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const delivered = await forwardToStremioTab(message);
    if (delivered) return true;
    const tabs = await getStremioTabs();
    if (tabs.length === 0) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await probeKnownExtensionSurfaces();
  }
  return false;
}

async function broadcastToTabs(urlPatterns, message) {
  try {
    const tabs = urlPatterns === STREMIO_WEB_URLS
      ? await getStremioTabs()
      : await getWatchPartyTabs();
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message }).catch(() => {
          forgetSurfaceTab(tab.id);
        });
      }
    }
  } catch (e) { console.warn('[WP-BG] broadcastToTabs failed:', e.message); }
}

function broadcastToStremioTabs(message) { return broadcastToTabs(STREMIO_WEB_URLS, message); }
function broadcastToWatchParty(message) { return broadcastToTabs(WATCHPARTY_URLS, message); }

// ── CORS proxy (for Stremio localhost) ──

// ── Dev auto-reload ──

function connectDevReload() {
  let lastReloadTime = 0;
  const RELOAD_COOLDOWN_MS = 2000; // Prevent Chrome's "reloaded too frequently" throttle
  (async () => {
    try {
      const res = await fetch('http://localhost:5111/reload');
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.includes('data: reload')) {
          const now = Date.now();
          if (now - lastReloadTime < RELOAD_COOLDOWN_MS) continue; // Skip rapid reloads
          lastReloadTime = now;
          chrome.runtime.reload();
          return;
        }
      }
    } catch { /* dev server not running */ }
  })();
}

// ── Side Panel (Chrome 114+, optional alternative to injected overlay) ──

if (chrome.sidePanel) {
  // Enable side panel only on Stremio Web tabs
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

  // When user navigates to Stremio, enable the side panel for that tab
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (!tab.url) return;
    const isStremio = urlMatchesOrigins(tab.url, STREMIO_WEB_ORIGINS);
    const isWatchParty = urlMatchesOrigins(tab.url, WATCHPARTY_ORIGINS);
    if (isStremio) {
      rememberSurfaceTab('stremio', tabId);
    } else if (isWatchParty) {
      rememberSurfaceTab('watchparty', tabId);
    } else {
      forgetSurfaceTab(tabId);
    }
    chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: isStremio,
    }).catch(() => {});
  });
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  forgetSurfaceTab(tabId);
});

// ── Extension update: re-inject content scripts into open Stremio tabs ──
// After auto-update, old content scripts are orphaned (chrome.runtime is dead).
// `chrome.scripting` is kept specifically for this recovery path so users do not
// need to manually refresh already-open Stremio tabs after an extension update.

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'update') return;
  // console.log('[WP-BG] Extension updated — re-injecting content scripts');
  try {
    const tabs = await getStremioTabs();
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'constants.js', 'runtime-state.js', 'wp-room-domain.js', 'wp-direct-play-domain.js', 'direct-play.js', 'wp-protocol.js',
          'utils.js', 'stremio-sync.js', 'stremio-ws.js', 'stremio-crypto.js',
          'stremio-overlay-theme.js', 'stremio-overlay-modals.js', 'stremio-overlay.js',
          'stremio-profile.js', 'stremio-content.js',
        ],
      }).catch(() => {}); // Tab may have navigated away or be restricted
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['stremio-overlay.css'],
      }).catch(() => {});
    }
  } catch (e) { console.warn('[WP-BG] Re-injection failed:', e.message); }
});

// ── Start ──

checkStremio();
fetchStremioSettings();
chrome.storage.session?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
setInterval(checkStremio, POLL_INTERVAL_MS);
// Dev-only: auto-reload on file changes (no update_url = unpacked/dev extension)
if (!('update_url' in chrome.runtime.getManifest())) connectDevReload();

