// WatchParty Playwright Dual-Browser Tests
// Launches two Chromium instances with the extension loaded, simulating two real users.
//
// Usage:
//   npx playwright test test-playwright.mjs
//   OR: node test-playwright.mjs  (standalone runner)
//
// Requires: WS server on localhost:8181, Stremio desktop not required (tests UI only)

import path from 'path';
import { fileURLToPath } from 'url';
import { launchExtensionContext } from './extension-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const STREMIO_URL = 'https://web.stremio.com';
const TIMEOUT = 15000;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function launchWithExtension() {
  const context = await launchExtensionContext(EXT_PATH, {
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  return { context, page };
}

async function waitForOverlay(page) {
  await page.waitForFunction(() => document.getElementById('wp-overlay') !== null, { timeout: TIMEOUT });
}

async function waitForToggleBtn(page) {
  await page.waitForFunction(() => document.getElementById('wp-toggle-host') !== null, { timeout: TIMEOUT });
}

// ── Tests ──

async function testExtensionLoads() {
  console.log('\n── Playwright: Extension loads on Stremio Web ──');
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(STREMIO_URL, { waitUntil: 'domcontentloaded' });
    await waitForOverlay(page);
    await waitForToggleBtn(page);

    const overlayExists = await page.evaluate(() => !!document.getElementById('wp-overlay'));
    const toggleExists = await page.evaluate(() => !!document.getElementById('wp-toggle-host'));
    const sidebarExists = await page.evaluate(() => !!document.getElementById('wp-sidebar'));

    assert(overlayExists, 'Overlay injected');
    assert(toggleExists, 'Toggle button exists (Shadow DOM)');
    assert(sidebarExists, 'Sidebar exists');

    // Check no extension errors in console
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('qt.webChannelTransport')) errors.push(msg.text()); });
    await page.waitForTimeout(2000);
    assert(errors.length === 0, `No extension console errors (found ${errors.length})`);
  } finally {
    await context.close();
  }
}

async function testSidebarOpenClose() {
  console.log('\n── Playwright: Sidebar open/close + content push ──');
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(STREMIO_URL, { waitUntil: 'domcontentloaded' });
    await waitForToggleBtn(page);
    await page.waitForTimeout(2000);

    // Click toggle to open
    await page.evaluate(() => document.getElementById('wp-toggle-host').click());
    await page.waitForTimeout(500);

    const bodyWOpen = await page.evaluate(() => Math.round(document.body.getBoundingClientRect().width));
    const sidebarOpen = await page.evaluate(() => !document.getElementById('wp-sidebar').classList.contains('wp-sidebar-hidden'));
    assert(sidebarOpen, 'Sidebar opens on click');
    assert(bodyWOpen < 1440, `Body pushed to ${bodyWOpen}px (< 1440)`);

    // Close via ×
    await page.evaluate(() => document.getElementById('wp-close-sidebar').click());
    await page.waitForTimeout(500);

    const bodyWClosed = await page.evaluate(() => Math.round(document.body.getBoundingClientRect().width));
    assert(bodyWClosed >= 1400, `Body restored to ${bodyWClosed}px`);
  } finally {
    await context.close();
  }
}

async function testNavigationPersistence() {
  console.log('\n── Playwright: Button persists across navigation ──');
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(STREMIO_URL, { waitUntil: 'domcontentloaded' });
    await waitForToggleBtn(page);
    await page.waitForTimeout(2000);

    const pages = ['#/', '#/discover', '#/library', '#/settings', '#/calendar'];
    for (const hash of pages) {
      await page.evaluate(h => { window.location.hash = h.slice(1); }, hash);
      await page.waitForTimeout(600);
      const exists = await page.evaluate(() => !!document.getElementById('wp-toggle-host'));
      assert(exists, `Toggle button exists on ${hash}`);
    }

    // Movie detail
    await page.evaluate(() => { window.location.hash = '/'; });
    await page.waitForTimeout(800);
    const movieClicked = await page.evaluate(() => {
      const link = document.querySelector('a[href*="#/detail/"]');
      if (link) { link.click(); return true; }
      return false;
    });
    if (movieClicked) {
      await page.waitForTimeout(1000);
      const exists = await page.evaluate(() => !!document.getElementById('wp-toggle-host'));
      assert(exists, 'Toggle button exists on movie detail');
    }
  } finally {
    await context.close();
  }
}

async function testResponsiveViewports() {
  console.log('\n── Playwright: Responsive at different viewports ──');
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(STREMIO_URL, { waitUntil: 'domcontentloaded' });
    await waitForToggleBtn(page);
    await page.waitForTimeout(2000);

    const sizes = [[1920, 1080], [1440, 900], [1280, 720], [600, 400]];
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(500);

      const exists = await page.evaluate(() => {
        const host = document.getElementById('wp-toggle-host');
        return host && host.getBoundingClientRect().width > 0;
      });
      assert(exists, `Button visible at ${w}x${h}`);

      // Open sidebar and check
      await page.evaluate(() => document.getElementById('wp-toggle-host').click());
      await page.waitForTimeout(400);

      const bodyW = await page.evaluate(() => Math.round(document.body.getBoundingClientRect().width));
      if (w <= 640) {
        assert(bodyW === w, `Small viewport (${w}px): sidebar overlays, body stays ${bodyW}px`);
      } else {
        assert(bodyW < w, `Large viewport (${w}px): body pushed to ${bodyW}px`);
      }

      // Close
      await page.evaluate(() => document.getElementById('wp-close-sidebar')?.click());
      await page.waitForTimeout(300);
    }
  } finally {
    await context.close();
  }
}

// ── Main ──

async function main() {
  console.log('WatchParty Playwright Tests');
  console.log('==========================\n');
  console.log('Extension path:', EXT_PATH);

  const tests = [
    testExtensionLoads,
    testSidebarOpenClose,
    testNavigationPersistence,
    testResponsiveViewports,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (e) {
      console.error(`  ✗ FATAL: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(30)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
