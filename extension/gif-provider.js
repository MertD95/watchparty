const WPGifProvider = (() => {
  'use strict';

  const PROVIDER = Object.freeze({
    TENOR: 'tenor',
  });

  const TENOR = Object.freeze({
    apiKey: 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ',
    clientKey: 'watchparty_extension',
    baseUrl: 'https://tenor.googleapis.com/v2',
    mediaFilter: 'tinygif',
  });

  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 50;

  function normalizeQuery(query) {
    const normalized = typeof query === 'string' ? query.trim() : '';
    return normalized || 'trending';
  }

  function normalizeLimit(limit) {
    const normalized = Math.floor(Number(limit) || DEFAULT_LIMIT);
    return Math.max(1, Math.min(MAX_LIMIT, normalized));
  }

  function isHttpsUrl(value) {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }

  function buildTenorEndpoint(query, limit) {
    const normalizedQuery = normalizeQuery(query);
    const endpoint = normalizedQuery === 'trending' ? 'featured' : 'search';
    const params = new URLSearchParams({
      key: TENOR.apiKey,
      client_key: TENOR.clientKey,
      limit: String(normalizeLimit(limit)),
      media_filter: TENOR.mediaFilter,
    });
    if (endpoint === 'search') params.set('q', normalizedQuery);
    return `${TENOR.baseUrl}/${endpoint}?${params.toString()}`;
  }

  function normalizeTenorResult(result) {
    const url = result?.media_formats?.tinygif?.url || result?.media_formats?.gif?.url || '';
    if (!isHttpsUrl(url)) return null;
    return {
      provider: PROVIDER.TENOR,
      id: typeof result.id === 'string' ? result.id : url,
      url,
      title: typeof result.content_description === 'string' ? result.content_description : 'GIF',
    };
  }

  async function searchTenor(query, options = {}) {
    const response = await fetch(buildTenorEndpoint(query, options.limit));
    if (!response.ok) throw new Error(`Tenor API ${response.status}`);
    const data = await response.json();
    return (Array.isArray(data.results) ? data.results : [])
      .map(normalizeTenorResult)
      .filter(Boolean);
  }

  async function search(query, options = {}) {
    const provider = options.provider || PROVIDER.TENOR;
    if (provider === PROVIDER.TENOR) {
      return { provider, results: await searchTenor(query, options) };
    }
    throw new Error(`Unsupported GIF provider: ${provider}`);
  }

  return {
    PROVIDER,
    search,
  };
})();
