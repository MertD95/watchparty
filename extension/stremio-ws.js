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

  // --- State ---
  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let keepAliveTimer = null;
  let clockOffset = 0;
  let clockSamples = [];
  let clockSyncTimer = null;
  let backendMode = BACKEND_MODES.AUTO;
  let resolvedBackend = null;
  let lastSeq = 0; // Track last received sequence number for reconnect replay

  // --- Callbacks (set by orchestrator) ---
  let onMessageHandler = null;
  let onConnectHandler = null;
  let onDisconnectHandler = null;

  // Auto mode only prefers localhost for unpacked/dev installs.
  const isDevInstall = !('update_url' in chrome.runtime.getManifest());

  async function probeLocalBackend() {
    try {
      const res = await fetch(WS_URL_DEV.replace('ws://', 'http://'), { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function getBackend() {
    if (resolvedBackend) return resolvedBackend;

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
        if (await probeLocalBackend()) {
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
    if (ws) return;
    const url = await getWsUrl();
    try { ws = new WebSocket(url); } catch (e) { console.warn('[WatchParty] WebSocket creation failed:', e.message); scheduleReconnect(); return; }

    ws.onopen = () => {
      reconnectAttempts = 0;
      // Keepalive ping every 25s
      clearInterval(keepAliveTimer);
      lastPongTime = Date.now(); // Reset on connect
      keepAliveTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          send({ type: WPProtocol.C2S.CLOCK_PING, payload: { clientTime: Date.now() } });
          checkHeartbeat();
        }
      }, KEEPALIVE_INTERVAL_MS);
      flushQueue();
      if (onConnectHandler) onConnectHandler();
    };

    ws.onmessage = (event) => {
      try {
        // Reject oversized messages (100KB) to prevent memory DoS
        if (typeof event.data === 'string' && event.data.length > 102400) return;
        const msg = JSON.parse(event.data);
        // Track sequence number for reconnect replay
        if (typeof msg.seq === 'number') lastSeq = msg.seq;
        // Handle clock pong internally
        if (msg.type === WPProtocol.S2C.CLOCK_PONG) {
          handleClockPong(msg.payload);
          return;
        }
        if (onMessageHandler) onMessageHandler(msg);
      } catch (e) {
        if (e instanceof SyntaxError) return;
        console.warn('[WatchParty] Error handling server message:', e);
      }
    };

    ws.onclose = () => {
      clearInterval(keepAliveTimer);
      for (const t of pendingPingTimers) clearTimeout(t);
      pendingPingTimers = [];
      ws = null;
      if (onDisconnectHandler) onDisconnectHandler();
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose fires after */ };
  }

  function disconnect(options = {}) {
    const { resetReplay = false } = options;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearInterval(clockSyncTimer);
    clockSyncTimer = null;
    for (const t of pendingPingTimers) clearTimeout(t);
    pendingPingTimers = [];
    sendQueue = [];
    reconnectAttempts = 0;
    if (resetReplay) lastSeq = 0;
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    if (onDisconnectHandler) onDisconnectHandler();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    const delay = base + Math.random() * base * 0.2;
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  let sendQueue = [];
  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      // Queue state-changing messages so they're sent when WS reconnects.
      // Skip high-frequency messages (player.sync, clock.ping) to avoid queue bloat.
      if (msg.type !== WPProtocol.C2S.PLAYER_SYNC && msg.type !== WPProtocol.C2S.CLOCK_PING) {
        sendQueue.push(msg);
      }
    }
  }
  function flushQueue() {
    while (sendQueue.length > 0 && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(sendQueue.shift()));
    }
  }

  function isConnected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  // --- Clock sync (Cristian's algorithm) ---
  function startClockSync() {
    clockSamples = [];
    sendClockPings();
    clearInterval(clockSyncTimer);
    clockSyncTimer = setInterval(() => {
      clockSamples = [];
      sendClockPings();
    }, CLOCK_RESYNC_INTERVAL_MS);
  }

  let pendingPingTimers = [];
  function sendClockPings() {
    // Cancel any pending pings from a previous sync round (prevents stale pings after reconnect)
    for (const t of pendingPingTimers) clearTimeout(t);
    pendingPingTimers = [];
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      pendingPingTimers.push(setTimeout(() => send({ type: WPProtocol.C2S.CLOCK_PING, payload: { clientTime: Date.now() } }), i * 200));
    }
  }

  let lastPongTime = 0;
  const HEARTBEAT_TIMEOUT_MS = 60000; // Disconnect if no pong for 60s

  function checkHeartbeat() {
    if (lastPongTime > 0 && Date.now() - lastPongTime > HEARTBEAT_TIMEOUT_MS && ws?.readyState === WebSocket.OPEN) {
      ws.close(4000, 'Heartbeat timeout');
    }
  }

  function handleClockPong(p) {
    if (!p?.clientTime || !p?.serverTime) return;
    lastPongTime = Date.now();
    const now = Date.now();
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

  function getLastSeq() { return lastSeq; }

  function setBackendMode(mode) {
    const nextMode = BACKEND.normalizeMode(mode);
    if (backendMode === nextMode) return false;
    backendMode = nextMode;
    resolvedBackend = null;
    return true;
  }

  function getBackendMode() { return backendMode; }

  function getActiveBackend() { return resolvedBackend?.key || null; }

  function getActiveWsUrl() { return resolvedBackend?.wsUrl || null; }

  // --- Public API ---
  return {
    connect, disconnect, send, isConnected, isReady: isConnected,
    startClockSync, getClockOffset, getLastSeq,
    setBackendMode, getBackendMode, getActiveBackend, getActiveWsUrl,
    // Callback setters
    onMessage(handler) { onMessageHandler = handler; },
    onConnect(handler) { onConnectHandler = handler; },
    onDisconnect(handler) { onDisconnectHandler = handler; },
  };
})();
