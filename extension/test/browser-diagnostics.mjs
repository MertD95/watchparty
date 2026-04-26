const DEFAULT_IGNORES = [
  /no viable transport found \(qt\.webChannelTransport\)/i,
  /Permissions policy violation: compute-pressure is not allowed in this document\./i,
  /googleads\.g\.doubleclick\.net\/pagead\/viewthroughconversion/i,
  /youtube\.com\/pagead\/viewthroughconversion/i,
  /Player\s+\{code:\s*94,\s*message:\s*The owner of the requested video does not allow it to be played in embedded players/i,
  /Failed to load resource: net::ERR_FAILED.*(?:doubleclick|googleads|youtube\.com\/pagead|ytimg\.com)/i,
  // Chromium often emits this URL-less console error for third-party page resources.
  // App-owned request failures are tracked below through requestfailed, which includes the URL.
  /^Failed to load resource: net::ERR_FAILED$/i,
];

const MANAGED_LOCAL_SERVER_IGNORES = process.env.WATCHPARTY_MANAGED_LOCAL_SERVER === '1'
  ? [
      // Chrome can emit this for transient reconnects or page teardown in the
      // managed local harness; the browser flows assert real WS connectivity.
      /WebSocket connection to 'ws:\/\/localhost:\d+\/' failed/i,
    ]
  : [];

export function createBrowserDiagnostics(extraIgnores = []) {
  const entries = [];
  const trackedPages = new WeakSet();
  const ignorePatterns = [...DEFAULT_IGNORES, ...MANAGED_LOCAL_SERVER_IGNORES, ...extraIgnores];

  function isIgnored(text) {
    return ignorePatterns.some((pattern) => pattern.test(text));
  }

  function attachPage(page, label) {
    if (!page || trackedPages.has(page)) return;
    trackedPages.add(page);

    page.on('requestfailed', (request) => {
      const url = request.url();
      const failureText = request.failure()?.errorText || 'request failed';
      const text = `${failureText}: ${url}`;
      const isAppOwnedUrl = /^chrome-extension:\/\//i.test(url)
        || /^https?:\/\/(?:localhost|127\.0\.0\.1):(?:8090|8181)(?:\/|$)/i.test(url)
        || /^https:\/\/watchparty\.mertd\.me(?:\/|$)/i.test(url);
      if (isAppOwnedUrl && !isIgnored(text)) {
        entries.push({ label, type: 'requestfailed', text });
      }
    });

    page.on('pageerror', (error) => {
      const text = error?.message || String(error);
      if (!isIgnored(text)) {
        entries.push({ label, type: 'pageerror', text });
      }
    });

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (!isIgnored(text)) {
        entries.push({ label, type: 'console.error', text });
      }
    });
  }

  function popUnexpected() {
    const unexpected = entries.slice();
    entries.length = 0;
    return unexpected;
  }

  function format(unexpected) {
    return unexpected
      .map((entry) => `[${entry.label}] ${entry.type}: ${entry.text}`)
      .join(' | ');
  }

  return {
    attachPage,
    popUnexpected,
    format,
  };
}
