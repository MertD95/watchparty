import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchExtensionContext, getExtensionId } from './lib/playwright-extension.mjs';
import { injectSeekableManualVideo } from './lib/seekable-video.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'extension');
const OUTPUT_DIR = path.join(ROOT, 'store-assets', 'chrome-web-store');
const STREMIO_URL = 'https://web.stremio.com';
const CHROME_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
];

function pngDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function htmlDataUrl(markup) {
  return `data:text/html;base64,${Buffer.from(markup, 'utf8').toString('base64')}`;
}

async function waitForPopupReady(page, timeout = 20000) {
  await page.waitForFunction(() => {
    const wsText = document.getElementById('ws-status')?.textContent || '';
    return !!document.getElementById('username-input')
      && !!document.getElementById('btn-create')
      && document.body?.dataset?.statusReady === 'true'
      && wsText.trim().length > 0;
  }, { timeout });
}

async function waitForOptionsReady(page, timeout = 20000) {
  await page.waitForFunction(() => {
    const note = document.getElementById('backend-note')?.textContent || '';
    return !!document.getElementById('btn-refresh') && note.trim().length > 0;
  }, { timeout });
}

async function waitForStremioReady(page, timeout = 20000) {
  await page.waitForFunction(() => (
    !!document.getElementById('wp-overlay')
    && !!document.getElementById('wp-sidebar')
    && !!document.getElementById('wp-toggle-host')
  ), { timeout });
}

async function waitForSidebarPanel(page, panelName, timeout = 20000) {
  await page.waitForFunction((nextPanel) => {
    const button = document.querySelector(`[data-panel="${nextPanel}"]`);
    return !!button
      && button.classList.contains('wp-tab-active')
      && button.getAttribute('aria-selected') === 'true';
  }, panelName, { timeout });
}

async function openStremio(context) {
  const page = await context.newPage();
  await page.goto(STREMIO_URL, { waitUntil: 'domcontentloaded' });
  await waitForStremioReady(page);
  return page;
}

async function openPopup(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await waitForPopupReady(page);
  return page;
}

async function openOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  await waitForOptionsReady(page);
  return page;
}

async function openSidebarIfHidden(page, timeout = 20000) {
  const hidden = await page.evaluate(() =>
    document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')
  );
  if (!hidden) return;
  await page.evaluate(() => document.getElementById('wp-toggle-host')?.click());
  await page.waitForFunction(() => {
    const sidebar = document.getElementById('wp-sidebar');
    return !!sidebar && !sidebar.classList.contains('wp-sidebar-hidden');
  }, { timeout });
}

async function openSidebarPanel(page, panelName, timeout = 20000) {
  await openSidebarIfHidden(page, timeout);
  await page.evaluate((nextPanel) => {
    document.querySelector(`[data-panel="${nextPanel}"]`)?.click();
  }, panelName);
  await waitForSidebarPanel(page, panelName, timeout);
}

async function createRoomFromPopup(popup, username = 'WatchHost', timeout = 20000) {
  await popup.fill('#username-input', username);
  await popup.click('#btn-create');
  await popup.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout });
}

async function prepareStremioCapture(page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addStyleTag({
    content: `
      #wp-overlay {
        right: 18px !important;
        top: 18px !important;
        bottom: 18px !important;
      }
      #wp-sidebar {
        width: 468px !important;
        min-width: 468px !important;
        max-width: 468px !important;
      }
      #wp-sidebar * {
        text-rendering: geometricPrecision;
      }
    `,
  });
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const dismiss = buttons.find((button) => /Don't show again|Later/i.test(button.textContent || ''));
    dismiss?.click();
  }).catch(() => {});
  await page.waitForTimeout(250);
}

async function makePopupScreenshot(page, outputPath) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addStyleTag({
    content: `
      html, body {
        width: 100% !important;
        min-height: 100% !important;
        margin: 0 !important;
        background: radial-gradient(circle at top, #1f2748 0%, #0b1020 62%, #060913 100%) !important;
        display: flex !important;
        justify-content: center !important;
        align-items: flex-start !important;
      }
      body {
        zoom: 2.05;
        padding-top: 22px !important;
        overflow: hidden !important;
      }
    `,
  });
  await page.screenshot({ path: outputPath, type: 'png' });
}

async function makeOptionsScreenshot(page, outputPath) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addStyleTag({
    content: `
      html, body {
        margin: 0 !important;
        background: linear-gradient(180deg, #f8fafc, #eef2ff) !important;
      }
      body {
        zoom: 1.12;
        transform-origin: top center;
      }
    `,
  });
  await page.screenshot({ path: outputPath, type: 'png' });
}

async function capturePopupRoomCard(page) {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.addStyleTag({
    content: `
      html, body {
        margin: 0 !important;
        background: radial-gradient(circle at top, #1f2748 0%, #0b1020 62%, #060913 100%) !important;
      }
      body {
        zoom: 1.5;
        transform-origin: top left;
        padding: 18px !important;
      }
      #view-room {
        width: 380px !important;
      }
      #room-id-display,
      #room-privacy-badge,
      #room-role-badge,
      #room-count-badge,
      #content-link-hint {
        display: none !important;
      }
      .quick-note {
        display: none !important;
      }
      #room-meta {
        font-size: 24px !important;
        line-height: 1.15 !important;
      }
    `,
  });
  await page.waitForTimeout(100);
  return page.locator('#view-room').screenshot({ type: 'png' });
}

async function capturePopupActionCard(page) {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.addStyleTag({
    content: `
      html, body {
        margin: 0 !important;
        background: radial-gradient(circle at top, #1f2748 0%, #0b1020 62%, #060913 100%) !important;
      }
      body {
        zoom: 1.28;
        transform-origin: top left;
        padding: 18px !important;
      }
      #view-room .surface:first-of-type,
      #content-link-hint,
      .quick-note {
        display: none !important;
      }
      #view-room {
        width: 360px !important;
      }
    `,
  });
  await page.waitForTimeout(100);
  return page.locator('#view-room .action-stack').screenshot({ type: 'png' });
}

async function captureSidebarSection(page, selector, { zoom = 1.18, sidebarWidth = 560 } = {}) {
  await page.addStyleTag({
    content: `
      #wp-overlay {
        right: 14px !important;
        top: 14px !important;
        bottom: 14px !important;
      }
      #wp-sidebar {
        width: ${sidebarWidth}px !important;
        min-width: ${sidebarWidth}px !important;
        max-width: ${sidebarWidth}px !important;
      }
      #wp-panel-chat,
      #wp-panel-room {
        padding: 18px !important;
      }
      #wp-room-controls,
      #wp-chat-container {
        zoom: ${zoom};
        transform-origin: top left;
      }
    `,
  });
  await page.waitForTimeout(120);
  return page.locator(selector).screenshot({ type: 'png' });
}

async function captureOptionsPanel(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addStyleTag({
    content: `
      html, body {
        margin: 0 !important;
        background: linear-gradient(180deg, #f8fafc, #eef2ff) !important;
        overflow: hidden !important;
      }
      body::-webkit-scrollbar {
        display: none !important;
      }
    `,
  });
  await page.waitForTimeout(120);
  return page.screenshot({
    type: 'png',
    clip: { x: 146, y: 18, width: 1148, height: 760 },
  });
}

async function seedChatConversation(page) {
  await page.evaluate(() => {
    const empty = document.getElementById('wp-chat-empty');
    const container = document.getElementById('wp-chat-messages');
    const typing = document.getElementById('wp-typing-indicator');
    const input = document.getElementById('wp-chat-input');
    if (!container) return;

    if (empty) empty.classList.add('wp-hidden-el');
    container.innerHTML = '';

    const messages = [
      {
        name: 'Nina',
        color: '#60a5fa',
        text: 'I am in. Start when the trailer ends.',
        pills: [{ emoji: '🔥', count: 2 }],
      },
      {
        name: 'WatchHost',
        color: '#a78bfa',
        text: 'Copying the invite now. Pause if someone drops is on.',
      },
      {
        name: 'Omar',
        color: '#34d399',
        text: 'Joined. Give me five seconds and I am synced.',
        pills: [{ emoji: '👌', count: 1 }],
      },
      {
        name: 'Nina',
        color: '#60a5fa',
        text: 'Perfect. Ready when you are.',
      },
    ];

    for (const message of messages) {
      const row = document.createElement('div');
      row.className = 'wp-chat-msg';

      const msgRow = document.createElement('div');
      msgRow.className = 'wp-msg-row';

      const content = document.createElement('div');
      content.className = 'wp-msg-content';
      content.innerHTML = `
        <span class="wp-chat-name" style="color:${message.color}">${message.name}</span>
        <span class="wp-chat-text">${message.text}</span>
      `;
      msgRow.appendChild(content);

      const toolbar = document.createElement('div');
      toolbar.className = 'wp-msg-toolbar';
      toolbar.innerHTML = '<button class="wp-msg-react-trigger" title="Add Reaction" aria-label="Add Reaction">☺</button>';
      msgRow.appendChild(toolbar);

      row.appendChild(msgRow);

      const pills = document.createElement('div');
      pills.className = 'wp-msg-pills';
      for (const pill of message.pills || []) {
        const pillButton = document.createElement('button');
        pillButton.className = 'wp-react-pill';
        pillButton.dataset.emoji = pill.emoji;
        pillButton.innerHTML = `
          <span class="wp-pill-emoji">${pill.emoji}</span>
          <span class="wp-pill-count">${pill.count}</span>
        `;
        pills.appendChild(pillButton);
      }
      row.appendChild(pills);
      container.appendChild(row);
    }

    if (typing) {
      typing.textContent = 'Lina is typing...';
      typing.classList.remove('wp-hidden-el');
    }
    if (input) input.value = 'Queueing the next episode...';
    container.scrollTop = container.scrollHeight;
  });

  await page.waitForTimeout(120);
}

async function makeMarqueeImageCardVariant({
  outputPath,
  iconBuffer,
  title,
  subtitle,
  backgroundBuffer = null,
  primaryBuffer,
  secondaryBuffer = null,
  chips = ['Private Rooms', 'Open Join', 'Live Chat', 'Ready Check'],
  titleSize = 66,
  primaryWidth = 600,
  primaryTilt = -4,
  primaryTop = 16,
  secondaryWidth = 360,
  secondaryTilt = 6,
  secondaryRight = 74,
  secondaryBottom = 24,
}) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const width = 1400;
    const height = 560;
    const page = await browser.newPage({ viewport: { width, height, deviceScaleFactor: 1 } });
    const iconUrl = pngDataUrl(iconBuffer);
    const backgroundUrl = backgroundBuffer ? pngDataUrl(backgroundBuffer) : null;
    const primaryUrl = pngDataUrl(primaryBuffer);
    const secondaryUrl = secondaryBuffer ? pngDataUrl(secondaryBuffer) : null;
    const chipsMarkup = chips.map((chip) => `<span class="chip">${chip}</span>`).join('');
    const backgroundLayer = backgroundUrl ? `
      <div class="ambient">
        <img src="${backgroundUrl}" alt="">
      </div>
    ` : '';
    const secondaryCard = secondaryUrl ? `
      <div class="card secondary-card">
        <img src="${secondaryUrl}" alt="">
      </div>
    ` : '';
    const markup = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            width: 1400px;
            height: 560px;
            overflow: hidden;
            background:
              radial-gradient(circle at 86% 82%, rgba(124,130,255,0.20), transparent 16%),
              radial-gradient(circle at 8% 0%, rgba(124,130,255,0.14), transparent 20%),
              linear-gradient(135deg, #0b1020 0%, #151c36 52%, #070b15 100%);
            color: #eef2ff;
            font-family: "Segoe UI", Inter, system-ui, sans-serif;
          }
          .frame {
            position: relative;
            width: 100%;
            height: 100%;
            display: grid;
            grid-template-columns: 1.02fr 0.98fr;
            align-items: center;
            gap: 36px;
            padding: 44px 56px;
            overflow: hidden;
          }
          .ambient {
            position: absolute;
            inset: 0;
            overflow: hidden;
            opacity: 0.20;
          }
          .ambient::after {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, rgba(7,11,21,0.88) 0%, rgba(7,11,21,0.62) 42%, rgba(7,11,21,0.30) 100%);
          }
          .ambient img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            object-position: center;
            filter: blur(7px) saturate(1.05);
            transform: scale(1.06);
          }
          .copy {
            position: relative;
            z-index: 2;
            max-width: 470px;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 14px;
            color: #c7d2fe;
            font-weight: 700;
            font-size: 20px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
          }
          .eyebrow img {
            width: 42px;
            height: 42px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.28);
          }
          h1 {
            margin: 18px 0 12px;
            font-size: ${titleSize}px;
            line-height: 0.95;
            letter-spacing: -0.05em;
            max-width: 9ch;
          }
          p {
            margin: 0;
            font-size: 24px;
            line-height: 1.35;
            color: rgba(238, 242, 255, 0.9);
            max-width: 20ch;
          }
          .chips {
            display: flex;
            gap: 12px;
            margin-top: 26px;
            flex-wrap: wrap;
          }
          .chip {
            padding: 10px 16px;
            border-radius: 999px;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.06);
            font-size: 16px;
            color: #eef2ff;
          }
          .art {
            position: relative;
            z-index: 2;
            height: 100%;
            min-height: 410px;
          }
          .card {
            position: absolute;
            border-radius: 30px;
            padding: 14px;
            background: rgba(14, 19, 36, 0.64);
            border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 34px 76px rgba(0,0,0,0.34);
            backdrop-filter: blur(10px);
          }
          .card::before {
            content: "";
            position: absolute;
            inset: -1px;
            border-radius: 30px;
            background: linear-gradient(135deg, rgba(255,255,255,0.10), rgba(124,130,255,0.12) 48%, rgba(255,255,255,0.04));
            z-index: 0;
            pointer-events: none;
          }
          .card img {
            position: relative;
            z-index: 1;
            display: block;
            width: 100%;
            border-radius: 20px;
          }
          .primary-card {
            right: 0;
            top: ${primaryTop}px;
            width: ${primaryWidth}px;
            transform: rotate(${primaryTilt}deg);
          }
          .secondary-card {
            right: ${secondaryRight}px;
            bottom: ${secondaryBottom}px;
            width: ${secondaryWidth}px;
            transform: rotate(${secondaryTilt}deg);
          }
        </style>
      </head>
      <body>
        <div class="frame">
          ${backgroundLayer}
          <section class="copy">
            <div class="eyebrow">
              <img src="${iconUrl}" alt="">
              <span>WatchParty for Stremio</span>
            </div>
            <h1>${title}</h1>
            <p>${subtitle}</p>
            <div class="chips">${chipsMarkup}</div>
          </section>
          <section class="art">
            <div class="card primary-card">
              <img src="${primaryUrl}" alt="">
            </div>
            ${secondaryCard}
          </section>
        </div>
      </body>
      </html>
    `;

    await page.goto(htmlDataUrl(markup), { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

async function makeShowcaseScreenshot({
  outputPath,
  title,
  subtitle,
  backgroundBuffer,
  panelBuffer,
  accent = '#7c82ff',
  panelWidth = 640,
  panelTilt = -2.5,
  copyWidth = 390,
  align = 'left',
}) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const width = 1280;
    const height = 800;
    const page = await browser.newPage({ viewport: { width, height, deviceScaleFactor: 1 } });
    const backgroundUrl = pngDataUrl(backgroundBuffer);
    const panelUrl = pngDataUrl(panelBuffer);
    const markup = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            width: ${width}px;
            height: ${height}px;
            overflow: hidden;
            font-family: "Segoe UI", Inter, system-ui, sans-serif;
            color: #eef2ff;
            background:
              radial-gradient(circle at top left, rgba(124,130,255,0.20), transparent 28%),
              linear-gradient(135deg, #0b1020 0%, #131933 48%, #070b15 100%);
          }
          .frame {
            position: relative;
            width: 100%;
            height: 100%;
            overflow: hidden;
          }
          .backdrop {
            position: absolute;
            inset: 0;
            overflow: hidden;
          }
          .backdrop::after {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, rgba(7,11,21,0.74) 0%, rgba(7,11,21,0.48) 44%, rgba(7,11,21,0.28) 100%);
          }
          .backdrop img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            object-position: top center;
            filter: saturate(1.02) blur(5px);
            transform: scale(1.06);
          }
          .stage {
            position: relative;
            z-index: 2;
            width: 100%;
            height: 100%;
          }
          .copy {
            position: absolute;
            ${align}: 36px;
            bottom: 34px;
            width: ${copyWidth}px;
            padding: 22px 24px 24px;
            border-radius: 28px;
            background: rgba(10, 15, 29, 0.62);
            border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 26px 54px rgba(0,0,0,0.32);
            backdrop-filter: blur(10px);
          }
          .eyebrow {
            font-size: 14px;
            letter-spacing: 0.10em;
            text-transform: uppercase;
            color: rgba(199,210,254,0.96);
            font-weight: 700;
          }
          h1 {
            margin: 12px 0 10px;
            font-size: 46px;
            line-height: 0.96;
            letter-spacing: -0.05em;
          }
          p {
            margin: 0;
            font-size: 20px;
            line-height: 1.34;
            color: rgba(238,242,255,0.86);
          }
          .panel {
            position: absolute;
            right: 36px;
            top: 56px;
            width: ${panelWidth}px;
            padding: 14px;
            border-radius: 28px;
            background: rgba(15, 23, 42, 0.58);
            border: 1px solid rgba(255,255,255,0.16);
            box-shadow: 0 34px 72px rgba(0,0,0,0.34);
            backdrop-filter: blur(12px);
            transform: rotate(${panelTilt}deg);
          }
          .panel::before {
            content: "";
            position: absolute;
            inset: -1px;
            border-radius: 28px;
            background: linear-gradient(135deg, ${accent}55, transparent 36%, transparent 64%, ${accent}24);
            z-index: 0;
          }
          .panel img {
            position: relative;
            z-index: 1;
            width: 100%;
            display: block;
            border-radius: 20px;
          }
        </style>
      </head>
      <body>
        <div class="frame">
          <div class="backdrop">
            <img src="${backgroundUrl}" alt="">
          </div>
          <div class="stage">
            <section class="copy">
              <div class="eyebrow">WatchParty for Stremio</div>
              <h1>${title}</h1>
              <p>${subtitle}</p>
            </section>
            <section class="panel">
              <img src="${panelUrl}" alt="">
            </section>
          </div>
        </div>
      </body>
      </html>
    `;

    await page.goto(htmlDataUrl(markup), { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

async function makeLightShowcaseScreenshot({
  outputPath,
  title,
  subtitle,
  panelBuffer,
  accent = '#7c82ff',
}) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const width = 1280;
    const height = 800;
    const page = await browser.newPage({ viewport: { width, height, deviceScaleFactor: 1 } });
    const panelUrl = pngDataUrl(panelBuffer);
    const markup = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            width: ${width}px;
            height: ${height}px;
            overflow: hidden;
            font-family: "Segoe UI", Inter, system-ui, sans-serif;
            color: #0f172a;
            background:
              radial-gradient(circle at 12% 12%, rgba(127,132,255,0.18), transparent 18%),
              radial-gradient(circle at 88% 80%, rgba(34,197,94,0.12), transparent 18%),
              linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
          }
          .frame {
            position: relative;
            width: 100%;
            height: 100%;
            overflow: hidden;
          }
          .copy {
            position: absolute;
            left: 40px;
            top: 38px;
            width: 360px;
            padding: 22px 24px 24px;
            border-radius: 28px;
            background: rgba(255,255,255,0.72);
            border: 1px solid rgba(148,163,184,0.22);
            box-shadow: 0 22px 48px rgba(15,23,42,0.10);
            backdrop-filter: blur(10px);
          }
          .eyebrow {
            font-size: 14px;
            letter-spacing: 0.10em;
            text-transform: uppercase;
            color: #4f46e5;
            font-weight: 700;
          }
          h1 {
            margin: 12px 0 10px;
            font-size: 46px;
            line-height: 0.96;
            letter-spacing: -0.05em;
            color: #0f172a;
          }
          p {
            margin: 0;
            font-size: 20px;
            line-height: 1.34;
            color: rgba(15,23,42,0.72);
          }
          .panel {
            position: absolute;
            right: 30px;
            top: 34px;
            width: 900px;
            padding: 14px;
            border-radius: 30px;
            background: rgba(255,255,255,0.72);
            border: 1px solid rgba(148,163,184,0.20);
            box-shadow: 0 28px 60px rgba(15,23,42,0.12);
            transform: rotate(-1.2deg);
          }
          .panel::before {
            content: "";
            position: absolute;
            inset: -1px;
            border-radius: 30px;
            background: linear-gradient(135deg, ${accent}33, transparent 34%, transparent 68%, rgba(15,23,42,0.04));
            z-index: 0;
          }
          .panel img {
            position: relative;
            z-index: 1;
            width: 100%;
            display: block;
            border-radius: 20px;
          }
        </style>
      </head>
      <body>
        <div class="frame">
          <section class="copy">
            <div class="eyebrow">WatchParty for Stremio</div>
            <h1>${title}</h1>
            <p>${subtitle}</p>
          </section>
          <section class="panel">
            <img src="${panelUrl}" alt="">
          </section>
        </div>
      </body>
      </html>
    `;

    await page.goto(htmlDataUrl(markup), { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

async function makeSmallPromoTile({ outputPath, iconBuffer }) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const width = 440;
    const height = 280;
    const page = await browser.newPage({ viewport: { width, height, deviceScaleFactor: 1 } });
    const iconUrl = pngDataUrl(iconBuffer);
    const markup = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            width: 440px;
            height: 280px;
            overflow: hidden;
            background:
              radial-gradient(circle at 78% 82%, rgba(124,130,255,0.22), transparent 20%),
              radial-gradient(circle at 14% 0%, rgba(124,130,255,0.16), transparent 22%),
              linear-gradient(135deg, #0b1020 0%, #151c36 52%, #070b15 100%);
            color: #eef2ff;
            font-family: "Segoe UI", Inter, system-ui, sans-serif;
          }
          .frame {
            width: 100%;
            height: 100%;
            display: grid;
            grid-template-columns: 1fr 0.94fr;
            align-items: center;
            gap: 14px;
            padding: 26px 24px 22px;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            color: #c7d2fe;
            font-weight: 700;
            font-size: 12px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
          }
          .eyebrow img {
            width: 26px;
            height: 26px;
            border-radius: 8px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.28);
          }
          h1 {
            margin: 14px 0 12px;
            font-size: 32px;
            line-height: 0.95;
            letter-spacing: -0.04em;
            max-width: 8ch;
          }
          p {
            margin: 0;
            font-size: 14px;
            line-height: 1.35;
            color: rgba(238, 242, 255, 0.88);
            max-width: 14ch;
          }
          .art {
            position: relative;
            height: 100%;
            min-height: 164px;
          }
          .panel {
            position: absolute;
            inset: 4px 0 auto auto;
            width: 196px;
            overflow: hidden;
            border-radius: 18px;
            border: 1px solid rgba(255,255,255,0.14);
            background: rgba(10, 15, 28, 0.92);
            box-shadow: 0 24px 44px rgba(0,0,0,0.34);
            transform: rotate(-4deg);
          }
          .panel-title {
            padding: 12px 14px 8px;
            font-size: 11px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: rgba(199,210,254,0.66);
            border-bottom: 1px solid rgba(255,255,255,0.08);
          }
          .chat-line {
            padding: 12px 14px 0;
            font-size: 11px;
            line-height: 1.35;
            color: rgba(238,242,255,0.86);
          }
          .chat-line strong {
            color: #a78bfa;
          }
          .pill-row {
            display: flex;
            gap: 8px;
            padding: 10px 14px 12px;
          }
          .pill {
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.08);
            font-size: 10px;
            color: #eef2ff;
          }
          .cta-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            padding: 12px;
            padding-top: 0;
          }
          .cta {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 40px;
            border-radius: 12px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.07);
            font-size: 11px;
            font-weight: 700;
            color: #eef2ff;
            text-align: center;
            padding: 0 8px;
          }
          .cta.primary {
            background: linear-gradient(180deg, #7f84ff, #6468ef);
            border-color: transparent;
          }
        </style>
      </head>
      <body>
        <div class="frame">
          <section>
            <div class="eyebrow">
              <img src="${iconUrl}" alt="">
              <span>WatchParty for Stremio</span>
            </div>
            <h1>Chat in sync</h1>
            <p>Live room conversation directly inside Stremio Web.</p>
          </section>
          <section class="art">
            <div class="panel">
              <div class="panel-title">Live room chat</div>
              <div class="chat-line"><strong>Nina</strong> Ready when you are.</div>
              <div class="chat-line"><strong>Host</strong> Copying the invite now.</div>
              <div class="pill-row">
                <div class="pill">🔥 2</div>
                <div class="pill">Live Chat</div>
              </div>
              <div class="cta-row">
                <div class="cta primary">Copy Invite</div>
                <div class="cta">Open Room</div>
              </div>
            </div>
          </section>
        </div>
      </body>
      </html>
    `;

    await page.goto(htmlDataUrl(markup), { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

async function makeMarqueePromoTile({ outputPath, iconBuffer, ambienceBuffer = null }) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const width = 1400;
    const height = 560;
    const page = await browser.newPage({ viewport: { width, height, deviceScaleFactor: 1 } });
    const iconUrl = pngDataUrl(iconBuffer);
    const ambienceUrl = ambienceBuffer ? pngDataUrl(ambienceBuffer) : null;
    const ambienceLayer = ambienceUrl ? `
      <div class="ambient">
        <img src="${ambienceUrl}" alt="">
      </div>
    ` : '';
    const markup = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            width: 1400px;
            height: 560px;
            overflow: hidden;
            background:
              radial-gradient(circle at 86% 82%, rgba(124,130,255,0.22), transparent 16%),
              radial-gradient(circle at 8% 0%, rgba(124,130,255,0.14), transparent 20%),
              linear-gradient(135deg, #0b1020 0%, #151c36 52%, #070b15 100%);
            color: #eef2ff;
            font-family: "Segoe UI", Inter, system-ui, sans-serif;
          }
          .frame {
            width: 100%;
            height: 100%;
            display: grid;
            grid-template-columns: 1fr 1fr;
            align-items: center;
            gap: 34px;
            padding: 44px 56px;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 14px;
            color: #c7d2fe;
            font-weight: 700;
            font-size: 20px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
          }
          .eyebrow img {
            width: 42px;
            height: 42px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.28);
          }
          h1 {
            margin: 18px 0 12px;
            font-size: 70px;
            line-height: 0.95;
            letter-spacing: -0.05em;
          }
          p {
            margin: 0;
            font-size: 24px;
            line-height: 1.35;
            color: rgba(238, 242, 255, 0.9);
            max-width: 20ch;
          }
          .chips {
            display: flex;
            gap: 12px;
            margin-top: 26px;
            flex-wrap: wrap;
          }
          .chip {
            padding: 10px 16px;
            border-radius: 999px;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.06);
            font-size: 16px;
            color: #eef2ff;
          }
          .art {
            position: relative;
            height: 100%;
            min-height: 410px;
          }
          .ambient {
            position: absolute;
            inset: 28px 20px 20px 80px;
            border-radius: 30px;
            overflow: hidden;
            opacity: 0.18;
            filter: blur(6px);
            transform: rotate(-5deg) scale(1.04);
            box-shadow: 0 28px 60px rgba(0,0,0,0.28);
          }
          .ambient img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .controls-card,
          .invite-card {
            position: absolute;
            border-radius: 28px;
            background: rgba(18, 24, 44, 0.92);
            border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 30px 70px rgba(0,0,0,0.34);
          }
          .controls-card {
            right: 10px;
            top: 14px;
            width: 560px;
            padding: 18px;
          }
          .invite-card {
            right: 120px;
            bottom: 14px;
            width: 360px;
            padding: 16px;
          }
          .row {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 16px;
            align-items: center;
            padding: 18px 20px;
            border-radius: 22px;
            background: rgba(124,130,255,0.12);
            border: 1px solid rgba(124,130,255,0.22);
          }
          .row + .row {
            margin-top: 14px;
          }
          .row-title {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 6px;
          }
          .row-copy {
            font-size: 16px;
            line-height: 1.35;
            color: rgba(238,242,255,0.76);
            max-width: 26ch;
          }
          .toggle {
            width: 64px;
            height: 38px;
            border-radius: 999px;
            background: rgba(124,130,255,0.28);
            border: 1px solid rgba(255,255,255,0.08);
            position: relative;
          }
          .toggle::after {
            content: "";
            position: absolute;
            top: 4px;
            right: 4px;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: #f8fafc;
            box-shadow: 0 4px 12px rgba(0,0,0,0.22);
          }
          .toggle.off {
            background: rgba(255,255,255,0.08);
          }
          .toggle.off::after {
            right: auto;
            left: 4px;
          }
          .invite-label {
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: rgba(199,210,254,0.7);
            margin-bottom: 6px;
          }
          .invite-title {
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 14px;
          }
          .btn-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
          }
          .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 48px;
            border-radius: 14px;
            font-size: 16px;
            font-weight: 700;
            color: #eef2ff;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.07);
          }
          .btn.primary {
            background: linear-gradient(180deg, #7f84ff, #6468ef);
            border-color: transparent;
          }
        </style>
      </head>
      <body>
        <div class="frame">
          <section>
            <div class="eyebrow">
              <img src="${iconUrl}" alt="">
              <span>WatchParty for Stremio</span>
            </div>
            <h1>Watch together.</h1>
            <p>Private rooms, live chat, and shared playback controls directly inside Stremio Web.</p>
            <div class="chips">
              <span class="chip">Private Rooms</span>
              <span class="chip">Open Join</span>
              <span class="chip">Live Chat</span>
              <span class="chip">Ready Check</span>
            </div>
          </section>
          <section class="art">
            ${ambienceLayer}
            <div class="controls-card">
              <div class="row">
                <div>
                  <div class="row-title">Require invite key</div>
                  <div class="row-copy">Only people with the invite key or full invite link can join this room.</div>
                </div>
                <div class="toggle"></div>
              </div>
              <div class="row">
                <div>
                  <div class="row-title">Show on WatchParty</div>
                  <div class="row-copy">Display this room on the WatchParty website so people can discover it there.</div>
                </div>
                <div class="toggle"></div>
              </div>
              <div class="row">
                <div>
                  <div class="row-title">Pause if someone drops</div>
                  <div class="row-copy">Pause playback if someone disconnects unexpectedly.</div>
                </div>
                <div class="toggle off"></div>
              </div>
            </div>
            <div class="invite-card">
              <div class="invite-label">Quick action</div>
              <div class="invite-title">Copy and share your room invite</div>
              <div class="btn-row">
                <div class="btn primary">Copy Invite</div>
                <div class="btn">Browse Rooms</div>
              </div>
            </div>
          </section>
        </div>
      </body>
      </html>
    `;

    await page.goto(htmlDataUrl(markup), { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

async function makeSmallPromoTileVariant({
  outputPath,
  iconBuffer,
  title,
  subtitle,
  eyebrow = 'WatchParty for Stremio',
  accent = '#7f84ff',
  secondary = '#813d4e',
  panelTitle = 'Quick room actions',
  primaryLabel = 'Copy Invite',
  secondaryLabel = 'Browse Rooms',
  footerLabel = 'Leave Room',
  tilt = 0,
}) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const width = 440;
    const height = 280;
    const page = await browser.newPage({ viewport: { width, height, deviceScaleFactor: 1 } });
    const iconUrl = pngDataUrl(iconBuffer);
    const markup = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            width: 440px;
            height: 280px;
            overflow: hidden;
            background:
              radial-gradient(circle at 78% 82%, rgba(124,130,255,0.22), transparent 20%),
              radial-gradient(circle at 14% 0%, rgba(124,130,255,0.16), transparent 22%),
              linear-gradient(135deg, #0b1020 0%, #151c36 52%, #070b15 100%);
            color: #eef2ff;
            font-family: "Segoe UI", Inter, system-ui, sans-serif;
          }
          .frame {
            width: 100%;
            height: 100%;
            display: grid;
            grid-template-columns: 1fr 0.92fr;
            align-items: center;
            gap: 14px;
            padding: 28px 24px 22px;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            color: #c7d2fe;
            font-weight: 700;
            font-size: 12px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
          }
          .eyebrow img {
            width: 26px;
            height: 26px;
            border-radius: 8px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.28);
          }
          h1 {
            margin: 14px 0 12px;
            font-size: 32px;
            line-height: 0.94;
            letter-spacing: -0.04em;
            max-width: 8ch;
          }
          p {
            margin: 0;
            font-size: 14px;
            line-height: 1.35;
            color: rgba(238, 242, 255, 0.88);
            max-width: 16ch;
          }
          .art {
            position: relative;
            height: 168px;
          }
          .panel {
            position: absolute;
            inset: 0 0 auto auto;
            width: 196px;
            overflow: hidden;
            border-radius: 18px;
            border: 1px solid rgba(255,255,255,0.14);
            background: rgba(10, 15, 28, 0.94);
            box-shadow: 0 24px 44px rgba(0,0,0,0.34);
            transform: rotate(${tilt}deg);
          }
          .panel-title {
            padding: 12px 14px 10px;
            font-size: 11px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: rgba(199,210,254,0.72);
            border-bottom: 1px solid rgba(255,255,255,0.08);
          }
          .btn-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            padding: 12px;
          }
          .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 44px;
            border-radius: 12px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.07);
            font-size: 11px;
            font-weight: 700;
            color: #eef2ff;
            text-align: center;
            padding: 0 8px;
          }
          .btn.primary {
            background: linear-gradient(180deg, ${accent}, color-mix(in srgb, ${accent} 82%, #0b1020));
            border-color: transparent;
          }
          .btn.danger {
            margin: 0 12px 12px;
            height: 40px;
            border-radius: 12px;
            background: color-mix(in srgb, ${secondary} 52%, #0b1020);
          }
        </style>
      </head>
      <body>
        <div class="frame">
          <section>
            <div class="eyebrow">
              <img src="${iconUrl}" alt="">
              <span>${eyebrow}</span>
            </div>
            <h1>${title}</h1>
            <p>${subtitle}</p>
          </section>
          <section class="art">
            <div class="panel">
              <div class="panel-title">${panelTitle}</div>
              <div class="btn-row">
                <div class="btn primary">${primaryLabel}</div>
                <div class="btn">${secondaryLabel}</div>
              </div>
              <div class="btn danger">${footerLabel}</div>
            </div>
          </section>
        </div>
      </body>
      </html>
    `;
    await page.goto(htmlDataUrl(markup), { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

async function makeMarqueePromoTileVariant({
  outputPath,
  iconBuffer,
  title,
  subtitle,
  ambienceBuffer = null,
  chips = ['Private Rooms', 'Open Join', 'Live Chat', 'Ready Check'],
  titleSize = 64,
  ambientTilt = -5,
  controlsTilt = 0,
  inviteTilt = 0,
  controlsWidth = 560,
  inviteWidth = 360,
  controlsTop = 14,
  inviteBottom = 14,
  inviteRight = 120,
  showInviteCard = true,
}) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const width = 1400;
    const height = 560;
    const page = await browser.newPage({ viewport: { width, height, deviceScaleFactor: 1 } });
    const iconUrl = pngDataUrl(iconBuffer);
    const ambienceUrl = ambienceBuffer ? pngDataUrl(ambienceBuffer) : null;
    const ambienceLayer = ambienceUrl ? `
      <div class="ambient">
        <img src="${ambienceUrl}" alt="">
      </div>
    ` : '';
    const chipsMarkup = chips.map((chip) => `<span class="chip">${chip}</span>`).join('');
    const inviteCard = showInviteCard ? `
      <div class="invite-card">
        <div class="invite-label">Quick action</div>
        <div class="invite-title">Copy and share your room invite</div>
        <div class="btn-row">
          <div class="btn primary">Copy Invite</div>
          <div class="btn">Browse Rooms</div>
        </div>
      </div>
    ` : '';
    const markup = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            width: 1400px;
            height: 560px;
            overflow: hidden;
            background:
              radial-gradient(circle at 86% 82%, rgba(124,130,255,0.22), transparent 16%),
              radial-gradient(circle at 8% 0%, rgba(124,130,255,0.14), transparent 20%),
              linear-gradient(135deg, #0b1020 0%, #151c36 52%, #070b15 100%);
            color: #eef2ff;
            font-family: "Segoe UI", Inter, system-ui, sans-serif;
          }
          .frame {
            width: 100%;
            height: 100%;
            display: grid;
            grid-template-columns: 1.04fr 0.96fr;
            align-items: center;
            gap: 34px;
            padding: 44px 56px;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 14px;
            color: #c7d2fe;
            font-weight: 700;
            font-size: 20px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
          }
          .eyebrow img {
            width: 42px;
            height: 42px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.28);
          }
          h1 {
            margin: 18px 0 12px;
            font-size: ${titleSize}px;
            line-height: 0.95;
            letter-spacing: -0.05em;
            max-width: 9ch;
          }
          p {
            margin: 0;
            font-size: 24px;
            line-height: 1.35;
            color: rgba(238, 242, 255, 0.9);
            max-width: 20ch;
          }
          .chips {
            display: flex;
            gap: 12px;
            margin-top: 26px;
            flex-wrap: wrap;
          }
          .chip {
            padding: 10px 16px;
            border-radius: 999px;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.06);
            font-size: 16px;
            color: #eef2ff;
          }
          .art {
            position: relative;
            height: 100%;
            min-height: 410px;
          }
          .ambient {
            position: absolute;
            inset: 28px 20px 20px 80px;
            border-radius: 30px;
            overflow: hidden;
            opacity: 0.18;
            filter: blur(6px);
            transform: rotate(${ambientTilt}deg) scale(1.04);
            box-shadow: 0 28px 60px rgba(0,0,0,0.28);
          }
          .ambient img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .controls-card,
          .invite-card {
            position: absolute;
            border-radius: 28px;
            background: rgba(18, 24, 44, 0.92);
            border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 30px 70px rgba(0,0,0,0.34);
          }
          .controls-card {
            right: 10px;
            top: ${controlsTop}px;
            width: ${controlsWidth}px;
            padding: 18px;
            transform: rotate(${controlsTilt}deg);
          }
          .invite-card {
            right: ${inviteRight}px;
            bottom: ${inviteBottom}px;
            width: ${inviteWidth}px;
            padding: 16px;
            transform: rotate(${inviteTilt}deg);
          }
          .row {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 16px;
            align-items: center;
            padding: 18px 20px;
            border-radius: 22px;
            background: rgba(124,130,255,0.12);
            border: 1px solid rgba(124,130,255,0.22);
          }
          .row + .row {
            margin-top: 14px;
          }
          .row-title {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 6px;
          }
          .row-copy {
            font-size: 16px;
            line-height: 1.35;
            color: rgba(238,242,255,0.76);
            max-width: 24ch;
          }
          .toggle {
            width: 64px;
            height: 38px;
            border-radius: 999px;
            background: rgba(124,130,255,0.28);
            border: 1px solid rgba(255,255,255,0.08);
            position: relative;
          }
          .toggle::after {
            content: "";
            position: absolute;
            top: 4px;
            right: 4px;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: #f8fafc;
            box-shadow: 0 4px 12px rgba(0,0,0,0.22);
          }
          .toggle.off {
            background: rgba(255,255,255,0.08);
          }
          .toggle.off::after {
            right: auto;
            left: 4px;
          }
          .invite-label {
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: rgba(199,210,254,0.7);
            margin-bottom: 6px;
          }
          .invite-title {
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 14px;
          }
          .btn-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
          }
          .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 48px;
            border-radius: 14px;
            font-size: 16px;
            font-weight: 700;
            color: #eef2ff;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.07);
          }
          .btn.primary {
            background: linear-gradient(180deg, #7f84ff, #6468ef);
            border-color: transparent;
          }
        </style>
      </head>
      <body>
        <div class="frame">
          <section>
            <div class="eyebrow">
              <img src="${iconUrl}" alt="">
              <span>WatchParty for Stremio</span>
            </div>
            <h1>${title}</h1>
            <p>${subtitle}</p>
            <div class="chips">${chipsMarkup}</div>
          </section>
          <section class="art">
            ${ambienceLayer}
            <div class="controls-card">
              <div class="row">
                <div>
                  <div class="row-title">Require invite key</div>
                  <div class="row-copy">Only people with the invite key or full invite link can join this room.</div>
                </div>
                <div class="toggle"></div>
              </div>
              <div class="row">
                <div>
                  <div class="row-title">Show on WatchParty</div>
                  <div class="row-copy">Display this room on the WatchParty website so people can discover it there.</div>
                </div>
                <div class="toggle"></div>
              </div>
              <div class="row">
                <div>
                  <div class="row-title">Pause if someone drops</div>
                  <div class="row-copy">Pause playback if someone disconnects unexpectedly.</div>
                </div>
                <div class="toggle off"></div>
              </div>
            </div>
            ${inviteCard}
          </section>
        </div>
      </body>
      </html>
    `;

    await page.goto(htmlDataUrl(markup), { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

async function main() {
  await fsp.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wp-store-assets-'));
  const context = await launchExtensionContext(EXT_PATH, {
    userDataDir: tempDir,
    viewport: { width: 1280, height: 800 },
    backendMode: 'local',
    args: CHROME_FLAGS,
  });

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: STREMIO_URL }).catch(() => {});
    const extensionId = await getExtensionId(context);

    const stremio = await openStremio(context);
    await injectSeekableManualVideo(stremio, 42);
    await prepareStremioCapture(stremio);

    const popup = await openPopup(context, extensionId);
    await createRoomFromPopup(popup, 'WatchHost');
    const popupRoomCard = await capturePopupRoomCard(popup);
    const popupActionCard = await capturePopupActionCard(popup);

    await openSidebarPanel(stremio, 'chat');
    await seedChatConversation(stremio);
    const stremioBackground = await stremio.screenshot({ type: 'png' });
    const chatPanel = await captureSidebarSection(stremio, '#wp-chat-container', { zoom: 1.3, sidebarWidth: 620 });
    const chatShot = path.join(OUTPUT_DIR, '02-stremio-chat.png');
    await makeShowcaseScreenshot({
      outputPath: chatShot,
      title: 'Live room chat',
      subtitle: 'Talk, react, and stay in sync without leaving Stremio Web.',
      backgroundBuffer: stremioBackground,
      panelBuffer: chatPanel,
      accent: '#7c82ff',
    });

    await openSidebarPanel(stremio, 'room');
    const roomBackground = await stremio.screenshot({ type: 'png' });
    const roomPanel = await captureSidebarSection(stremio, '#wp-room-controls', { zoom: 1.24, sidebarWidth: 590 });
    const roomShot = path.join(OUTPUT_DIR, '03-stremio-room-controls.png');
    await makeShowcaseScreenshot({
      outputPath: roomShot,
      title: 'Room controls',
      subtitle: 'Manage invite-only access, discovery, and playback safeguards from one panel.',
      backgroundBuffer: roomBackground,
      panelBuffer: roomPanel,
      accent: '#22c55e',
    });

    const options = await openOptions(context, extensionId);
    const optionsPanel = await captureOptionsPanel(options);

    const popupShot = path.join(OUTPUT_DIR, '01-popup-room-summary.png');
    await makeShowcaseScreenshot({
      outputPath: popupShot,
      title: 'Create and share fast.',
      subtitle: 'Open a room, copy the invite, and hand off to the live Stremio session.',
      backgroundBuffer: roomBackground,
      panelBuffer: popupRoomCard,
      accent: '#7c82ff',
      panelWidth: 470,
      panelTilt: -2,
      copyWidth: 360,
    });

    const optionsShot = path.join(OUTPUT_DIR, '04-options-dashboard.png');
    await makeLightShowcaseScreenshot({
      outputPath: optionsShot,
      title: 'Runtime settings.',
      subtitle: 'Connection, recovery, and backend controls stay in one place.',
      panelBuffer: optionsPanel,
      accent: '#22c55e',
    });

    const iconBuffer = await fsp.readFile(path.join(EXT_PATH, 'icons', 'icon128.png'));
    await makeSmallPromoTile({
      outputPath: path.join(OUTPUT_DIR, 'promo-small-440x280.png'),
      iconBuffer,
    });

    await makeMarqueeImageCardVariant({
      outputPath: path.join(OUTPUT_DIR, 'promo-marquee-1400x560.png'),
      iconBuffer,
      title: 'Chat while you watch.',
      subtitle: 'Live room conversation, invites, and playback tools directly inside Stremio Web.',
      backgroundBuffer: roomBackground,
      primaryBuffer: chatPanel,
      secondaryBuffer: popupActionCard,
      primaryTilt: -5,
      primaryWidth: 626,
      secondaryTilt: 8,
      secondaryWidth: 378,
      secondaryRight: 42,
      secondaryBottom: 26,
    });

    console.log(`Generated store assets in ${OUTPUT_DIR}`);
  } finally {
    await context.close().catch(() => {});
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
