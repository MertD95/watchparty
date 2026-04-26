// WatchParty background coordinator kernel.
// Keeps mode derivation, invariants, and state transitions pure so the MV3
// service worker only performs Chrome side effects and persistence.

const WPCoordinatorKernel = (() => {
  'use strict';

  const EVENT_LOG_LIMIT = 20;

  function cloneValue(value) {
    if (value == null) return value;
    return structuredClone(value);
  }

  function cloneRoomProjection(room) {
    return room && typeof room === 'object' ? structuredClone(room) : null;
  }

  function createInitialState() {
    return {
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
  }

  function deriveInvariants(state) {
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

  function deriveMode(state) {
    if (state.bootstrapPending) return WPConstants.COORDINATOR_MODE.BOOTSTRAP_PENDING;
    if (state.controllerTabId != null && state.wsConnected) return WPConstants.COORDINATOR_MODE.CONTROLLER_ACTIVE;
    if (state.controllerTabId != null && state.room?.id) return WPConstants.COORDINATOR_MODE.CONTROLLER_RECOVERING;
    if (state.controllerTabId != null) return WPConstants.COORDINATOR_MODE.CONTROLLER_CLAIMING;
    if (state.room?.id) return WPConstants.COORDINATOR_MODE.CONTROLLER_MISSING;
    return WPConstants.COORDINATOR_MODE.IDLE;
  }

  function appendEvent(events, type, details, at) {
    const nextEvents = Array.isArray(events) ? [...events] : [];
    nextEvents.push({
      type,
      at,
      details: details && typeof details === 'object' ? structuredClone(details) : details,
    });
    return nextEvents.slice(-EVENT_LOG_LIMIT);
  }

  function normalizeState(state) {
    const next = {
      ...state,
      room: cloneRoomProjection(state.room),
      controllerRuntime: cloneValue(state.controllerRuntime),
      adapterState: cloneValue(state.adapterState),
    };
    next.mode = deriveMode(next);
    next.invariants = deriveInvariants(next);
    return next;
  }

  function applyPublishedState(state, payload, tabId) {
    const next = { ...state };
    if ('room' in payload) next.room = cloneRoomProjection(payload.room);
    if ('userId' in payload) next.userId = payload.userId || null;
    if ('sessionId' in payload) next.sessionId = payload.sessionId || null;
    if ('wsConnected' in payload) next.wsConnected = payload.wsConnected === true;
    if ('activeBackend' in payload) next.activeBackend = payload.activeBackend || null;
    if ('activeBackendUrl' in payload) next.activeBackendUrl = payload.activeBackendUrl || null;
    if ('controllerRuntime' in payload) next.controllerRuntime = payload.controllerRuntime ? structuredClone(payload.controllerRuntime) : null;
    if ('adapterState' in payload) next.adapterState = payload.adapterState ? structuredClone(payload.adapterState) : null;
    if (tabId != null) next.controllerTabId = tabId;
    return next;
  }

  function releaseController(state, payload, tabId) {
    if (tabId == null || state.controllerTabId !== tabId) return state;
    const next = applyPublishedState(state, payload || {}, null);
    next.controllerTabId = null;
    next.wsConnected = false;
    next.activeBackend = null;
    next.activeBackendUrl = null;
    return next;
  }

  function reduce(state, event, at = Date.now()) {
    const current = normalizeState(state || createInitialState());
    let next = current;
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};

    if (event?.type === 'session.state.publish') {
      next = applyPublishedState(current, payload, event.tabId ?? null);
    } else if (event?.type === 'controller.released') {
      next = releaseController(current, payload, event.tabId ?? null);
    } else if (event?.type === 'bootstrap.pending') {
      next = { ...current, bootstrapPending: payload.pending === true };
    } else if (event?.type === 'controller.lease.claim') {
      next = { ...current, controllerTabId: payload.tabId ?? event.tabId ?? current.controllerTabId };
    } else if (event?.type === 'controller.lease.release') {
      next = event.tabId != null && current.controllerTabId === event.tabId
        ? { ...current, controllerTabId: null, wsConnected: false }
        : current;
    }

    next = normalizeState({
      ...next,
      updatedAt: at,
      recentEvents: appendEvent(current.recentEvents, event?.type || 'unknown', event?.details ?? null, at),
    });
    return next;
  }

  function cloneState(state) {
    const normalized = normalizeState(state || createInitialState());
    return {
      room: cloneRoomProjection(normalized.room),
      userId: normalized.userId,
      sessionId: normalized.sessionId,
      mode: normalized.mode,
      bootstrapPending: normalized.bootstrapPending,
      wsConnected: normalized.wsConnected,
      activeBackend: normalized.activeBackend,
      activeBackendUrl: normalized.activeBackendUrl,
      controllerTabId: normalized.controllerTabId,
      controllerRuntime: cloneValue(normalized.controllerRuntime),
      adapterState: cloneValue(normalized.adapterState),
      invariants: structuredClone(normalized.invariants),
      recentEvents: structuredClone(normalized.recentEvents),
      updatedAt: normalized.updatedAt,
    };
  }

  function buildStorageState(state) {
    const normalized = normalizeState(state || createInitialState());
    return {
      [WPConstants.STORAGE.ROOM_STATE]: cloneRoomProjection(normalized.room),
      [WPConstants.STORAGE.USER_ID]: normalized.userId,
      [WPConstants.STORAGE.SESSION_ID]: normalized.sessionId,
      [WPConstants.STORAGE.WS_CONNECTED]: normalized.wsConnected,
      [WPConstants.STORAGE.ACTIVE_BACKEND]: normalized.activeBackend,
      [WPConstants.STORAGE.ACTIVE_BACKEND_URL]: normalized.activeBackendUrl,
      [WPConstants.STORAGE.CONTROLLER_RUNTIME]: cloneValue(normalized.controllerRuntime),
      [WPConstants.STORAGE.ADAPTER_STATE]: cloneValue(normalized.adapterState),
      [WPConstants.STORAGE.CURRENT_ROOM]: normalized.room?.id || null,
    };
  }

  return {
    createInitialState,
    cloneRoomProjection,
    cloneState,
    buildStorageState,
    deriveInvariants,
    deriveMode,
    reduce,
  };
})();
