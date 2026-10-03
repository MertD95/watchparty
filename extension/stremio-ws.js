// WatchParty — WebSocket Connection Module
// Manages: WS connection, reconnection with exponential backoff, clock sync (Cristian's algorithm).
// Exposes: WPWS global used by stremio-content.js (the orchestrator).
//
// Architecture: WS lives in the content script (not service worker) because
// MV3 service workers suspend after ~30s, permanently killing WS event handlers.

const WPWS = (() => {
  'use strict';

  // --- Config ---
  const BACKEND = WPConstants.BACKEND;
  const BACKEND_MODES = BACKEND.MODES;
  const WS_URL_PROD = BACKEND.LIVE.wsUrl;
  const WS_URL_DEV = BACKEND.LOCAL.wsUrl;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const CLOCK_SAMPLES = 6;
  const CLOCK_RESYNC_INTERVAL_MS = 60000;
  const KEEPALIVE_INTERVAL_MS = 25000;
  const MAX_SEND_QUEUE = 100;

  // --- State ---
  let ws = null;
  let pendingConnection = null;
  let connectionGeneration = 0;
  let connectionWanted = false;
  let backendGeneration = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let keepAliveTimer = null;
  let clockOffset = 0;
  let clockSamples = [];
  let clockSyncTimer = null;
  /** @type {string} */
  let backendMode = BACKEND_MODES.AUTO;
  let resolvedBackend = null;
  let lastSeq = 0; // Track last received sequence number for reconnect replay
  let roomScope = null;
  let applicationReady = false;
  let serverCapabilities = new Set();

  // --- Callbacks (set by orchestrator) ---
  let onMessageHandler = null;
  let onConnectHandler = null;
  let onDisconnectHandler = null;

  // Store packages loaded unpacked still use production-only permissions.
  const isDevInstall = BACKEND.canUseLocal();

  function formatErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  async function probeLocalBackend() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'watchparty-ext',
        action: WPConstants.ACTION.LOCAL_BACKEND_GET,
        resource: 'ready',
      });
      return response?.ok === true;
    } catch {
      return false;
    }
  }

  async function getBackend() {
    if (resolvedBackend) return resolvedBackend;
    const generation = backendGeneration;

    if (backendMode === BACKEND_MODES.LOCAL) {
      resolvedBackend = BACKEND.LOCAL;
      return resolvedBackend;
    }

    if (backendMode === BACKEND_MODES.LIVE) {
      resolvedBackend = BACKEND.LIVE;
      return resolvedBackend;
    }

    if (isDevInstall) {
      try {
        const localAvailable = await probeLocalBackend();
        if (generation !== backendGeneration) return getBackend();
        if (localAvailable) {
          resolvedBackend = BACKEND.LOCAL;
          return resolvedBackend;
        }
      } catch { /* probe failures fall through to live */ }
    }

    resolvedBackend = BACKEND.LIVE;
    return resolvedBackend;
  }

  async function getWsUrl() {
    return (await getBackend()).wsUrl;
  }

  async function connect() {
    if (ws || pendingConnection) return;
    connectionWanted = true;
    if (reconnectTimer) { WPRuntimeClock.clearTimeout(reconnectTimer); reconnectTimer = null; }
    const attempt = {};
    const generation = connectionGeneration;
    pendingConnection = attempt;
    let socket;
    try {
      const url = await getWsUrl();
      if (pendingConnection !== attempt || generation !== connectionGeneration) return;
      socket = new WebSocket(url);
      ws = socket;
    } catch (e) {
      if (generation === connectionGeneration) {
        console.warn('[WatchParty] WebSocket creation failed:', formatErrorMessage(e));
        scheduleReconnect();
      }
      return;
    } finally {
      if (pendingConnection === attempt) pendingConnection = null;
    }
    const isCurrentSocket = () => ws === socket && generation === connectionGeneration;

    socket.onopen = () => {
      if (!isCurrentSocket()) return;
      reconnectAttempts = 0;
      serverCapabilities = new Set();
      // Keepalive ping every 25s
      WPRuntimeClock.clearInterval(keepAliveTimer);
      lastPongTime = WPRuntimeClock.now(); // Reset on connect
      keepAliveTimer = WPRuntimeClock.setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          send({ type: WPProtocol.COMMAND.SESSION_CLOCK_PING, payload: { clientTime: WPRuntimeClock.now() } });
          checkHeartbeat();
        }
      }, KEEPALIVE_INTERVAL_MS);
      markApplicationPending();
      if (onConnectHandler) onConnectHandler();
    };

    socket.onmessage = (event) => {
      if (!isCurrentSocket()) return;
      try {
        // Reject oversized messages (100KB) to prevent memory DoS
        if (typeof event.data === 'string' && event.data.length > 102400) return;
        const msg = JSON.parse(event.data);
        // Track sequence number for reconnect replay
        if (typeof msg.seq === 'number') lastSeq = msg.seq;
        // Handle clock pong internally
        if (msg.type === WPProtocol.EVENT.SESSION_CLOCK_PONG) {
          handleClockPong(msg.payload);
          return;
        }
        if (onMessageHandler) onMessageHandler(msg);
      } catch (e) {
        if (e instanceof SyntaxError) return;
        console.warn('[WatchParty] Error handling server message:', e);
      }
    };

    socket.onclose = () => {
      if (!isCurrentSocket()) return;
      WPRuntimeClock.clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      WPRuntimeClock.clearInterval(clockSyncTimer);
      clockSyncTimer = null;
      for (const t of pendingPingTimers) WPRuntimeClock.clearTimeout(t);
      pendingPingTimers = [];
      ws = null;
      connectionGeneration += 1;
      serverCapabilities = new Set();
      markApplicationPending();
      if (onDisconnectHandler) onDisconnectHandler();
      scheduleReconnect();
    };

    socket.onerror = () => { /* onclose fires after */ };
  }

  function disconnect(options = {}) {
    const { resetReplay = false } = options;
    connectionWanted = false;
    connectionGeneration += 1;
    pendingConnection = null;
    if (reconnectTimer) { WPRuntimeClock.clearTimeout(reconnectTimer); reconnectTimer = null; }
    WPRuntimeClock.clearInterval(clockSyncTimer);
    clockSyncTimer = null;
    for (const t of pendingPingTimers) WPRuntimeClock.clearTimeout(t);
    pendingPingTimers = [];
    sendQueue = [];
    serverCapabilities = new Set();
    markApplicationPending();
    reconnectAttempts = 0;
    if (resetReplay) lastSeq = 0;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
    WPRuntimeClock.clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    if (onDisconnectHandler) onDisconnectHandler();
  }

  function scheduleReconnect() {
    if (!connectionWanted || reconnectTimer || ws) return;
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    const delay = base + WPRuntimeClock.random() * base * 0.2;
    reconnectAttempts++;
    reconnectTimer = WPRuntimeClock.setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  let sendQueue = [];
  const BOOTSTRAP_COMMANDS = new Set([
    WPProtocol.COMMAND.SESSION_HELLO,
    WPProtocol.COMMAND.ROOM_CREATE,
    WPProtocol.COMMAND.ROOM_JOIN,
    WPProtocol.COMMAND.ROOM_REJOIN,
    WPProtocol.COMMAND.ROOM_LEAVE,
    WPProtocol.COMMAND.SESSION_CLOCK_PING,
  ]);
  const VOLATILE_COMMANDS = new Set([
    WPProtocol.COMMAND.ROOM_PLAYBACK_PUBLISH,
    WPProtocol.COMMAND.ROOM_CONTENT_UPDATE,
    WPProtocol.COMMAND.ROOM_MEMBER_PRESENCE_PUBLISH,
    WPProtocol.COMMAND.ROOM_MEMBER_PLAYBACK_STATUS_PUBLISH,
    WPProtocol.COMMAND.ROOM_TYPING_SEND,
    WPProtocol.COMMAND.ROOM_PLAYBACK_REQUEST,
    WPProtocol.COMMAND.ROOM_REACTION_SEND,
    WPProtocol.COMMAND.ROOM_READY_CHECK_UPDATE,
    WPProtocol.COMMAND.SESSION_CLOCK_PING,
  ]);

  function shouldSendImmediately(msg) {
    return ws?.readyState === WebSocket.OPEN && (applicationReady || BOOTSTRAP_COMMANDS.has(msg?.type));
  }

  function shouldQueue(msg) {
    // Handshakes/room transitions are reconstructed by the controller after
    // reconnect. Replaying an old join/create after its new handshake can
    // move the user back into a superseded room.
    return connectionWanted && !!msg?.type
      && !BOOTSTRAP_COMMANDS.has(msg.type) && !VOLATILE_COMMANDS.has(msg.type);
  }

  function enqueue(msg) {
    if (!shouldQueue(msg)) return false;
    sendQueue.push(msg);
    if (sendQueue.length > MAX_SEND_QUEUE) sendQueue.shift();
    return true;
  }

  function send(msg) {
    if (shouldSendImmediately(msg)) {
      ws.send(JSON.stringify(msg));
      return true;
    } else {
      return enqueue(msg);
    }
  }
  function flushQueue() {
    while (sendQueue.length > 0 && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(sendQueue.shift()));
    }
  }
  function clearQueue() {
    sendQueue = [];
  }

  function setRoomScope(roomId) {
    const nextScope = typeof roomId === 'string' && roomId ? roomId : null;
    if (nextScope === roomScope) return;
    roomScope = nextScope;
    clearQueue();
    lastSeq = 0;
  }

  function markApplicationPending() {
    applicationReady = false;
  }

  function markApplicationReady() {
    applicationReady = true;
    flushQueue();
  }

  function isApplicationReady() {
    return applicationReady;
  }

  function isConnected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  // --- Clock sync (Cristian's algorithm) ---
  function startClockSync() {
    clockSamples = [];
    sendClockPings();
    WPRuntimeClock.clearInterval(clockSyncTimer);
    clockSyncTimer = WPRuntimeClock.setInterval(() => {
      clockSamples = [];
      sendClockPings();
    }, CLOCK_RESYNC_INTERVAL_MS);
  }

  let pendingPingTimers = [];
  function sendClockPings() {
    // Cancel any pending pings from a previous sync round (prevents stale pings after reconnect)
    for (const t of pendingPingTimers) WPRuntimeClock.clearTimeout(t);
    pendingPingTimers = [];
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      pendingPingTimers.push(WPRuntimeClock.setTimeout(() => send({ type: WPProtocol.COMMAND.SESSION_CLOCK_PING, payload: { clientTime: WPRuntimeClock.now() } }), i * 200));
    }
  }

  let lastPongTime = 0;
  const HEARTBEAT_TIMEOUT_MS = 60000; // Disconnect if no pong for 60s

  function checkHeartbeat() {
    if (lastPongTime > 0 && WPRuntimeClock.now() - lastPongTime > HEARTBEAT_TIMEOUT_MS && ws?.readyState === WebSocket.OPEN) {
      ws.close(4000, 'Heartbeat timeout');
    }
  }

  function handleClockPong(p) {
    if (!p?.clientTime || !p?.serverTime) return;
    lastPongTime = WPRuntimeClock.now();
    const now = WPRuntimeClock.now();
    const rtt = now - p.clientTime;
    const offset = p.serverTime - p.clientTime - rtt / 2;
    clockSamples.push({ rtt, offset });
    if (clockSamples.length >= CLOCK_SAMPLES) {
      clockSamples.sort((a, b) => a.rtt - b.rtt);
      clockOffset = clockSamples[0].offset;
      WPSync.setClockOffset(clockOffset);
    }
  }

  function getClockOffset() { return clockOffset; }

  function setServerCapabilities(capabilities) {
    serverCapabilities = new Set(Array.isArray(capabilities) ? capabilities.filter((value) => typeof value === 'string') : []);
  }

  function supportsCapability(capability) {
    return typeof capability === 'string' && serverCapabilities.has(capability);
  }

  function getLastSeq() { return lastSeq; }

  function setBackendMode(mode) {
    const nextMode = BACKEND.normalizeMode(mode);
    if (backendMode === nextMode) return false;
    backendMode = nextMode;
    backendGeneration += 1;
    resolvedBackend = null;
    return true;
  }

  function getBackendMode() { return backendMode; }

  function getActiveBackend() { return resolvedBackend?.key || null; }

  function getActiveWsUrl() { return resolvedBackend?.wsUrl || null; }

  // --- Public API ---
  return {
    connect, disconnect, send, isConnected, isReady: isConnected,
    flushQueue, clearQueue, markApplicationPending, markApplicationReady, isApplicationReady,
    setRoomScope, getConnectionGeneration: () => connectionGeneration,
    startClockSync, getClockOffset, getLastSeq, setServerCapabilities, supportsCapability,
    setBackendMode, getBackendMode, getActiveBackend, getActiveWsUrl,
    // Callback setters
    onMessage(handler) { onMessageHandler = handler; },
    onConnect(handler) { onConnectHandler = handler; },
    onDisconnect(handler) { onDisconnectHandler = handler; },
  };
})();

