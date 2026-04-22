// WatchParty runtime model helpers for the controller and Stremio adapter state.
// Loaded before stremio-content.js and kept pure so the content orchestrator can
// focus on side effects instead of reducer logic.

const WPStremioRuntimeModel = (() => {
  'use strict';

  const RUNTIME_EVENT_LOG_LIMIT = 20;

  function createRuntimeEventLog(previousEvents, type, details, at = Date.now()) {
    const nextEvents = Array.isArray(previousEvents) ? [...previousEvents] : [];
    nextEvents.push({
      type,
      at,
      details: details && typeof details === 'object' ? { ...details } : null,
    });
    return nextEvents.slice(-RUNTIME_EVENT_LOG_LIMIT);
  }

  function createInitialControllerRuntimeState() {
    return {
      revision: 0,
      phase: WPConstants.CONTROLLER_RUNTIME_PHASE.BOOTING,
      surfaceTabId: null,
      sessionIdKnown: false,
      wantsController: false,
      isControllerTab: false,
      isActiveVideoTab: false,
      wsConnected: false,
      inRoom: false,
      hasVideo: false,
      resumeRoomPending: false,
      pendingCreate: false,
      pendingJoin: false,
      deferredLeave: false,
      lastAction: null,
      lastEvent: 'boot',
      lastEventAt: Date.now(),
      invariants: [],
      recentEvents: [],
    };
  }

  function deriveControllerRuntimePhase(state) {
    if (!state.sessionIdKnown) return WPConstants.CONTROLLER_RUNTIME_PHASE.BOOTING;
    if (state.isControllerTab && state.wsConnected && state.inRoom) return WPConstants.CONTROLLER_RUNTIME_PHASE.ACTIVE_IN_ROOM;
    if (state.isControllerTab && state.wsConnected) return WPConstants.CONTROLLER_RUNTIME_PHASE.ACTIVE;
    if (state.isControllerTab) return WPConstants.CONTROLLER_RUNTIME_PHASE.CONNECTING;
    if (state.wantsController) return WPConstants.CONTROLLER_RUNTIME_PHASE.CLAIMING;
    if (state.inRoom || state.resumeRoomPending || state.deferredLeave) return WPConstants.CONTROLLER_RUNTIME_PHASE.RECOVERING;
    return WPConstants.CONTROLLER_RUNTIME_PHASE.PASSIVE;
  }

  function buildControllerRuntimeInvariants(state) {
    const issues = [];
    if (state.wsConnected && !state.isControllerTab) {
      issues.push({ code: 'ws_without_controller', severity: 'error', message: 'Socket is connected while the controller lease is not owned.' });
    }
    if (state.isActiveVideoTab && !state.hasVideo) {
      issues.push({ code: 'video_lease_without_video', severity: 'warn', message: 'Active video lease is held without an attached video element.' });
    }
    if (state.inRoom && !state.sessionIdKnown) {
      issues.push({ code: 'room_without_session', severity: 'error', message: 'Room state exists before the shared session identity is known.' });
    }
    if (state.pendingCreate && state.pendingJoin) {
      issues.push({ code: 'conflicting_pending_intents', severity: 'warn', message: 'Create and join intents are staged at the same time.' });
    }
    return issues;
  }

  function reduceControllerRuntimeState(state, event) {
    const snapshot = event.snapshot || {};
    const next = {
      ...state,
      ...snapshot,
      revision: (state.revision || 0) + 1,
      lastEvent: event.type,
      lastEventAt: event.at,
    };
    next.phase = deriveControllerRuntimePhase(next);
    next.invariants = buildControllerRuntimeInvariants(next);
    next.recentEvents = createRuntimeEventLog(state.recentEvents, event.type, {
      phase: next.phase,
      isControllerTab: next.isControllerTab,
      isActiveVideoTab: next.isActiveVideoTab,
      wsConnected: next.wsConnected,
      inRoom: next.inRoom,
      hasVideo: next.hasVideo,
    }, event.at);
    return next;
  }

  function createInitialAdapterRuntimeState(initialJoinHint) {
    return {
      revision: 0,
      route: WPConstants.ADAPTER_ROUTE.IDLE,
      availability: WPConstants.ADAPTER_AVAILABILITY.UNAVAILABLE,
      hasVideo: false,
      launchUrl: null,
      contentMeta: null,
      joinHint: initialJoinHint,
      directJoinType: null,
      failureReason: null,
      lastPublishedShareKey: null,
      lastPublishedLaunchUrl: null,
      lastEvent: 'boot',
      lastEventAt: Date.now(),
      invariants: [],
      recentEvents: [],
    };
  }

  function deriveAdapterRoute(hash = window.location.hash || '') {
    if (!hash) return WPConstants.ADAPTER_ROUTE.IDLE;
    if (hash.startsWith('#/player/')) return WPConstants.ADAPTER_ROUTE.PLAYER;
    if (/^#\/(?:detail|metadetails)\//.test(hash)) return WPConstants.ADAPTER_ROUTE.DETAIL;
    return WPConstants.ADAPTER_ROUTE.OTHER;
  }

  function deriveAdapterAvailability(snapshot) {
    if (!snapshot.launchUrl && !snapshot.contentMeta) return WPConstants.ADAPTER_AVAILABILITY.UNAVAILABLE;
    if (snapshot.route === WPConstants.ADAPTER_ROUTE.DETAIL) return WPConstants.ADAPTER_AVAILABILITY.DETAIL_ONLY;
    if (snapshot.route !== WPConstants.ADAPTER_ROUTE.PLAYER) return WPConstants.ADAPTER_AVAILABILITY.UNAVAILABLE;
    if (snapshot.joinHint?.mode === WPRoomDomain.JOIN_HINT_MODE.DIRECT) return WPConstants.ADAPTER_AVAILABILITY.DIRECT_JOIN_READY;
    if (snapshot.joinHint?.mode === WPRoomDomain.JOIN_HINT_MODE.TITLE_ONLY) return WPConstants.ADAPTER_AVAILABILITY.MANUAL_JOIN_ONLY;
    return WPConstants.ADAPTER_AVAILABILITY.PLAYER_PENDING;
  }

  function buildAdapterRuntimeInvariants(state) {
    const issues = [];
    if (state.availability === WPConstants.ADAPTER_AVAILABILITY.DIRECT_JOIN_READY && !state.launchUrl) {
      issues.push({ code: 'direct_join_without_launch_url', severity: 'error', message: 'Direct-join content is marked ready without a player launch URL.' });
    }
    if (state.route === WPConstants.ADAPTER_ROUTE.PLAYER && !state.contentMeta && !state.hasVideo) {
      issues.push({ code: 'player_route_without_context', severity: 'warn', message: 'Player route is active without metadata or a detected video element.' });
    }
    return issues;
  }

  function reduceAdapterRuntimeState(state, event) {
    const snapshot = event.snapshot || {};
    const next = {
      ...state,
      ...snapshot,
      revision: (state.revision || 0) + 1,
      lastEvent: event.type,
      lastEventAt: event.at,
    };
    next.availability = deriveAdapterAvailability(next);
    next.invariants = buildAdapterRuntimeInvariants(next);
    next.recentEvents = createRuntimeEventLog(state.recentEvents, event.type, {
      route: next.route,
      availability: next.availability,
      directJoinType: next.directJoinType,
      launchUrl: next.launchUrl,
    }, event.at);
    return next;
  }

  return {
    createInitialControllerRuntimeState,
    reduceControllerRuntimeState,
    createInitialAdapterRuntimeState,
    deriveAdapterRoute,
    reduceAdapterRuntimeState,
  };
})();
