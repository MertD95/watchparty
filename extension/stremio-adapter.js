// WatchParty Stremio adapter helpers.
// Keeps Stremio route/content detection outside the controller orchestrator.

const WPStremioAdapter = (() => {
  'use strict';

  let lastKnownContentMeta = null;

  function parseDetailHash(hash) {
    const m = (hash || '').match(/^#\/(?:detail|metadetails)\/([^/?#]+)\/([^/?#]+)/);
    if (!m) return null;
    return {
      type: decodeURIComponent(m[1]),
      id: decodeURIComponent(m[2]),
    };
  }

  function parsePlayerHash(hash) {
    const m = (hash || '').match(/^#\/player\/([^/?#]+)(?:\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+))?/);
    if (!m) return null;
    return {
      stream: decodeURIComponent(m[1]),
      streamTransportUrl: m[2] ? decodeURIComponent(m[2]) : null,
      metaTransportUrl: m[3] ? decodeURIComponent(m[3]) : null,
      type: m[4] ? decodeURIComponent(m[4]) : null,
      id: m[5] ? decodeURIComponent(m[5]) : null,
      videoId: m[6] ? decodeURIComponent(m[6]) : null,
    };
  }

  function getCurrentLaunchUrl(hash = window.location.hash) {
    if (!/^#\/(?:detail|metadetails|player)\//.test(hash || '')) return null;
    return `${window.location.origin}/${hash}`;
  }

  function getContentTitle() {
    const navHeading = document.querySelector('nav h2, main h1, h1[data-testid="title"]');
    if (navHeading?.textContent?.trim()) return navHeading.textContent.trim();
    const logoTitleEl = document.querySelector('[class*="logo"][title], [class*="logo-container"] img[title], img[class*="logo"][title]');
    const title = logoTitleEl?.getAttribute?.('title')?.trim() || '';
    if (title) return title;
    const logoImg = document.querySelector('[class*="logo-container"] img, img[class*="logo"]');
    if (logoImg instanceof HTMLImageElement && logoImg.alt.trim()) return logoImg.alt.trim();
    return null;
  }

  function updateKnownContentMeta(hash = window.location.hash) {
    const info = parseDetailHash(hash);
    const playerInfo = parsePlayerHash(hash);
    const nextInfo = info || (playerInfo?.type && playerInfo.id
      ? { type: playerInfo.type, id: playerInfo.id }
      : null);
    if (!nextInfo) return lastKnownContentMeta;
    lastKnownContentMeta = {
      id: nextInfo.id,
      type: nextInfo.type,
      name: getContentTitle() || lastKnownContentMeta?.name || nextInfo.id,
    };
    return { ...lastKnownContentMeta };
  }

  function getCurrentContentContext(hash = window.location.hash) {
    const launchUrl = getCurrentLaunchUrl(hash);
    const detailInfo = parseDetailHash(hash);
    const playerInfo = parsePlayerHash(hash);
    const title = getContentTitle();

    if (detailInfo) {
      lastKnownContentMeta = {
        id: detailInfo.id,
        type: detailInfo.type,
        name: title || lastKnownContentMeta?.name || detailInfo.id,
      };
      return { meta: { ...lastKnownContentMeta }, launchUrl };
    }

    if (playerInfo) {
      if (playerInfo.type && playerInfo.id) {
        lastKnownContentMeta = {
          id: playerInfo.id,
          type: playerInfo.type,
          name: title || lastKnownContentMeta?.name || playerInfo.id,
        };
      }
      if (lastKnownContentMeta) {
        return {
          meta: {
            ...lastKnownContentMeta,
            name: title || lastKnownContentMeta.name || lastKnownContentMeta.id,
          },
          launchUrl,
        };
      }
      return {
        meta: null,
        launchUrl,
      };
    }

    return { meta: null, launchUrl: null };
  }

  function getCurrentContentInfo(hash = window.location.hash) {
    const info = parseDetailHash(hash)
      || (() => {
        const playerInfo = parsePlayerHash(hash);
        return playerInfo?.type && playerInfo.id
          ? { type: playerInfo.type, id: playerInfo.id }
          : null;
      })();
    if (info) return { ...info, url: getCurrentLaunchUrl(hash) || window.location.href };
    return null;
  }

  function classifyAvailability(snapshot) {
    return WPStremioRuntimeModel.deriveAdapterAvailability({
      ...snapshot,
      route: snapshot.route || WPConstants.ADAPTER_ROUTE.IDLE,
    });
  }

  function buildRuntimeSnapshot(options = {}) {
    const hash = options.hash || window.location.hash;
    const context = getCurrentContentContext(hash);
    const route = WPStremioRuntimeModel.deriveAdapterRoute(hash);
    const launchUrl = options.launchUrl === undefined ? (context.launchUrl || null) : options.launchUrl;
    const contentMeta = options.contentMeta === undefined ? (context.meta ? { ...context.meta } : null) : options.contentMeta;
    const joinHint = WPRoomDomain.normalizeJoinHint(options.joinHint);
    const snapshot = {
      route,
      hasVideo: options.hasVideo === true,
      launchUrl,
      contentMeta,
      joinHint,
      directJoinType: joinHint?.directJoinType || null,
      failureReason: joinHint?.failureReason || null,
      lastPublishedShareKey: options.lastPublishedShareKey ?? null,
      lastPublishedLaunchUrl: options.lastPublishedLaunchUrl ?? null,
    };
    return {
      ...snapshot,
      availability: classifyAvailability(snapshot),
    };
  }

  function resetForTests() {
    lastKnownContentMeta = null;
  }

  return {
    parseDetailHash,
    parsePlayerHash,
    getCurrentLaunchUrl,
    getContentTitle,
    updateKnownContentMeta,
    getCurrentContentContext,
    getCurrentContentInfo,
    classifyAvailability,
    buildRuntimeSnapshot,
    resetForTests,
  };
})();
