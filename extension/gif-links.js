// Direct GIF sharing. Validation is local and never contacts a search provider.
// Tenor's third-party API was retired on June 30, 2026.
const WPGifLinks = (() => {
  'use strict';

  function parse(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return { url: '', error: '' };
    if (!/^https:\/\//i.test(raw) || /[\s\[\]\\]/.test(raw)) return { url: '', error: 'Paste a direct HTTPS link to a .gif image.' };
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || !/\.gif$/i.test(url.pathname)) {
        return { url: '', error: 'Paste a direct HTTPS link ending in .gif, not a GIF webpage.' };
      }
      if (url.href.length > 294) return { url: '', error: 'This GIF link is too long. Use a link of 294 characters or fewer.' };
      return { url: url.href, error: '' };
    } catch {
      return { url: '', error: 'Paste a valid HTTPS link to a .gif image.' };
    }
  }

  return { parse };
})();
