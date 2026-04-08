// WatchParty for Stremio — Injected into page context
// Intercepts fetch/XHR to Stremio's local server and routes through the extension.

(function () {
  'use strict';

  const STREMIO_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1):11470\//;
  const originalFetch = window.fetch;
  const OriginalXHR = window.XMLHttpRequest;

  let nextRequestId = 0;
  const pendingRequests = new Map();

  // Listen for responses from the content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'watchparty-ext-fetch-response') return;

    const { requestId, status, statusText, headers, body, buffer, error } = event.data;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);

    if (error) {
      pending.reject(new TypeError(error));
    } else {
      // Prefer zero-copy transferred ArrayBuffer, fall back to base64 decode
      const bodyBytes = buffer
        ? new Uint8Array(buffer)
        : (body ? base64ToUint8Array(body) : new Uint8Array(0));
      pending.resolve({ status, statusText, headers, body: bodyBytes });
    }
  });

  function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function proxyRequest(url, method, requestHeaders) {
    return new Promise((resolve, reject) => {
      const requestId = ++nextRequestId;
      pendingRequests.set(requestId, { resolve, reject });
      window.postMessage({
        type: 'watchparty-ext-fetch-request',
        requestId,
        url,
        method: method || 'GET',
        headers: requestHeaders || {},
      }, '*');

      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new TypeError('Extension proxy timeout'));
        }
      }, 30000);
    });
  }

  // ── Fetch override ──

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (!url || !STREMIO_PATTERN.test(url)) {
      return originalFetch.call(this, input, init);
    }

    const method = init?.method || (typeof input !== 'string' ? input?.method : 'GET') || 'GET';
    const headers = {};
    if (init?.headers) {
      const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
      h.forEach((v, k) => { headers[k] = v; });
    }

    return proxyRequest(url, method, headers).then(({ status, statusText, headers: rh, body }) => {
      return new Response(body, { status, statusText, headers: rh });
    });
  };

  // ── XMLHttpRequest override (used by HLS.js) ──
  // Wraps a real XHR. For non-Stremio URLs, delegates everything to the real XHR.
  // For Stremio URLs, intercepts open/send and routes through the extension proxy.

  window.XMLHttpRequest = function () {
    const real = new OriginalXHR();
    let intercepted = false;
    let reqUrl = '';
    let reqMethod = 'GET';
    let aborted = false;
    let timeoutTimer = null;
    const reqHeaders = {};

    // State for intercepted requests
    let _readyState = 0;
    let _status = 0;
    let _statusText = '';
    let _response = null;
    let _responseText = '';
    let _responseURL = '';
    let _responseType = '';
    let _responseHeaderStr = '';
    let _responseHeaderMap = {};

    // Event handlers (on* properties)
    let _onreadystatechange = null;
    let _onload = null;
    let _onerror = null;
    let _onprogress = null;
    let _onloadend = null;
    let _ontimeout = null;
    let _onabort = null;

    // addEventListener storage for intercepted mode
    const eventListeners = {};

    function addListener(type, fn) {
      if (!eventListeners[type]) eventListeners[type] = [];
      eventListeners[type].push(fn);
    }

    function removeListener(type, fn) {
      if (eventListeners[type]) eventListeners[type] = eventListeners[type].filter(f => f !== fn);
    }

    function fire(type, init) {
      const isProgress = ['progress', 'load', 'loadend', 'timeout', 'abort', 'error'].includes(type);
      const event = isProgress ? new ProgressEvent(type, init || {}) : new Event(type);
      // on* handler
      const handler = { readystatechange: _onreadystatechange, load: _onload, error: _onerror,
        progress: _onprogress, loadend: _onloadend, timeout: _ontimeout, abort: _onabort }[type];
      if (typeof handler === 'function') try { handler.call(proxy, event); } catch (e) { console.error(e); }
      // addEventListener handlers
      if (eventListeners[type]) {
        for (const fn of eventListeners[type]) try { fn.call(proxy, event); } catch (e) { console.error(e); }
      }
    }

    // The proxy object returned to the caller
    const proxy = {
      // Properties
      get readyState() { return intercepted ? _readyState : real.readyState; },
      get status() { return intercepted ? _status : real.status; },
      get statusText() { return intercepted ? _statusText : real.statusText; },
      get response() { return intercepted ? _response : real.response; },
      get responseText() {
        if (!intercepted) return real.responseText;
        if (_responseType && _responseType !== 'text' && _responseType !== '') {
          throw new DOMException('Failed to read the \'responseText\' property');
        }
        return _responseText;
      },
      get responseURL() { return intercepted ? _responseURL : real.responseURL; },
      get responseType() { return intercepted ? _responseType : real.responseType; },
      set responseType(v) { _responseType = v; if (!intercepted) real.responseType = v; },
      get timeout() { return intercepted ? (timeoutTimer ? 1 : 0) : real.timeout; },
      set timeout(v) {
        if (!intercepted) real.timeout = v;
        // Store for intercepted mode — applied in send()
        proxy._timeoutMs = v;
      },
      get withCredentials() { return real.withCredentials; },
      set withCredentials(v) { real.withCredentials = v; },
      get upload() { return real.upload; },

      // on* setters/getters
      get onreadystatechange() { return _onreadystatechange; },
      set onreadystatechange(v) { _onreadystatechange = v; if (!intercepted) real.onreadystatechange = v; },
      get onload() { return _onload; },
      set onload(v) { _onload = v; if (!intercepted) real.onload = v; },
      get onerror() { return _onerror; },
      set onerror(v) { _onerror = v; if (!intercepted) real.onerror = v; },
      get onprogress() { return _onprogress; },
      set onprogress(v) { _onprogress = v; if (!intercepted) real.onprogress = v; },
      get onloadend() { return _onloadend; },
      set onloadend(v) { _onloadend = v; if (!intercepted) real.onloadend = v; },
      get ontimeout() { return _ontimeout; },
      set ontimeout(v) { _ontimeout = v; if (!intercepted) real.ontimeout = v; },
      get onabort() { return _onabort; },
      set onabort(v) { _onabort = v; if (!intercepted) real.onabort = v; },

      // Methods
      open(method, url, async, user, pass) {
        reqUrl = url;
        reqMethod = method;
        aborted = false;
        if (STREMIO_PATTERN.test(url)) {
          intercepted = true;
          _readyState = 1;
        } else {
          intercepted = false;
          real.open(method, url, async !== false, user, pass);
        }
      },

      setRequestHeader(name, value) {
        if (intercepted) {
          reqHeaders[name] = value;
        } else {
          real.setRequestHeader(name, value);
        }
      },

      send(body) {
        if (!intercepted) {
          // Wire up event handlers to real XHR
          real.onreadystatechange = (...a) => { if (_onreadystatechange) _onreadystatechange.call(proxy, ...a); };
          real.onload = (...a) => { if (_onload) _onload.call(proxy, ...a); };
          real.onerror = (...a) => { if (_onerror) _onerror.call(proxy, ...a); };
          real.onprogress = (...a) => { if (_onprogress) _onprogress.call(proxy, ...a); };
          real.onloadend = (...a) => { if (_onloadend) _onloadend.call(proxy, ...a); };
          real.ontimeout = (...a) => { if (_ontimeout) _ontimeout.call(proxy, ...a); };
          real.onabort = (...a) => { if (_onabort) _onabort.call(proxy, ...a); };
          for (const [evt, fns] of Object.entries(eventListeners)) {
            for (const fn of fns) real.addEventListener(evt, fn);
          }
          real.send(body);
          return;
        }

        // Intercepted — proxy through extension
        const timeoutMs = proxy._timeoutMs || 0;
        if (timeoutMs > 0) {
          timeoutTimer = setTimeout(() => {
            if (aborted) return;
            aborted = true;
            fire('timeout');
            fire('loadend');
          }, timeoutMs);
        }

        proxyRequest(reqUrl, reqMethod, reqHeaders).then(({ status, statusText, headers, body: respBody }) => {
          if (aborted) return;
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }

          _status = status;
          _statusText = statusText || '';
          _responseURL = reqUrl;
          _responseHeaderMap = headers;
          _responseHeaderStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');

          const buffer = respBody.buffer.byteLength ? respBody.buffer : respBody.slice(0).buffer;
          switch (_responseType) {
            case 'arraybuffer':
              _response = buffer;
              break;
            case 'blob':
              _response = new Blob([buffer], { type: headers['content-type'] || '' });
              break;
            case 'json':
              try { _response = JSON.parse(new TextDecoder().decode(respBody)); }
              catch { _response = null; }
              break;
            default:
              _responseText = new TextDecoder().decode(respBody);
              _response = _responseText;
          }

          const prog = { loaded: respBody.length, total: respBody.length, lengthComputable: true };
          _readyState = 2; fire('readystatechange');
          _readyState = 3; fire('readystatechange');
          fire('progress', prog);
          _readyState = 4; fire('readystatechange');
          fire('load', prog);
          fire('loadend', prog);
        }).catch(() => {
          if (aborted) return;
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
          _readyState = 4; _status = 0;
          fire('readystatechange');
          fire('error');
          fire('loadend');
        });
      },

      abort() {
        aborted = true;
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
        if (!intercepted) { real.abort(); return; }
        fire('abort');
        fire('loadend');
      },

      getAllResponseHeaders() {
        return intercepted ? _responseHeaderStr : real.getAllResponseHeaders();
      },

      getResponseHeader(name) {
        return intercepted ? (_responseHeaderMap[name.toLowerCase()] ?? null) : real.getResponseHeader(name);
      },

      overrideMimeType(mime) { if (!intercepted) real.overrideMimeType(mime); },
      addEventListener(type, fn) { addListener(type, fn); if (!intercepted) real.addEventListener(type, fn); },
      removeEventListener(type, fn) { removeListener(type, fn); if (!intercepted) real.removeEventListener(type, fn); },
      dispatchEvent(event) { fire(event.type); return true; },
    };

    proxy._timeoutMs = 0;
    return proxy;
  };

  window.XMLHttpRequest.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest.DONE = 4;
  window.XMLHttpRequest.HEADERS_RECEIVED = 2;
  window.XMLHttpRequest.LOADING = 3;
  window.XMLHttpRequest.OPENED = 1;
  window.XMLHttpRequest.UNSENT = 0;
})();
