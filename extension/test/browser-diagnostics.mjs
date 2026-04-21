const DEFAULT_IGNORES = [
  /no viable transport found \(qt\.webChannelTransport\)/i,
  /googleads\.g\.doubleclick\.net\/pagead\/viewthroughconversion/i,
  /youtube\.com\/pagead\/viewthroughconversion/i,
  /Failed to load resource: net::ERR_FAILED/i,
];

export function createBrowserDiagnostics(extraIgnores = []) {
  const entries = [];
  const trackedPages = new WeakSet();
  const ignorePatterns = [...DEFAULT_IGNORES, ...extraIgnores];

  function isIgnored(text) {
    return ignorePatterns.some((pattern) => pattern.test(text));
  }

  function attachPage(page, label) {
    if (!page || trackedPages.has(page)) return;
    trackedPages.add(page);

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
