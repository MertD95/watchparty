    const IS_DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const WS_API = IS_DEV ? 'ws://localhost:8181' : 'wss://ws.mertd.me';
    const ROOMS_API = IS_DEV ? 'http://localhost:8181/rooms' : 'https://ws.mertd.me/rooms';
    const CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/detail/watchparty-for-stremio/kfkdlmmjcnndgjkbbckhcafglbmndobk';
    const WEBSITE_USERNAME_KEY = 'watchparty.website.username';
    const EXTENSION_UPDATE_REQUIRED = 'Update WatchParty, then refresh this page to reconnect safely.';
    let extStatusRequestSeq = 0;
    let extActionRequestSeq = 0;
    let extensionUnavailable = false;
    let pendingWebsiteJoin = null;
    let lastRequestedRoomId = '';
    let latestWebsiteJoin = null;
    let observeRedirectMembership = () => {};
    let reportRedirectJoinError = () => {};

    // --- Routing ---
    const path = location.pathname;
    const roomMatch = path.match(/^\/r\/([a-z0-9-]+)$/i);

    // --- Landing page ---
    function showLandingPage() {
      document.getElementById('page-landing').style.display = 'block';
      loadPublicRooms();
      hydrateLandingIdentity();
      void refreshLandingPresence();
    }

    let latestExtensionStatus = null;
    let usernameEditedLocally = false;
    let landingPresenceRequestSeq = 0;
    const pendingPresenceRefreshTimers = new Set();

    function normalizeUsername(value) {
      return String(value || '').trim().slice(0, 25);
    }

    function getProfileNameInput() {
      return document.getElementById('profile-name-input');
    }

    function getStoredUsername() {
      // Browser privacy settings can disable storage without disabling the UI.
      try { return localStorage.getItem(WEBSITE_USERNAME_KEY) || ''; }
      catch { return ''; }
    }

    function setPreferredUsername(value, options = {}) {
      const normalized = normalizeUsername(value);
      if (options.syncInput !== false) {
        const input = getProfileNameInput();
        if (input && input.value !== normalized) input.value = normalized;
      }
      if (options.persist !== false) {
        try {
          if (normalized) localStorage.setItem(WEBSITE_USERNAME_KEY, normalized);
          else localStorage.removeItem(WEBSITE_USERNAME_KEY);
        } catch { /* Keep the name in this page when browser storage is blocked. */ }
      }
      return normalized;
    }

    function hydrateLandingIdentity() {
      const storedName = getStoredUsername();
      setPreferredUsername(storedName, { persist: false });
      getProfileNameInput()?.addEventListener('input', (event) => {
        usernameEditedLocally = true;
        // Save the normalized value without trimming a space the user just typed.
        setPreferredUsername(event.target.value, { syncInput: false });
        if (normalizeUsername(event.target.value)) event.target.removeAttribute('aria-invalid');
      });
      getProfileNameInput()?.addEventListener('blur', (event) => {
        event.target.value = setPreferredUsername(event.target.value);
      });
    }

    function getPreferredUsername() {
      if (usernameEditedLocally) return normalizeUsername(getProfileNameInput()?.value);
      const roomUserName = Array.isArray(latestExtensionStatus?.room?.users)
        ? latestExtensionStatus.room.users.find((user) => user.id === latestExtensionStatus.userId)?.name || ''
        : '';
      return normalizeUsername(
        getProfileNameInput()?.value
        || latestExtensionStatus?.username
        || roomUserName
        || getStoredUsername()
      );
    }

    function ensurePreferredUsername() {
      const username = getPreferredUsername();
      if (username) {
        setPreferredUsername(username);
        return username;
      }
      const input = getProfileNameInput();
      const note = document.getElementById('hero-profile-note');
      if (note) note.textContent = 'Add a display name to join from this page.';
      input?.setAttribute('aria-invalid', 'true');
      input?.focus();
      input?.select?.();
      return '';
    }

    function clearScheduledPresenceRefreshes() {
      for (const timerId of pendingPresenceRefreshTimers) {
        clearTimeout(timerId);
      }
      pendingPresenceRefreshTimers.clear();
    }

    function scheduleLandingPresenceRefresh(delays = [0, 250, 1000, 2500], timeoutMs = 1200) {
      clearScheduledPresenceRefreshes();
      delays.forEach((delay) => {
        const timerId = setTimeout(() => {
          pendingPresenceRefreshTimers.delete(timerId);
          void refreshLandingPresence({ timeoutMs });
        }, delay);
        pendingPresenceRefreshTimers.add(timerId);
      });
    }

    function updateLandingPresence(status, options = {}) {
      const nextStatus = status || (options.preserveExisting ? latestExtensionStatus : null);
      latestExtensionStatus = nextStatus;
      const extensionDetected = document.documentElement.hasAttribute('data-watchparty-ext');
      const extensionNeedsUpdate = extensionDetected && !extensionSupportsActionResults();
      const primaryBtn = document.getElementById('hero-primary-btn');
      const extensionPill = document.getElementById('hero-extension-pill');
      const extensionStatus = document.getElementById('hero-extension-status');
      const roomPill = document.getElementById('hero-room-pill');
      const profileNote = document.getElementById('hero-profile-note');
      const roomCard = document.getElementById('hero-room-card');
      const roomTitle = document.getElementById('hero-room-title');
      const roomMeta = document.getElementById('hero-room-meta');
      const resumeBtn = document.getElementById('hero-resume-btn');
      const settingsBtn = document.getElementById('hero-settings-btn');
      const preferredName = normalizeUsername(nextStatus?.username)
        || (Array.isArray(nextStatus?.room?.users) ? nextStatus.room.users.find((user) => user.id === nextStatus.userId)?.name || '' : '')
        || getStoredUsername()
        || '';
      if (preferredName && !usernameEditedLocally && document.activeElement !== getProfileNameInput()) {
        setPreferredUsername(preferredName, { persist: true });
      }
      document.getElementById('join-profile')?.classList.toggle('hidden', !extensionDetected);
      document.getElementById('local-preview-help')?.classList.toggle('hidden', !IS_DEV || extensionDetected);

      if (primaryBtn) {
        primaryBtn.textContent = extensionDetected ? 'Open Stremio' : 'Install WatchParty';
      }

      if (extensionStatus) {
        extensionStatus.className = 'hero-extension-status';
        extensionStatus.classList.add(extensionDetected && !extensionNeedsUpdate ? 'is-ready' : 'is-warn');
      }
      if (extensionPill) {
        extensionPill.textContent = extensionNeedsUpdate ? 'Extension update needed' : extensionDetected ? 'Ready to watch' : 'Extension not detected';
      }

      const room = nextStatus?.room || null;
      if (room && roomCard && roomTitle && roomMeta && roomPill) {
        roomCard.classList.remove('hidden');
        roomPill.classList.remove('hidden');
        roomPill.className = `hero-status-pill ${nextStatus?.wsConnected === false ? 'is-warn' : 'is-ready'}`;
        roomPill.textContent = nextStatus?.wsConnected === false ? 'Reconnecting to your room' : 'You’re in a room';
        roomTitle.textContent = room.name || room.meta?.name || 'Active room';
        roomMeta.textContent = `${pluralize(room.users?.length || 0, 'person', 'people')} · ${room.public === false ? 'Invite only' : 'Anyone can join'}`;
      } else {
        roomCard?.classList.add('hidden');
        if (roomPill) roomPill.classList.add('hidden');
      }

      if (resumeBtn) {
        resumeBtn.classList.toggle('hidden', !room);
      }
      if (settingsBtn) {
        settingsBtn.classList.toggle('hidden', !extensionDetected);
      }

      if (profileNote) {
        if (extensionUnavailable) {
          profileNote.textContent = 'The extension changed or disconnected. Refresh this page to reconnect.';
        } else if (extensionNeedsUpdate) {
          profileNote.textContent = EXTENSION_UPDATE_REQUIRED;
        } else if (getProfileNameInput()?.getAttribute('aria-invalid') === 'true' && !normalizeUsername(getProfileNameInput()?.value)) {
          profileNote.textContent = 'Add a display name to join from this page.';
        } else if (!extensionDetected) {
          profileNote.textContent = 'Install the extension to create or join a room.';
        } else if (room) {
          profileNote.textContent = nextStatus?.wsConnected === false ? 'Your room connection is reconnecting.' : 'Your room is open in Stremio.';
        } else if (nextStatus?.bootstrapPending) {
          profileNote.textContent = 'Open Stremio to finish joining your room.';
        } else if (nextStatus?.hasStremioTab) {
          profileNote.textContent = 'Stremio is open.';
        } else {
          profileNote.textContent = 'Choose a room below, or create one in Stremio.';
        }
      }
    }

    async function refreshLandingPresence(options = {}) {
      const requestSeq = ++landingPresenceRequestSeq;
      const status = await requestExtensionStatus(options.timeoutMs);
      if (requestSeq === landingPresenceRequestSeq) {
        updateLandingPresence(status, { preserveExisting: options.preserveExisting !== false });
        observeWebsiteMembership(status);
      }
      return status;
    }

    function ensureExtensionInstalled() {
      if (document.documentElement.hasAttribute('data-watchparty-ext')) return true;
      if (extensionUnavailable) {
        showWebsiteActionStatus('The extension changed or disconnected. Refresh this page to reconnect.');
        return false;
      }
      navigateToUrl(CHROME_WEB_STORE_URL);
      return false;
    }

    function getDirectJoinType(room) {
      return typeof room?.directJoinType === 'string' ? room.directJoinType : null;
    }

    function getDirectJoinTitle(room) {
      const directJoinType = getDirectJoinType(room);
      if (room?.hasDirectJoin && directJoinType !== 'debrid-url') {
        return '';
      }
      if (directJoinType === 'debrid-url') {
        return 'Warning: the host is using a debrid stream. WatchParty will open the title page so you can choose your own stream.';
      }
      if (directJoinType === 'not-web-ready') {
        return 'Direct Join unavailable: the host stream needs extra headers or local preparation.';
      }
      if (directJoinType === 'external') {
        return 'Direct Join unavailable: the host stream opens outside Stremio Web.';
      }
      return 'Direct stream unavailable until the host opens a Stremio player.';
    }

    function pluralize(value, singular, plural = `${singular}s`) {
      return `${value} ${value === 1 ? singular : plural}`;
    }

    function getRecognizedTitleKey(room) {
      const meta = room?.meta;
      const metaName = typeof meta?.name === 'string' ? meta.name.trim() : '';
      const metaId = typeof meta?.id === 'string' ? meta.id.trim() : '';
      const metaType = typeof meta?.type === 'string' && meta.type.trim() ? meta.type.trim() : 'meta';
      if (!metaName || metaName === 'WatchParty Session' || metaId === 'pending' || metaId === 'unknown') {
        return '';
      }
      return metaId ? `${metaType}:${metaId}` : `${metaType}:name:${metaName.toLowerCase()}`;
    }

    function updateLandingStats(dataForStats) {
      const roomList = Array.isArray(dataForStats?.rooms) ? dataForStats.rooms : [];
      const providedSummary = dataForStats && typeof dataForStats === 'object' ? dataForStats.summary : null;
      const roomCount = Number.isFinite(providedSummary?.rooms) ? Number(providedSummary.rooms) : roomList.length;
      const userCount = Number.isFinite(providedSummary?.users)
        ? Number(providedSummary.users)
        : roomList.reduce((sum, room) => sum + (Number(room?.users) || 0), 0);
      const summaryEl = document.getElementById('hero-live-summary');
      if (!summaryEl) return;
      summaryEl.innerHTML = `
        <div class="rooms-stat"><strong>${userCount}</strong><span>${userCount === 1 ? 'person' : 'people'}</span></div>
        <div class="rooms-stat"><strong>${roomCount}</strong><span>${roomCount === 1 ? 'room' : 'rooms'}</span></div>
      `;
    }

    function showDirectJoinNotice(message) {
      if (typeof window.__watchpartyCaptureAlert === 'function') {
        window.__watchpartyCaptureAlert(message);
        return;
      }
      window.alert(message);
    }

    let pendingPrivateJoin = null;
    let modalReturnFocus = null;

    function parseInviteKeysFromHash(hash) {
      const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
      return {
        accessKey: params.get('accessKey') || '',
        e2eKey: params.get('e2eKey') || '',
      };
    }

    function getInviteRoomKeyFromHash() {
      return parseInviteKeysFromHash(window.location.hash).accessKey;
    }

    function clearInviteHashFromAddressBar() {
      const params = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
      if (!params.has('accessKey') && !params.has('e2eKey')) return;
      if (typeof history?.replaceState !== 'function') return;
      history.replaceState(history.state, document.title, `${location.pathname}${location.search}`);
    }

    function parsePrivateJoinInput(value, expectedRoomId) {
      const trimmed = (value || '').trim();
      if (!trimmed) return { roomId: expectedRoomId || '', accessKey: '', e2eKey: '' };
      try {
        const parsed = new URL(trimmed, location.origin);
        const roomMatch = parsed.pathname.match(/^\/r\/([a-z0-9-]+)$/i);
        const trustedOrigin = parsed.origin === location.origin || parsed.origin === 'https://watchparty.mertd.me';
        if (roomMatch && trustedOrigin && !parsed.username && !parsed.password && ['https:', 'http:'].includes(parsed.protocol)) {
          const keys = parseInviteKeysFromHash(parsed.hash);
          return {
            roomId: roomMatch[1],
            ...keys,
          };
        }
      } catch {}
      // A malformed URL is not an access key, even for a specific private room.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(trimmed)) {
        return { roomId: '', accessKey: '', e2eKey: '' };
      }
      if (!expectedRoomId) {
        const inlineMatch = trimmed.match(/^([a-z0-9-]+)(?:#(.+))?$/i);
        if (inlineMatch) {
          const keys = parseInviteKeysFromHash(inlineMatch[2] || '');
          return {
            roomId: inlineMatch[1],
            ...keys,
          };
        }
      }
      return { roomId: expectedRoomId || '', accessKey: trimmed, e2eKey: '' };
    }

    function navigateToUrl(url) {
      if (typeof window.__watchpartyCaptureNavigation === 'function') {
        window.__watchpartyCaptureNavigation(url);
        return;
      }
      window.location.href = url;
    }

    function showWebsiteActionStatus(message, scope = 'site') {
      const status = document.getElementById(scope === 'rooms' ? 'rooms-action-status' : 'website-action-status');
      if (status) status.textContent = message || '';
    }

    function isConnectedRoomMember(status, roomId) {
      return status?.wsConnected === true && status.bootstrapPending !== true && status.room?.id === roomId
        && Array.isArray(status.room.users) && status.room.users.some(user =>
          (status.userId && user.id === status.userId) || (status.sessionId && user.sessionId === status.sessionId));
    }

    function observeWebsiteMembership(status) {
      if (latestWebsiteJoin && isConnectedRoomMember(status, latestWebsiteJoin.roomId)) {
        latestWebsiteJoin.confirmed = true;
        latestWebsiteJoin.options.onMembershipConfirmed?.();
      }
      observeRedirectMembership(status);
    }

    function extensionSupportsActionResults() {
      return document.documentElement.getAttribute('data-watchparty-action-results') === '1';
    }

    function requestExtensionAction(type, detail = {}, timeoutMs = 9000) {
      if (!document.documentElement.hasAttribute('data-watchparty-ext')) {
        return Promise.resolve({ ok: false, error: 'The extension is unavailable. Refresh this page to reconnect.' });
      }
      if (!extensionSupportsActionResults()) return Promise.resolve({ ok: false, error: EXTENSION_UPDATE_REQUIRED });
      return new Promise(resolve => {
        const requestId = `watchparty-action-${Date.now()}-${++extActionRequestSeq}`;
        let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(result);
        };
        const onMessage = event => {
          if (event.source !== window || event.origin !== location.origin) return;
          const data = event.data;
          if (data?.type === 'watchparty-ext-unavailable') {
            finish({ ok: false, error: 'The extension changed or disconnected. Refresh this page to reconnect.' });
            return;
          }
          if (data?.type !== 'watchparty-ext-action-result' || data.requestId !== requestId || data.action !== type) return;
          finish(data.ok === true && data.handled !== false && !data.error ? { ok: true }
            : { ok: false, error: typeof data.error === 'string' && data.error.trim()
              ? data.error.slice(0, 300) : 'The extension could not complete this request. Please try again.' });
        };
        const timer = setTimeout(() => finish({ ok: false,
          error: 'No reply from the extension. Check Stremio before trying again, or refresh this page.' }), timeoutMs);
        window.addEventListener('message', onMessage);
        try { window.postMessage({ ...detail, type, requestId }, location.origin); }
        catch { finish({ ok: false, error: 'The extension could not receive this request. Refresh this page.' }); }
      });
    }

    async function runWebsiteButton(button, type, detail = {}) {
      if (!button || button.disabled || !ensureExtensionInstalled()) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      showWebsiteActionStatus('Asking the extension…');
      try {
        const result = await requestExtensionAction(type, detail);
        showWebsiteActionStatus(result.ok ? '' : result.error);
        if (result.ok) scheduleLandingPresenceRefresh();
        return result;
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }

    function handoffToStremio(url) {
      if (!document.documentElement.hasAttribute('data-watchparty-ext')) {
        return Promise.resolve({ ok: false, error: 'The extension is unavailable. Refresh this page before opening your room.' });
      }
      return requestExtensionAction('watchparty-open-stremio', {
        url: url || 'https://web.stremio.com',
      });
    }

    function requestExtensionStatus(timeoutMs = 1200) {
      if (!document.documentElement.hasAttribute('data-watchparty-ext')) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const requestId = `watchparty-ext-status-${Date.now()}-${++extStatusRequestSeq}`;
        let settled = false;
        const cleanup = () => {
          window.removeEventListener('message', onMessage);
          clearTimeout(timer);
        };
        const finish = (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };
        const onMessage = (event) => {
          if (event.source !== window) return;
          if (event.origin !== location.origin) return;
          if (event.data?.type !== 'watchparty-ext-response') return;
          if (event.data.requestId !== requestId) return;
          finish(event.data.data || null);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        window.addEventListener('message', onMessage);
        window.postMessage({
          type: 'watchparty-ext-request',
          action: 'status.get',
          requestId,
        }, location.origin);
      });
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      if (event.data?.type === 'watchparty-ext-ready' || event.data?.type === 'watchparty-ext-profile') {
        extensionUnavailable = false;
        void refreshLandingPresence();
      } else if (event.data?.type === 'watchparty-ext-unavailable') {
        extensionUnavailable = true;
        landingPresenceRequestSeq += 1;
        updateLandingPresence(null);
        showWebsiteActionStatus('The extension changed or disconnected. Refresh this page to reconnect.');
      } else if (event.data?.type === 'watchparty-ext-status') {
        const pushedStatus = event.data.data && typeof event.data.data === 'object' ? event.data.data : null;
        if (pushedStatus) {
          landingPresenceRequestSeq += 1;
          updateLandingPresence({ ...(latestExtensionStatus || {}), ...pushedStatus }, { preserveExisting: true });
          observeWebsiteMembership(pushedStatus);
          const error = pushedStatus.lastRoomError;
          if (lastRequestedRoomId && error?.roomId === lastRequestedRoomId && error.command === 'room.join') {
            const message = `Stremio reported: ${typeof error.message === 'string' ? error.message.slice(0, 250) : 'The room could not be joined.'}`;
            if (roomMatch) reportRedirectJoinError(message);
            else {
              showWebsiteActionStatus(message, 'rooms');
              if (latestWebsiteJoin?.roomId === error.roomId && !latestWebsiteJoin.confirmed) {
                latestWebsiteJoin.error = message;
                if (!latestWebsiteJoin.options.isCurrent || latestWebsiteJoin.options.isCurrent()) latestWebsiteJoin.options.onError?.(message);
              }
            }
          }
        }
      }
    });

    function syncRoomPoster(slot, room) {
      let posterUrl = '';
      try {
        const candidate = new URL(room.meta?.poster || '');
        if (candidate.protocol === 'https:' && !candidate.username && !candidate.password) posterUrl = candidate.href;
      } catch {}
      const current = slot.firstElementChild;
      if (posterUrl) {
        if (current?.tagName === 'IMG') {
          if (current.src !== posterUrl) current.src = posterUrl;
          return;
        }
        const img = document.createElement('img');
        img.className = 'room-poster';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.addEventListener('error', () => {
          if (slot.firstElementChild === img) {
            const placeholder = document.createElement('div');
            placeholder.className = 'room-poster';
            slot.replaceChildren(placeholder);
          }
        }, { once: true });
        img.src = posterUrl;
        slot.replaceChildren(img);
        return;
      }
      if (current?.tagName === 'DIV' && current.classList.contains('room-poster')) return;
      const placeholder = document.createElement('div');
      placeholder.className = 'room-poster';
      slot.replaceChildren(placeholder);
    }

    function createRoomCard() {
      const card = document.createElement('div');
      card.className = 'room-card';
      card.__room = null;

      const posterSlot = document.createElement('div');
      posterSlot.className = 'room-poster-slot';
      card.appendChild(posterSlot);

      const info = document.createElement('div');
      info.className = 'room-info';
      const title = document.createElement('h3');
      title.className = 'room-title';
      info.appendChild(title);
      const metaLine1 = document.createElement('div');
      metaLine1.className = 'room-meta';
      info.appendChild(metaLine1);
      const metaLine2 = document.createElement('div');
      metaLine2.className = 'room-meta';
      info.appendChild(metaLine2);
      card.appendChild(info);

      const users = document.createElement('div');
      users.className = 'room-users';
      card.appendChild(users);

      const actions = document.createElement('div');
      actions.className = 'room-actions';

      const joinBtn = document.createElement('button');
      joinBtn.className = 'room-join-btn';
      joinBtn.textContent = 'Join room';
      joinBtn.addEventListener('click', () => {
        const room = card.__room;
        if (!room) return;
        if (room.public === false) {
          openPrivateJoinModal({
            roomId: room.id,
            metaId: room.meta?.id || '',
            metaType: room.meta?.type || '',
            preferDirectJoin: false,
          });
          return;
        }
        joinRoom(room.id, room.meta?.id || '', room.meta?.type || '');
      });
      actions.appendChild(joinBtn);

      const directBtn = document.createElement('button');
      directBtn.className = 'room-direct-btn';
      directBtn.textContent = 'Watch host stream';
      directBtn.addEventListener('click', () => {
        const room = card.__room;
        if (!room) return;
        const directJoinType = getDirectJoinType(room);
        if (room.public === false) {
          if (directJoinType === 'debrid-url') {
            showDirectJoinNotice(getDirectJoinTitle(room));
          }
          openPrivateJoinModal({
            roomId: room.id,
            metaId: room.meta?.id || '',
            metaType: room.meta?.type || '',
            preferDirectJoin: room?.hasDirectJoin === true && directJoinType !== 'debrid-url',
          });
          return;
        }
        if (directJoinType === 'debrid-url') {
          showDirectJoinNotice(getDirectJoinTitle(room));
          joinRoom(room.id, room.meta?.id || '', room.meta?.type || '');
          return;
        }
        if (room?.hasDirectJoin === true) {
          joinRoom(room.id, room.meta?.id || '', room.meta?.type || '', { preferDirectJoin: true });
        }
      });
      actions.appendChild(directBtn);

      card.appendChild(actions);
      card.__elements = {
        posterSlot,
        title,
        metaLine1,
        metaLine2,
        users,
        joinBtn,
        directBtn,
      };
      return card;
    }

    function updateRoomCard(card, room) {
      card.__room = room;
      card.dataset.roomId = room.id;
      const { posterSlot, title, metaLine1, metaLine2, users, joinBtn, directBtn } = card.__elements;
      const playbackTime = Math.max(0, Number(room.time) || 0);
      const mins = Math.floor(playbackTime / 60);
      const secs = Math.floor(playbackTime % 60).toString().padStart(2, '0');
      const isPublic = room.public !== false;
      const directJoinType = getDirectJoinType(room);
      const isReconnectListing = room.listingState === 'reconnecting';
      const graceMinutes = Math.max(1, Math.ceil((room.graceRemainingMs || 0) / 60000));

      syncRoomPoster(posterSlot, room);
      card.classList.toggle('room-card-reconnecting', isReconnectListing);
      title.textContent = room.name || room.meta?.name || 'Untitled';
      metaLine1.textContent = `Hosted by ${room.owner || 'a WatchParty member'}${isPublic ? '' : ' · Invite required'}`;
      metaLine2.textContent = `${room.paused ? 'Paused' : 'Playing'} ${mins}:${secs}`;
      metaLine2.hidden = !getRecognizedTitleKey(room) || isReconnectListing;
      users.classList.toggle('room-users-reconnecting', isReconnectListing);
      users.textContent = isReconnectListing ? 'Reconnecting…' : pluralize(Math.max(0, Number(room.users) || 0), 'person', 'people');
      joinBtn.title = isPublic ? '' : 'Invite key required to join this room.';
      users.title = isReconnectListing
        ? `The host connection dropped. Keeping this room visible for about ${graceMinutes} minute${graceMinutes === 1 ? '' : 's'} while WatchParty reconnects.`
        : '';
      directBtn.title = getDirectJoinTitle(room);
      const directAvailable = room?.hasDirectJoin === true || directJoinType === 'debrid-url';
      joinBtn.disabled = !!pendingWebsiteJoin;
      directBtn.disabled = !!pendingWebsiteJoin || !directAvailable;
      directBtn.hidden = !directAvailable;
      directBtn.textContent = directJoinType === 'debrid-url' ? 'Choose a stream' : 'Watch host stream';
    }

    const roomCardNodes = new Map();
    function updateJoinPendingControls() {
      for (const card of roomCardNodes.values()) updateRoomCard(card, card.__room);
      for (const id of ['hero-private-btn', 'rooms-private-btn']) {
        const button = document.getElementById(id);
        if (button) button.disabled = !!pendingWebsiteJoin;
      }
    }
    let lastRoomsRevision = -1;
    let roomsSnapshotSeq = 0;
    let hasLoadedRooms = false;
    let roomsLoadPending = false;
    let roomsStreamGeneration = 0;

    function setRoomsAvailability(state) {
      const status = document.getElementById('rooms-status');
      const retry = document.getElementById('rooms-refresh-btn');
      if (status) {
        status.textContent = state === 'loading' ? 'Finding rooms…'
          : state === 'error' ? (hasLoadedRooms
            ? 'Connection lost. These rooms may be out of date.'
            : 'We couldn’t load the rooms. Try again in a moment.') : '';
      }
      if (retry) {
        retry.hidden = state !== 'error';
        retry.classList.toggle('hidden', state !== 'error');
      }
      if (state !== 'ready') document.getElementById('rooms-empty').style.display = 'none';
      if (!hasLoadedRooms && state === 'error') {
        document.getElementById('hero-live-summary')?.classList.add('hidden');
      }
      document.getElementById('rooms-list')?.setAttribute('aria-busy', String(state === 'loading'));
    }

    function applyRoomsSnapshot(data) {
      const list = document.getElementById('rooms-list');
      const empty = document.getElementById('rooms-empty');
      if (!list || !empty) return;
      if (!Array.isArray(data?.rooms)) return;
      const snapshotIds = new Set();
      if (data.rooms.some(room => {
        if (!room || typeof room.id !== 'string' || !/^[a-z0-9-]+$/i.test(room.id) || snapshotIds.has(room.id)) return true;
        snapshotIds.add(room.id);
        return false;
      })) {
        setRoomsAvailability('error');
        return;
      }
      const revision = Number.isFinite(data?.revision) ? Number(data.revision) : null;
      if (revision !== null && revision < lastRoomsRevision) return;
      // HTTP listings are paginated, while the live stream is complete.
      if (revision === lastRoomsRevision && Number(data.total) > data.rooms.length
          && roomCardNodes.size > data.rooms.length) {
        setRoomsAvailability('ready');
        return;
      }
      if (revision !== null) lastRoomsRevision = revision;
      lastRoomsUpdateAt = Date.now();
      roomsSnapshotSeq += 1;
      hasLoadedRooms = true;
      setRoomsAvailability('ready');
      document.getElementById('hero-live-summary')?.classList.remove('hidden');
      const focusedControl = list.contains(document.activeElement) ? document.activeElement : null;

      const rooms = Array.isArray(data?.rooms) ? data.rooms : [];
      updateLandingStats({
        ...data,
        rooms,
        summary: data?.summary && typeof data.summary === 'object'
          ? data.summary
          : undefined,
      });
      const nextRoomIds = new Set();
      let anchor = empty;
      empty.textContent = 'No rooms right now. Create one in Stremio and invite your friends.';
      empty.style.display = rooms.length === 0 ? 'block' : 'none';

      for (const room of rooms) {
        nextRoomIds.add(room.id);
        let card = roomCardNodes.get(room.id);
        if (!card) {
          card = createRoomCard();
          roomCardNodes.set(room.id, card);
        }
        updateRoomCard(card, room);
        if (anchor.nextSibling !== card) {
          if (card.parentElement === list && typeof list.moveBefore === 'function') {
            list.moveBefore(card, anchor.nextSibling);
          } else {
            list.insertBefore(card, anchor.nextSibling);
          }
        }
        anchor = card;
      }

      for (const [roomId, card] of roomCardNodes.entries()) {
        if (nextRoomIds.has(roomId)) continue;
        roomCardNodes.delete(roomId);
        card.remove();
      }
      // Reordering live cards must not kick a keyboard user back to the page top.
      if (focusedControl && (document.activeElement !== focusedControl || focusedControl.hidden)) {
        const fallback = focusedControl.isConnected && !focusedControl.hidden ? focusedControl
          : list.querySelector('.room-join-btn') || document.getElementById('rooms-private-btn');
        fallback?.focus({ preventScroll: true });
      }
    }

    let roomsEventSource = null;
    let streamReconnectTimer = null;

    async function fetchRoomsSnapshot(signal, stillCurrent) {
      // The HTTP API is paginated (50 max per page). Do not show a first page
      // as though it were a complete snapshot, or merge pages from revisions.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let firstPage = null;
        const rooms = [];
        const ids = new Set();
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          const res = await fetch(`${ROOMS_API}?limit=50&offset=${rooms.length}`, { signal, cache: 'no-store' });
          if (!res.ok) throw new Error('Room list unavailable');
          const data = await res.json();
          if (!stillCurrent()) return null;
          if (!Array.isArray(data?.rooms)) throw new Error('Invalid room list');
          const total = Number.isInteger(data.total) && data.total >= 0 ? data.total : data.rooms.length;
          if (data.offset !== undefined && data.offset !== rooms.length) throw new Error('Invalid room page');
          if (!firstPage) firstPage = { ...data, total };
          else if (data.revision !== firstPage.revision || total !== firstPage.total) {
            if (attempt === 0) break;
            throw new Error('Room list changed while loading');
          }
          for (const room of data.rooms) {
            if (!room || typeof room.id !== 'string' || !room.id || ids.has(room.id)) throw new Error('Invalid room page');
            ids.add(room.id);
            rooms.push(room);
          }
          if (rooms.length === firstPage.total) return { ...firstPage, rooms };
          if (rooms.length > firstPage.total || data.rooms.length === 0) throw new Error('Incomplete room list');
          if (pageIndex === 19) throw new Error('Room list exceeds the fallback limit');
        }
      }
      throw new Error('Room list changed while loading');
    }

    async function loadPublicRooms() {
      if (roomsLoadPending) return;
      roomsLoadPending = true;
      const snapshotAtRequest = roomsSnapshotSeq;
      const generationAtRequest = roomsStreamGeneration;
      const stillCurrent = () => roomsSnapshotSeq === snapshotAtRequest && roomsStreamGeneration === generationAtRequest;
      if (!hasLoadedRooms) setRoomsAvailability('loading');
      try {
        const data = await fetchRoomsSnapshot(AbortSignal.timeout(5000), stillCurrent);
        // Do not replace a newer full SSE snapshot with a delayed HTTP page.
        if (!data || !stillCurrent()) return;
        // With no intervening stream update, a fresh consistent HTTP snapshot
        // can also recover from a restarted server when SSE is unavailable.
        if (Number.isFinite(data.revision) && data.revision < lastRoomsRevision) lastRoomsRevision = -1;
        applyRoomsSnapshot(data);
      } catch {
        if (roomsSnapshotSeq === snapshotAtRequest) setRoomsAvailability('error');
      } finally {
        roomsLoadPending = false;
      }
    }

    function stopRoomsStream() {
      sseActive = false;
      if (streamReconnectTimer) {
        clearTimeout(streamReconnectTimer);
        streamReconnectTimer = null;
      }
      if (roomsEventSource) {
        try { roomsEventSource.close(); } catch {}
        roomsEventSource = null;
      }
    }

    function scheduleRoomsStreamReconnect(delay = 1500) {
      if (streamReconnectTimer) return;
      streamReconnectTimer = setTimeout(() => {
        streamReconnectTimer = null;
        ensureRoomsStream({ force: true });
      }, delay);
    }

    function ensureRoomsStream(options = {}) {
      const force = options.force === true;
      if (force) stopRoomsStream();
      if (roomsEventSource) return;
      try {
        const source = new EventSource(ROOMS_STREAM);
        roomsStreamGeneration += 1;
        let firstSnapshot = true;
        roomsEventSource = source;
        source.onopen = () => {
          if (roomsEventSource !== source) return;
          sseActive = true;
        };
        source.onmessage = (event) => {
          if (roomsEventSource !== source) return;
          try {
            const data = JSON.parse(event.data);
            if (!Array.isArray(data?.rooms)) return;
            if (!Number.isFinite(data?.revision) && event.lastEventId) {
              const revision = Number.parseInt(event.lastEventId, 10);
              if (Number.isFinite(revision)) data.revision = revision;
            }
            // Revisions restart at zero when the backend process restarts.
            if (firstSnapshot) lastRoomsRevision = -1;
            firstSnapshot = false;
            applyRoomsSnapshot(data);
            sseActive = true;
          } catch {}
        };
        source.onerror = () => {
          if (roomsEventSource !== source) return;
          roomsEventSource = null;
          sseActive = false;
          try { source.close(); } catch {}
          // If the stream drops after it has worked once, keep the room list fresh via polling.
          void loadPublicRooms();
          startPollingFallback();
          scheduleRoomsStreamReconnect();
        };
      } catch {
        // EventSource not available - fall back to polling
        startPollingFallback();
        scheduleRoomsStreamReconnect(3000);
      }
    }

    function refreshRoomsNow(options = {}) {
      if (roomMatch) return;
      if (options.restartStream === true || !roomsEventSource) {
        ensureRoomsStream({ force: options.restartStream === true });
      }
      void loadPublicRooms();
    }

    // Live updates via SSE (Server-Sent Events) with polling fallback
    const ROOMS_STREAM = ROOMS_API + '/stream';
    let sseActive = false;
    let pollingStarted = false;
    let lastRoomsUpdateAt = 0;
    function startPollingFallback() {
      if (pollingStarted) return;
      pollingStarted = true;
      setInterval(loadPublicRooms, 10000);
    }
    // Also poll as fallback for SSE reconnect gaps or silently stale connections.
    setInterval(() => {
      const stale = !lastRoomsUpdateAt || (Date.now() - lastRoomsUpdateAt) > 20000;
      if (!roomMatch && (!sseActive || stale)) loadPublicRooms();
    }, 15000);

    window.addEventListener('pageshow', (event) => {
      refreshRoomsNow({ restartStream: !!event.persisted });
      void refreshLandingPresence();
    });
    window.addEventListener('focus', () => {
      refreshRoomsNow();
      void refreshLandingPresence();
    });
    window.addEventListener('online', () => {
      refreshRoomsNow({ restartStream: true });
      void refreshLandingPresence();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshRoomsNow();
        void refreshLandingPresence();
      }
    });
    window.addEventListener('pagehide', () => {
      stopRoomsStream();
      clearScheduledPresenceRefreshes();
    });
    window.addEventListener('hashchange', () => {
      // Pasting an updated invite for the current /r/:id route is a
      // same-document navigation. Start a fresh handoff with its new keys;
      // the previous redirect closure has already completed its one join.
      if (!roomMatch || location.pathname !== path) return;
      const keys = parseInviteKeysFromHash(location.hash);
      if (keys.accessKey || keys.e2eKey) location.reload();
    });

    async function joinRoom(roomId, metaId, metaType, options = {}) {
      if (pendingWebsiteJoin || !ensureExtensionInstalled()) return false;
      const username = ensurePreferredUsername();
      if (!username) return false;
      // Only the /r/:roomId route owns keys in its URL. Browsing a different
      // room must never attach keys left in an unrelated fragment.
      const hashKeys = roomMatch?.[1] === roomId
        ? parseInviteKeysFromHash(window.location.hash) : { accessKey: '', e2eKey: '' };
      const accessKey = (typeof options.accessKey === 'string' && options.accessKey.trim())
        ? options.accessKey.trim()
        : hashKeys.accessKey;
      const e2eKey = (typeof options.e2eKey === 'string' && options.e2eKey.trim())
        ? options.e2eKey.trim()
        : hashKeys.e2eKey;
      const intent = { roomId, options, confirmed: false, error: '' };
      pendingWebsiteJoin = intent;
      latestWebsiteJoin = intent;
      lastRequestedRoomId = roomId;
      updateJoinPendingControls();
      showWebsiteActionStatus('Sending your room request…', 'rooms');
      try {
      const result = await requestExtensionAction('watchparty-join-room', {
        roomId,
        username,
        accessKey: accessKey || undefined,
        e2eKey: e2eKey || undefined,
        preferDirectJoin: options.preferDirectJoin === true,
      });
      if (options.isCurrent && !options.isCurrent()) return false;
      if (intent.error) return false;
      if (!result.ok) {
        showWebsiteActionStatus(result.error, 'rooms');
        options.onError?.(result.error);
        return false;
      }
      showWebsiteActionStatus('Join request accepted. Check Stremio to finish joining.', 'rooms');
      scheduleLandingPresenceRefresh();
      const fallbackUrl = options.preferDirectJoin !== true && (metaId && metaId !== 'pending' && metaId !== 'unknown' && metaType)
        ? `https://web.stremio.com/#/detail/${encodeURIComponent(metaType)}/${encodeURIComponent(metaId)}`
        : 'https://web.stremio.com';
      const opened = await handoffToStremio(fallbackUrl);
      if (intent.error) return false;
      if ((!options.isCurrent || options.isCurrent()) && !opened.ok) showWebsiteActionStatus(opened.error, 'rooms');
      return true;
      } finally {
        if (pendingWebsiteJoin === intent) {
          pendingWebsiteJoin = null;
          updateJoinPendingControls();
        }
      }
    }

    // --- Private access key / invite modal ---
    function openPrivateJoinModal(options = {}) {
      if (pendingWebsiteJoin) return;
      if (!ensureExtensionInstalled()) return;
      const username = ensurePreferredUsername();
      if (!username) return;
      modalReturnFocus = document.activeElement;
      pendingPrivateJoin = {
        roomId: options.roomId || '',
        metaId: options.metaId || '',
        metaType: options.metaType || '',
        preferDirectJoin: options.preferDirectJoin === true,
      };
      const titleEl = document.getElementById('uuid-title');
      const descriptionEl = document.getElementById('uuid-description');
      const inputEl = document.getElementById('uuid-input');
      const hasSpecificRoom = !!pendingPrivateJoin.roomId;
      if (titleEl) titleEl.textContent = hasSpecificRoom ? 'Join an invite-only room' : 'Join with an invite';
      if (descriptionEl) {
        descriptionEl.textContent = hasSpecificRoom
          ? 'Enter the access key, or paste the full invite link shared by the host.'
          : 'Paste an invite link, or enter a room ID. Invite-only rooms need the full link from the host.';
      }
      document.getElementById('uuid-modal').style.display = 'flex';
      document.getElementById('page-landing').inert = true;
      document.getElementById('page-redirect').inert = true;
      inputEl.value = '';
      inputEl.placeholder = hasSpecificRoom ? 'Access key or invite link' : 'Invite link or room ID';
      inputEl.setAttribute('aria-label', hasSpecificRoom ? 'Access key or invite link' : 'Invite link or room ID');
      inputEl.removeAttribute('aria-invalid');
      document.getElementById('uuid-cancel-btn').textContent = 'Cancel';
      inputEl.disabled = false;
      document.getElementById('uuid-submit-btn').disabled = false;
      document.getElementById('uuid-submit-btn').removeAttribute('aria-busy');
      document.getElementById('uuid-error').style.display = 'none';
      document.getElementById('uuid-status').textContent = '';
      inputEl.focus();
    }
    function closeUuidModal() {
      clearTimeout(pendingPrivateJoin?.membershipTimer);
      pendingPrivateJoin = null;
      document.getElementById('uuid-error').style.display = 'none';
      document.getElementById('uuid-modal').style.display = 'none';
      document.getElementById('uuid-input').value = '';
      document.getElementById('uuid-status').textContent = '';
      document.getElementById('page-landing').inert = false;
      document.getElementById('page-redirect').inert = false;
      if (modalReturnFocus?.isConnected) modalReturnFocus.focus({ preventScroll: true });
      modalReturnFocus = null;
    }
    async function submitUuid() {
      const input = document.getElementById('uuid-input');
      const pendingJoin = pendingPrivateJoin;
      if (!pendingJoin || pendingWebsiteJoin || (pendingJoin.awaitingMembership && !pendingJoin.joinError)) return;
      const joinRequest = parsePrivateJoinInput(input.value, pendingJoin?.roomId || '');
      const wrongRoom = pendingJoin.roomId && joinRequest.roomId && pendingJoin.roomId !== joinRequest.roomId;
      if (!joinRequest.roomId || (pendingJoin.roomId && !joinRequest.accessKey) || wrongRoom) {
        input.focus();
        input.setAttribute('aria-invalid', 'true');
        document.getElementById('uuid-error').textContent = wrongRoom
          ? 'That invite is for a different room. Paste the invite for this room.'
          : pendingJoin.roomId ? 'Enter an access key, or paste the full invite link.'
            : 'Paste a valid invite link, or enter a room ID.';
        document.getElementById('uuid-error').style.display = 'block';
        return;
      }
      const submit = document.getElementById('uuid-submit-btn');
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      input.disabled = true;
      document.getElementById('uuid-cancel-btn').textContent = 'Close';
      const showJoinError = message => {
        clearTimeout(pendingJoin.membershipTimer);
        pendingJoin.joinError = message;
        document.getElementById('uuid-status').textContent = '';
        document.getElementById('uuid-error').textContent = message;
        document.getElementById('uuid-error').style.display = 'block';
        if (pendingJoin.awaitingMembership) {
          input.disabled = false;
          submit.disabled = false;
          submit.removeAttribute('aria-busy');
          document.getElementById('uuid-cancel-btn').textContent = 'Cancel';
        }
      };
      pendingJoin.joinError = '';
      pendingJoin.confirmed = false;
      pendingJoin.awaitingMembership = false;
      document.getElementById('uuid-error').style.display = 'none';
      document.getElementById('uuid-status').textContent = 'Sending your room request…';
      const accepted = await joinRoom(
        joinRequest.roomId,
        pendingJoin?.metaId || '',
        pendingJoin?.metaType || '',
        {
          preferDirectJoin: pendingJoin?.preferDirectJoin === true,
          accessKey: joinRequest.accessKey,
          e2eKey: joinRequest.e2eKey,
          isCurrent: () => pendingPrivateJoin === pendingJoin,
          onError: showJoinError,
          onMembershipConfirmed: () => {
            if (pendingPrivateJoin !== pendingJoin) return;
            pendingJoin.confirmed = true;
            if (pendingJoin.awaitingMembership) closeUuidModal();
          },
        },
      );
      if (pendingPrivateJoin !== pendingJoin) return;
      if (accepted && !pendingJoin.confirmed && !pendingJoin.joinError) {
        pendingJoin.awaitingMembership = true;
        document.getElementById('uuid-status').textContent = 'Request sent. Waiting for Stremio to confirm membership…';
        pendingJoin.membershipTimer = setTimeout(() => {
          if (pendingPrivateJoin === pendingJoin) showJoinError('Room membership was not confirmed. Check Stremio before retrying, or ask the host for a fresh full invite link.');
        }, 15000);
        return;
      }
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      input.disabled = false;
      document.getElementById('uuid-cancel-btn').textContent = 'Cancel';
      if (accepted) closeUuidModal();
      else input.focus();
    }
    // Modal button listeners
    document.getElementById('uuid-cancel-btn').addEventListener('click', closeUuidModal);
    document.getElementById('uuid-submit-btn').addEventListener('click', submitUuid);
    document.getElementById('uuid-input').addEventListener('input', event => {
      event.target.removeAttribute('aria-invalid');
      document.getElementById('uuid-error').style.display = 'none';
    });
    // Allow Enter key in modal
    document.getElementById('uuid-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitUuid(); }
    });
    document.addEventListener('keydown', (event) => {
      if (!pendingPrivateJoin) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeUuidModal();
        return;
      }
      if (event.key !== 'Tab') return;
      const modal = document.getElementById('uuid-modal');
      const controls = [...modal.querySelectorAll('input:not([disabled]), button:not([disabled]), a[href]')].filter(control => !control.hidden);
      const first = controls[0];
      const last = controls.at(-1);
      if (!modal.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
    // Close modal on overlay click
    document.getElementById('uuid-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeUuidModal();
    });
    document.getElementById('hero-primary-btn')?.addEventListener('click', event => {
      void runWebsiteButton(event.currentTarget, 'watchparty-open-stremio', { url: 'https://web.stremio.com' });
    });
    document.getElementById('hero-private-btn')?.addEventListener('click', () => {
      openPrivateJoinModal();
    });
    document.getElementById('rooms-private-btn')?.addEventListener('click', () => {
      openPrivateJoinModal();
    });
    document.getElementById('rooms-refresh-btn')?.addEventListener('click', () => {
      setRoomsAvailability('loading');
      refreshRoomsNow({ restartStream: true });
    });
    document.getElementById('hero-resume-btn')?.addEventListener('click', event => {
      if (!latestExtensionStatus?.room?.id) return;
      void runWebsiteButton(event.currentTarget, 'watchparty-resume-room', { roomId: latestExtensionStatus.room.id });
    });
    document.getElementById('hero-settings-btn')?.addEventListener('click', event => {
      void runWebsiteButton(event.currentTarget, 'watchparty-open-options');
    });

    // --- Redirect page (/r/ROOM_ID) ---
    function showRedirectPage(roomId) {
      document.getElementById('page-landing').style.display = 'none';
      document.getElementById('page-redirect').style.display = 'block';
      document.getElementById('redirect-room-id').textContent = roomId;
      const inviteKeys = parseInviteKeysFromHash(window.location.hash);
      const username = normalizeUsername(getStoredUsername());
      const joinMessage = () => ({
        type: 'watchparty-join-room',
        roomId,
        username: username || undefined,
        accessKey: inviteKeys.accessKey || undefined,
        e2eKey: inviteKeys.e2eKey || undefined,
      });
      const button = document.getElementById('redirect-btn');
      const retry = document.getElementById('redirect-retry-btn');
      let accepted = false;
      let membershipConfirmed = false;
      let attempted = false;
      let inFlight = false;
      let attemptGeneration = 0;
      let membershipTimer = null;
      let extCheck = null;
      const status = document.getElementById('redirect-status');
      reportRedirectJoinError = message => {
        if (!attempted || membershipConfirmed) return;
        attemptGeneration += 1;
        accepted = false;
        inFlight = false;
        clearTimeout(membershipTimer);
        button.removeAttribute('aria-busy');
        button.style.display = 'none';
        status.textContent = message;
        if (retry) { retry.hidden = false; retry.textContent = 'Try joining again'; }
      };
      observeRedirectMembership = roomStatus => {
        if (!attempted || !isConnectedRoomMember(roomStatus, roomId)) return;
        membershipConfirmed = true;
        accepted = true;
        clearTimeout(membershipTimer);
        clearInviteHashFromAddressBar();
        status.textContent = 'Your room is connected in Stremio.';
        button.href = 'https://web.stremio.com';
        button.removeAttribute('target');
        button.textContent = 'Open Stremio';
        button.style.display = 'inline-flex';
        if (retry) retry.hidden = true;
      };
      async function openAcceptedRoom() {
        if (inFlight) return;
        const generation = attemptGeneration;
        inFlight = true;
        button.setAttribute('aria-busy', 'true');
        const result = await handoffToStremio('https://web.stremio.com');
        if (generation !== attemptGeneration) return;
        inFlight = false;
        button.removeAttribute('aria-busy');
        status.textContent = !result.ok ? result.error : membershipConfirmed ? 'Your room is connected in Stremio.'
          : 'Stremio was opened. Finish joining your room there.';
      }
      function continueToRoom(force = false) {
        if (accepted || inFlight || (attempted && force !== true) || !document.documentElement.hasAttribute('data-watchparty-ext')) return false;
        attempted = true;
        inFlight = true;
        membershipConfirmed = false;
        const generation = ++attemptGeneration;
        lastRequestedRoomId = roomId;
        clearTimeout(extCheck);
        document.getElementById('no-ext-warning').style.display = 'none';
        status.textContent = 'Sending your room request…';
        button.style.display = 'none';
        if (retry) retry.hidden = true;
        void requestExtensionAction('watchparty-join-room', joinMessage()).then(async result => {
          if (generation !== attemptGeneration) return;
          inFlight = false;
          if (!result.ok) {
            status.textContent = result.error;
            if (retry) {
              retry.hidden = false;
              retry.textContent = extensionUnavailable || !extensionSupportsActionResults() ? 'Refresh this page' : 'Try joining again';
            }
            return;
          }
          accepted = true;
          button.href = 'https://web.stremio.com';
          button.removeAttribute('target');
          button.textContent = 'Open Stremio';
          button.style.display = 'inline-flex';
          if (!membershipConfirmed) membershipTimer = setTimeout(() => {
            reportRedirectJoinError('Room membership was not confirmed. Check Stremio before retrying, or ask the host for a fresh full invite link.');
          }, 15000);
          scheduleLandingPresenceRefresh();
          await openAcceptedRoom();
        });
        return true;
      }
      function showInstallHelp() {
        if (accepted || inFlight || attempted) return;
        document.getElementById('no-ext-warning').style.display = 'block';
        document.getElementById('redirect-status').textContent = 'Install WatchParty, then come back to this tab and try again.';
        button.href = CHROME_WEB_STORE_URL;
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
        button.textContent = 'Install WatchParty';
        button.style.display = 'inline-flex';
        if (retry) retry.hidden = false;
      }
      button.addEventListener('click', (event) => {
        if (extensionUnavailable) {
          event.preventDefault();
          status.textContent = 'The extension changed or disconnected. Refresh this page to reconnect.';
          return;
        }
        if (!document.documentElement.hasAttribute('data-watchparty-ext')) return;
        event.preventDefault();
        if (accepted) void openAcceptedRoom();
        else continueToRoom(true);
      });
      retry?.addEventListener('click', () => {
        if (inFlight) return;
        if (extensionSupportsActionResults() && continueToRoom(true)) return;
        if (accepted && !extensionUnavailable) { void openAcceptedRoom(); return; }
        // A newly installed content script may require a page reload. Keep
        // keys only in the fragment until an extension can receive the join.
        const keys = new URLSearchParams();
        if (inviteKeys.accessKey) keys.set('accessKey', inviteKeys.accessKey);
        if (inviteKeys.e2eKey) keys.set('e2eKey', inviteKeys.e2eKey);
        history.replaceState(history.state, document.title,
          `${location.pathname}${location.search}${keys.size ? `#${keys}` : ''}`);
        location.reload();
      });
      window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        if (['watchparty-ext-ready', 'watchparty-ext-profile'].includes(event.data?.type)) continueToRoom();
        if (event.data?.type === 'watchparty-ext-unavailable') {
          status.textContent = 'The extension changed or disconnected. Refresh this page to reconnect.';
          document.getElementById('no-ext-warning').style.display = 'none';
          button.style.display = 'none';
          if (retry) { retry.hidden = false; retry.textContent = 'Refresh this page'; }
        }
      });
      document.addEventListener('watchparty-ext-ready', continueToRoom);
      if (retry) retry.hidden = true;
      if (!continueToRoom()) extCheck = setTimeout(showInstallHelp, 1200);
    }

    // Skip navigation should move focus, not replace an unconsumed invite
    // fragment while someone is installing the extension.
    for (const link of document.querySelectorAll('.skip-link')) {
      link.addEventListener('click', (event) => {
        const targetId = link.getAttribute('href')?.replace(/^#/, '');
        const target = targetId ? document.getElementById(targetId) : null;
        if (!target) return;
        event.preventDefault();
        target.focus?.({ preventScroll: true });
        target.scrollIntoView?.({ block: 'start' });
      });
    }

    // Start only after state, handlers and live-list constants are initialized.
    if (roomMatch) {
      showRedirectPage(roomMatch[1]);
    } else {
      ensureRoomsStream();
      showLandingPage();
    }
