const WPDirectPlay = (() => {
  'use strict';

  const DirectPlayDomain = WPDirectPlayDomain;

  const TRUSTED_ORIGINS = new Set([
    'https://web.stremio.com',
    'https://web.strem.io',
    'https://app.strem.io',
  ]);
  const PLAYER_HASH_RE = /^#\/player\/([^/?#]+)(?:\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+))?/;
  const INFO_HASH_RE = /^[a-fA-F0-9]{40}$/;

  function isHttpUrl(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function pickString(value, max) {
    return typeof value === 'string' && value.trim()
      ? value.trim().slice(0, max || 1000)
      : undefined;
  }

  function pickHttpUrl(value) {
    return isHttpUrl(value) ? value : undefined;
  }

  function pickInfoHash(value) {
    return typeof value === 'string' && INFO_HASH_RE.test(value)
      ? value.toLowerCase()
      : undefined;
  }

  function pickFileIdx(value) {
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
  }

  function pickSources(value) {
    if (!Array.isArray(value)) return undefined;
    const sources = value
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => entry.trim().slice(0, 2000));
    return sources.length > 0 ? sources : undefined;
  }

  function normalizeTitle(value) {
    return typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim()
      : '';
  }

  function isLikelyTitle(value) {
    const title = normalizeTitle(value);
    if (!title || title.length < 2 || title.length > 160) return false;
    if (/^https?:\/\//i.test(title)) return false;
    if (!/[A-Za-z]/.test(title)) return false;
    const lower = title.toLowerCase();
    const hasTitleCase = /[A-Z][a-z]/.test(title);
    const looksMostlyCodec = /\b(2160p|1080p|720p|480p|hdr|webrip|web-dl|bluray|brrip|x264|x265|hevc|h264|aac|dts)\b/.test(lower)
      && !hasTitleCase;
    return !looksMostlyCodec;
  }

  function pickBehaviorHints(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const hints = {};
    const bingeGroup = pickString(value.bingeGroup, 300);
    if (bingeGroup) hints.bingeGroup = bingeGroup;
    const filename = pickString(value.filename, 1000);
    if (filename) hints.filename = filename;
    if (typeof value.notWebReady === 'boolean') hints.notWebReady = value.notWebReady;
    if (value.proxyHeaders && typeof value.proxyHeaders === 'object' && !Array.isArray(value.proxyHeaders)) {
      hints.proxyHeaders = value.proxyHeaders;
    }
    return Object.keys(hints).length > 0 ? hints : undefined;
  }

  function pickTitleHint(decoded, behaviorHints) {
    const candidates = [
      decoded?.name,
      decoded?.title,
      decoded?.description,
      decoded?.filename,
      behaviorHints?.filename,
    ];
    for (const candidate of candidates) {
      const title = normalizeTitle(candidate);
      if (isLikelyTitle(title)) return title;
    }
    return undefined;
  }

  function parsePlayerUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl);
      if (!TRUSTED_ORIGINS.has(url.origin)) return null;
      const match = url.hash.match(PLAYER_HASH_RE);
      if (!match) return null;
      return {
        url,
        encodedStream: decodeURIComponent(match[1]),
        streamTransportUrl: match[2] ? decodeURIComponent(match[2]) : null,
        metaTransportUrl: match[3] ? decodeURIComponent(match[3]) : null,
        type: match[4] ? decodeURIComponent(match[4]) : null,
        id: match[5] ? decodeURIComponent(match[5]) : null,
        videoId: match[6] ? decodeURIComponent(match[6]) : null,
      };
    } catch {
      return null;
    }
  }

  async function inflatePlayerPayload(encodedStream) {
    if (typeof DecompressionStream !== 'function') return null;
    const base64 = encodedStream.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new DecompressionStream('deflate');
    const writer = stream.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    return new Response(stream.readable).text();
  }

  async function decodePlayerStream(encodedStream) {
    try {
      const json = await inflatePlayerPayload(encodedStream);
      if (!json) return null;
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function normalizeSharedStream(stream) {
    const normalized = { ...(stream || {}) };
    const playerUrl = parsePlayerUrl(normalized.url);

    if (playerUrl?.streamTransportUrl && !normalized.streamTransportUrl) {
      normalized.streamTransportUrl = playerUrl.streamTransportUrl;
    }
    if (playerUrl?.metaTransportUrl && !normalized.metaTransportUrl) {
      normalized.metaTransportUrl = playerUrl.metaTransportUrl;
    }
    if (playerUrl?.videoId && !normalized.videoId) {
      normalized.videoId = playerUrl.videoId;
    }

    const decoded = playerUrl ? await decodePlayerStream(playerUrl.encodedStream) : null;
    if (!decoded) return normalized;

    const behaviorHints = pickBehaviorHints(decoded.behaviorHints);
    if (behaviorHints && !normalized.behaviorHints) normalized.behaviorHints = behaviorHints;

    const infoHash = pickInfoHash(decoded.infoHash);
    if (infoHash && !normalized.infoHash) normalized.infoHash = infoHash;

    const fileIdx = pickFileIdx(decoded.fileIdx);
    if (fileIdx !== undefined && normalized.fileIdx === undefined) normalized.fileIdx = fileIdx;

    const resolvedUrl = pickHttpUrl(decoded.url);
    if (resolvedUrl && !normalized.resolvedUrl) normalized.resolvedUrl = resolvedUrl;

    const externalUrl = pickHttpUrl(decoded.externalUrl);
    if (externalUrl && !normalized.externalUrl) normalized.externalUrl = externalUrl;

    const ytId = pickString(decoded.ytId, 100);
    if (ytId && !normalized.ytId) normalized.ytId = ytId;

    const sources = pickSources(decoded.sources);
    if (sources && !normalized.sources?.length) normalized.sources = sources;

    const filename = pickString(decoded.filename, 1000) || behaviorHints?.filename;
    if (filename && !normalized.filename) normalized.filename = filename;

    const bingeGroup = pickString(decoded.bingeGroup, 300) || behaviorHints?.bingeGroup;
    if (bingeGroup && !normalized.bingeGroup) normalized.bingeGroup = bingeGroup;

    const addonTransportUrl = pickHttpUrl(decoded.transportUrl)
      || playerUrl?.streamTransportUrl
      || playerUrl?.metaTransportUrl;
    if (addonTransportUrl && !normalized.addonTransportUrl) {
      normalized.addonTransportUrl = addonTransportUrl;
    }

    return normalized;
  }

  async function getPlayerTitleHint(rawUrl) {
    const playerUrl = parsePlayerUrl(rawUrl);
    if (!playerUrl) return null;
    const decoded = await decodePlayerStream(playerUrl.encodedStream);
    if (!decoded) return null;
    const behaviorHints = pickBehaviorHints(decoded.behaviorHints);
    return pickTitleHint(decoded, behaviorHints) || null;
  }

  function classifyStream(stream) {
    const playerUrl = parsePlayerUrl(stream?.url);
    const classification = DirectPlayDomain.classifyDirectPlayContext({
      ...(stream || {}),
      hasTrustedPlayerUrl: !!playerUrl,
    });
    return {
      ...classification,
      url: classification.hasDirectJoin ? DirectPlayDomain.getDirectJoinUrlForContext({
        ...(stream || {}),
        hasTrustedPlayerUrl: !!playerUrl,
      }) : null,
    };
  }

  function buildJoinHint(stream) {
    return DirectPlayDomain.buildJoinHintForDirectPlayContext({
      ...(stream || {}),
      hasTrustedPlayerUrl: !!parsePlayerUrl(stream?.url),
    });
  }

  function getDirectJoinUrl(stream) {
    return DirectPlayDomain.getDirectJoinUrlForContext({
      ...(stream || {}),
      hasTrustedPlayerUrl: !!parsePlayerUrl(stream?.url),
    });
  }

  return {
    buildJoinHint,
    classifyStream,
    getDirectJoinUrl,
    getPlayerTitleHint,
    normalizeSharedStream,
    parsePlayerUrl,
  };
})();
