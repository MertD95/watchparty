import { chromium } from 'playwright';

const EXTENSION_LOAD_ERROR =
  'Extension service worker did not start in Playwright. Treat browser UI test failures as a harness/environment problem until Playwright can actually side-load the MV3 extension here.';

export async function launchExtensionContext(extPath, options = {}) {
  const {
    userDataDir = '',
    headless = false,
    args = [],
    viewport = { width: 1440, height: 900 },
    serviceWorkerTimeout = 10000,
    backendMode = 'auto',
  } = options;

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      ...args,
    ],
    viewport,
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: serviceWorkerTimeout }).catch(() => null);
  }

  if (!serviceWorker) {
    await context.close().catch(() => {});
    throw new Error(EXTENSION_LOAD_ERROR);
  }

  context._watchpartyExtensionId = serviceWorker.url().split('/')[2];

  if (backendMode) {
    await serviceWorker.evaluate(async (mode) => {
      await chrome.storage.local.set({
        wpBackendMode: mode,
        wpActiveBackend: null,
        wpActiveBackendUrl: null,
        wpWsConnected: false,
      });
    }, backendMode);
  }

  return context;
}

export async function getExtensionId(context, timeout = 10000) {
  if (context._watchpartyExtensionId) {
    return context._watchpartyExtensionId;
  }

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout }).catch(() => null);
  }

  if (!serviceWorker) {
    throw new Error(EXTENSION_LOAD_ERROR);
  }

  const extensionId = serviceWorker.url().split('/')[2];
  context._watchpartyExtensionId = extensionId;
  return extensionId;
}
