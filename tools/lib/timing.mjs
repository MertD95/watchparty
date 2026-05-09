const DEFAULT_TIMEOUT = 15000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

export function formatError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function pollUntil(task, { timeout = DEFAULT_TIMEOUT, intervalMs = 100, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while ((Date.now() - started) < timeout) {
    try {
      const result = await task();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError ? ` (${formatError(lastError)})` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

export async function gotoWithRetry(page, url, {
  waitUntil = 'domcontentloaded',
  attempts = DEFAULT_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.goto(url, { waitUntil });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await delay(retryDelayMs);
    }
  }
  throw new Error(`Could not open ${url} after ${attempts} attempts (${formatError(lastError)})`);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
