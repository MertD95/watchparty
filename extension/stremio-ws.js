// WatchParty — WebSocket Connection Module
// Manages: WS connection, reconnection with exponential backoff, clock sync (Cristian's algorithm).
// Exposes: WPWS global used by stremio-content.js (the orchestrator).
//
// Architecture: WS lives in the content script (not service worker) because
// MV3 service workers suspend after ~30s, permanently killing WS event handlers.

const WPWS = (() => {
  'use strict';

  // --- Config ---
  const WS_URL_PROD = 'wss://ws.mertd.me';
  const WS_URL_DEV = 'ws://localhost:8181';
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
  let detectedWsUrl = null;
  let lastSeq = 0; // Track last received sequence number for reconnect replay

  // --- Callbacks (set by orchestrator) ---
  let onMessageHandler = null;
  let onConnectHandler = null;
  let onDisconnectHandler = null;

  // Detect dev mode: extensions loaded unpacked have installType 'development'
  const isDev = !('update_url' in chrome.runtime.getManifest());

  async function getWsUrl() {
    if (detectedWsUrl) return detectedWsUrl;
    if (isDev) {
      try {
        const res = await fetch(WS_URL_DEV.replace('ws://', 'http://'), { signal: AbortSignal.timeout(1000) });
        if (res.ok) { detectedWsUrl = WS_URL_DEV; return WS_URL_DEV; }
      } catch { /* dev server not running */ }
    }
    detectedWsUrl = WS_URL_PROD;
    return WS_URL_PROD;
  }

  async function connect() {
    if (ws) return;
    const url = await getWsUrl();
    try { ws = new WebSocket(url); } catch (e) { console.warn('[WatchParty] WebSocket creation failed:', e.message); scheduleReconnect(); return; }

    ws.onopen = () => {
      reconnectAttempts = 0;
      // Keepalive ping every 25s
      clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) send({ type: 'clock.ping', payload: { clientTime: Date.now() } });
      }, KEEPALIVE_INTERVAL_MS);
      if (onConnectHandler) onConnectHandler();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Track sequence number for reconnect replay
        if (typeof msg.seq === 'number') lastSeq = msg.seq;
        // Handle clock pong internally
        if (msg.type === 'clock.pong') {
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

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearInterval(clockSyncTimer);
    clockSyncTimer = null;
    for (const t of pendingPingTimers) clearTimeout(t);
    pendingPingTimers = [];
    reconnectAttempts = 0;
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    const delay = base + Math.random() * base * 0.2;
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
      pendingPingTimers.push(setTimeout(() => send({ type: 'clock.ping', payload: { clientTime: Date.now() } }), i * 200));
    }
  }

  function handleClockPong(p) {
    if (!p?.clientTime || !p?.serverTime) return;
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

  // --- Public API ---
  return {
    connect, disconnect, send, isConnected, isReady: isConnected,
    startClockSync, getClockOffset, getLastSeq,
    // Callback setters
    onMessage(handler) { onMessageHandler = handler; },
    onConnect(handler) { onConnectHandler = handler; },
    onDisconnect(handler) { onDisconnectHandler = handler; },
  };
})();
