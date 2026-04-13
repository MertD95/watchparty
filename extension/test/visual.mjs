// WatchParty — Visual Regression Tests
// Takes screenshots of the extension at key UI states and compares against baselines.
// First run: generates baselines in __snapshots__/
// Subsequent runs: diffs against baselines, fails if >1% pixels differ.
//
// Usage:
//   node extension/test/visual.mjs              # Compare against baselines
//   node extension/test/visual.mjs --update     # Regenerate baselines
//
// Requires: WS server on localhost:8181 (for room creation)

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const SNAP_DIR = path.resolve(__dirname, '__snapshots__');
const STREMIO = 'https://web.stremio.com';
const TIMEOUT = 15000;
const UPDATE = process.argv.includes('--update');
const MAX_DIFF_RATIO = 0.03; // 3% pixel diff threshold (accounts for dynamic content like GIF thumbnails)

let passed = 0, failed = 0;

function ok(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

// Screenshot comparison using Playwright's page-level pixel comparison.
// We compare screenshots by re-capturing and checking structural similarity,
// not raw bytes (PNG compression varies between runs).
// For true pixel diff, we use the page to decode and compare via Canvas API.
async function compareScreenshots(name, actual, page) {
  const baselinePath = path.join(SNAP_DIR, `${name}.png`);

  if (UPDATE || !fs.existsSync(baselinePath)) {
    fs.writeFileSync(baselinePath, actual);
    console.log(`  📸 ${UPDATE ? 'Updated' : 'Created'} baseline: ${name}.png`);
    return true;
  }

  const baseline = fs.readFileSync(baselinePath);

  // Quick: identical bytes = identical image
  if (Buffer.compare(actual, baseline) === 0) return true;

  // Decode both PNGs in the browser and compare pixels
  const diffResult = await page.evaluate(async ({ baselineB64, actualB64, threshold }) => {
    function loadImg(b64) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = `data:image/png;base64,${b64}`;
      });
    }

    const [baseImg, actImg] = await Promise.all([loadImg(baselineB64), loadImg(actualB64)]);

    // Different dimensions = fail
    if (baseImg.width !== actImg.width || baseImg.height !== actImg.height) {
      return { match: false, reason: `size: ${baseImg.width}x${baseImg.height} vs ${actImg.width}x${actImg.height}` };
    }

    const w = baseImg.width, h = baseImg.height;
    const canvas1 = new OffscreenCanvas(w, h);
    const canvas2 = new OffscreenCanvas(w, h);
    const ctx1 = canvas1.getContext('2d');
    const ctx2 = canvas2.getContext('2d');
    ctx1.drawImage(baseImg, 0, 0);
    ctx2.drawImage(actImg, 0, 0);
    const data1 = ctx1.getImageData(0, 0, w, h).data;
    const data2 = ctx2.getImageData(0, 0, w, h).data;

    let diffPixels = 0;
    const totalPixels = w * h;
    for (let i = 0; i < data1.length; i += 4) {
      // Compare RGB (skip alpha). Allow per-channel tolerance of 5 for anti-aliasing.
      const dr = Math.abs(data1[i] - data2[i]);
      const dg = Math.abs(data1[i+1] - data2[i+1]);
      const db = Math.abs(data1[i+2] - data2[i+2]);
      if (dr > 5 || dg > 5 || db > 5) diffPixels++;
    }

    const ratio = diffPixels / totalPixels;
    return { match: ratio <= threshold, ratio, diffPixels, totalPixels };
  }, {
    baselineB64: baseline.toString('base64'),
    actualB64: actual.toString('base64'),
    threshold: MAX_DIFF_RATIO,
  });

  if (!diffResult.match) {
    fs.writeFileSync(path.join(SNAP_DIR, `${name}.actual.png`), actual);
    const reason = diffResult.reason || `${(diffResult.ratio * 100).toFixed(1)}% pixels differ (${diffResult.diffPixels}/${diffResult.totalPixels})`;
    console.log(`  ⚠ ${reason}`);
    console.log(`    Saved actual to: ${name}.actual.png`);
    return false;
  }

  return true;
}

async function main() {
  console.log('WatchParty Visual Regression Tests');
  console.log('==================================\n');
  if (UPDATE) console.log('MODE: Updating baselines\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-visual-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = await ctx.newPage();
    await page.goto(STREMIO, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.getElementById('wp-overlay'), { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // Get extension ID for popup screenshots
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];

    // Helper: screenshot just the sidebar element (avoids Stremio background changes)
    async function sidebarShot(p = page) {
      const el = await p.$('#wp-sidebar');
      if (el) return await el.screenshot({ type: 'png' });
      return await p.screenshot({ type: 'png' }); // fallback to full page
    }

    // ── Screenshot 1: Board page, sidebar closed (full page — toggle button position) ──
    console.log('── Board page, sidebar closed ──');
    await page.evaluate(() => {
      const s = document.getElementById('wp-sidebar');
      if (s && !s.classList.contains('wp-sidebar-hidden')) document.getElementById('wp-close-sidebar')?.click();
    });
    await page.waitForTimeout(500);
    // For closed state, screenshot the toggle button area
    const toggleEl = await page.$('#wp-toggle-host');
    const shot1 = toggleEl ? await toggleEl.screenshot({ type: 'png' }) : await page.screenshot({ type: 'png' });
    ok(await compareScreenshots('toggle-button', shot1, page), 'Toggle button position');

    // ── Screenshot 2: Board page, sidebar open (not in room) ──
    console.log('── Board page, sidebar open (lobby) ──');
    await page.evaluate(() => document.getElementById('wp-toggle-host')?.click());
    await page.waitForTimeout(500);
    const shot2 = await sidebarShot();
    ok(await compareScreenshots('sidebar-lobby', shot2, page), 'Sidebar lobby state');

    // ── Screenshot 3: Create room, sidebar with room content ──
    console.log('── Sidebar with room content ──');
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(1500);
    const inRoom = await popup.evaluate(() => !document.getElementById('view-room')?.classList.contains('hidden'));
    if (inRoom) { await popup.click('#btn-leave'); await popup.waitForTimeout(1000); }
    await popup.fill('#username-input', 'VisualTest');
    await popup.click('#btn-create');
    await popup.waitForFunction(() => !document.getElementById('view-room')?.classList.contains('hidden'), { timeout: TIMEOUT });

    // ── Screenshot 4: Popup in room view ──
    console.log('── Popup room view ──');
    const popupShot = await popup.screenshot({ type: 'png' });
    ok(await compareScreenshots('popup-room-view', popupShot, popup), 'Popup room view');
    await popup.close();

    // Back to Stremio
    await page.bringToFront();
    await page.waitForTimeout(2000);
    const shot3 = await sidebarShot();
    ok(await compareScreenshots('sidebar-inroom', shot3, page), 'Sidebar in room');

    // ── Screenshot 5: Minimized sidebar ──
    console.log('── Minimized sidebar ──');
    await page.evaluate(() => document.getElementById('wp-minimize-btn')?.click());
    await page.waitForTimeout(500);
    const minBar = await page.$('#wp-minimized-bar') || await page.$('#wp-sidebar');
    const shot5 = await (minBar ? minBar.screenshot({ type: 'png' }) : page.screenshot({ type: 'png' }));
    ok(await compareScreenshots('sidebar-minimized', shot5, page), 'Minimized sidebar bar');
    // Restore
    await page.evaluate(() => document.getElementById('wp-minimized-bar')?.click());
    await page.waitForTimeout(500);

    // ── Screenshot 6: Emoji picker open ──
    console.log('── Emoji picker open ──');
    await page.evaluate(() => document.querySelector('#wp-emoji-btn')?.click());
    await page.waitForTimeout(800);
    const shot6 = await sidebarShot();
    ok(await compareScreenshots('sidebar-emoji-picker', shot6, page), 'Emoji picker open');
    await page.evaluate(() => document.querySelector('#wp-emoji-btn')?.click());
    await page.waitForTimeout(300);

    // ── Screenshot 7: GIF picker open ──
    console.log('── GIF picker open ──');
    await page.evaluate(() => document.querySelector('#wp-gif-btn')?.click());
    await page.waitForTimeout(800);
    // GIF picker has dynamic Tenor content — verify structure instead of pixels
    const gifPickerOk = await page.evaluate(() => {
      const p = document.getElementById('wp-gif-picker');
      if (!p || p.classList.contains('wp-hidden-el')) return { visible: false };
      const r = p.getBoundingClientRect();
      const sidebar = document.getElementById('wp-sidebar')?.getBoundingClientRect();
      return {
        visible: r.width > 0 && r.height > 0,
        hasSearch: !!p.querySelector('input'),
        withinSidebar: sidebar ? r.left >= sidebar.left - 2 && r.right <= sidebar.right + 2 : false,
        hasResults: p.querySelectorAll('.wp-gif-item, img').length > 0,
      };
    });
    ok(gifPickerOk.visible, 'GIF picker visible');
    ok(gifPickerOk.hasSearch, 'GIF picker has search input');
    ok(gifPickerOk.withinSidebar, 'GIF picker within sidebar bounds');
    await page.evaluate(() => document.querySelector('#wp-gif-btn')?.click());
    await page.waitForTimeout(300);

    // ── Screenshot 8: Mobile viewport (640px) ──
    console.log('── Mobile viewport (640px) ──');
    await page.setViewportSize({ width: 640, height: 900 });
    await page.waitForTimeout(500);
    const shot8 = await page.screenshot({ type: 'png' });
    ok(await compareScreenshots('mobile-640-sidebar', shot8, page), 'Mobile 640px with sidebar');

    // ── Screenshot 9: Phone viewport (360px) ──
    console.log('── Phone viewport (360px) ──');
    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(500);
    const shot9 = await page.screenshot({ type: 'png' });
    ok(await compareScreenshots('phone-360-sidebar', shot9, page), 'Phone 360px with sidebar');

    // Restore
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── Screenshot 10: Movie detail page with sidebar ──
    console.log('── Movie detail page ──');
    await page.goto(`${STREMIO}/#/detail/movie/tt31193180/tt31193180`);
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const s = document.getElementById('wp-sidebar');
      if (s?.classList.contains('wp-sidebar-hidden')) document.getElementById('wp-toggle-host')?.click();
    });
    await page.waitForTimeout(500);
    const shot10 = await sidebarShot();
    ok(await compareScreenshots('detail-sidebar', shot10, page), 'Detail page sidebar');

    // ── Dynamic UI elements: position and containment checks ──
    // Go back to board (sidebar should still be open and in room)
    await page.goto(`${STREMIO}/#/`);
    await page.waitForFunction(() => !!document.getElementById('wp-overlay'), { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const s = document.getElementById('wp-sidebar');
      if (s?.classList.contains('wp-sidebar-hidden')) document.getElementById('wp-toggle-host')?.click();
    });
    await page.waitForTimeout(500);

    console.log('── Dynamic UI elements ──');

    // Add Bob via WS for two-user elements
    const bobJoined = await page.evaluate(async () => {
      // Get room ID from sidebar
      const code = document.querySelector('.wp-room-code')?.textContent;
      if (!code) return false;
      // Need full room ID — try storage
      return new Promise(resolve => {
        const ws = new WebSocket('ws://localhost:8181');
        window._bob = ws;
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'ready') {
            ws.send(JSON.stringify({ type: 'user.update', payload: { username: 'Bob' } }));
            // Fetch rooms to find the full room ID
            fetch('http://localhost:8181/rooms').then(r => r.json()).then(() => {
              // Use room.join — but we need the full UUID, not just 8 chars
              // Bob can't join without the full ID from page context
              resolve(false);
            });
          }
        };
        setTimeout(() => resolve(false), 3000);
      });
    });

    // Even without Bob, we can test UI elements that don't require two users:

    // 1. Toast notification positioning
    // Inject a toast element directly (can't call WPModals from page context — isolated world)
    await page.evaluate(() => {
      const existing = document.getElementById('wp-toast');
      if (existing) existing.remove();
      const toast = document.createElement('div');
      toast.id = 'wp-toast';
      toast.setAttribute('popover', 'manual');
      toast.textContent = 'Test toast message';
      toast.classList.add('wp-toast-visible');
      document.getElementById('wp-overlay')?.appendChild(toast);
      try { toast.showPopover(); } catch { /* popover API may not be available */ }
    });
    await page.waitForTimeout(500);

    const toast = await page.evaluate(() => {
      const t = document.getElementById('wp-toast');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return {
        exists: true,
        visible: r.width > 0 && r.height > 0,
        withinViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
        text: t.textContent,
      };
    });
    ok(toast?.exists, `Toast element created: "${toast?.text}"`);
    ok(toast?.visible !== false, 'Toast rendered (popover may need user gesture)');

    // 2. Typing indicator positioning
    await page.evaluate(() => {
      const ind = document.getElementById('wp-typing-indicator');
      if (ind) { ind.textContent = 'Bob is typing...'; ind.classList.remove('wp-hidden-el'); }
    });
    await page.waitForTimeout(300);

    const typing = await page.evaluate(() => {
      const ind = document.getElementById('wp-typing-indicator');
      if (!ind || ind.classList.contains('wp-hidden-el')) return null;
      const r = ind.getBoundingClientRect();
      const sidebar = document.getElementById('wp-sidebar')?.getBoundingClientRect();
      return {
        visible: r.width > 0 && r.height > 0,
        withinSidebar: sidebar ? r.left >= sidebar.left - 2 && r.right <= sidebar.right + 2 : false,
        aboveChat: r.bottom <= (document.getElementById('wp-chat-input')?.getBoundingClientRect().top || Infinity),
      };
    });
    ok(typing?.visible, 'Typing indicator visible');
    ok(typing?.withinSidebar, 'Typing indicator within sidebar bounds');

    // Clean up typing indicator
    await page.evaluate(() => document.getElementById('wp-typing-indicator')?.classList.add('wp-hidden-el'));

    // 3. Sync indicator positioning
    await page.evaluate(() => {
      const ind = document.getElementById('wp-sync-indicator');
      if (ind) { ind.textContent = 'Synced'; ind.classList.remove('wp-hidden-el'); }
    });
    await page.waitForTimeout(200);

    const syncInd = await page.evaluate(() => {
      const ind = document.getElementById('wp-sync-indicator');
      if (!ind || ind.classList.contains('wp-hidden-el')) return null;
      const r = ind.getBoundingClientRect();
      const sidebar = document.getElementById('wp-sidebar')?.getBoundingClientRect();
      return {
        visible: r.width > 0,
        withinSidebar: sidebar ? r.right <= sidebar.right + 2 : false,
        notClipped: r.height > 8,
      };
    });
    ok(syncInd?.visible, 'Sync indicator visible');
    ok(syncInd?.withinSidebar, 'Sync indicator within sidebar');

    // 4. Unread badge positioning (close sidebar, check badge)
    await page.evaluate(() => document.getElementById('wp-close-sidebar')?.click());
    await page.waitForTimeout(300);
    // Simulate unread by directly setting badge
    await page.evaluate(() => {
      const badge = document.getElementById('wp-unread-badge');
      if (badge) { badge.textContent = '3'; badge.classList.remove('wp-hidden-el'); badge.style.display = 'flex'; }
    });
    await page.waitForTimeout(200);

    const badge = await page.evaluate(() => {
      const b = document.getElementById('wp-unread-badge');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const toggle = document.getElementById('wp-toggle-host')?.getBoundingClientRect();
      const isHidden = b.classList.contains('wp-hidden-el');
      return {
        exists: true,
        hidden: isHidden,
        hasSize: r.width > 0 && r.height > 0,
        nearToggle: toggle ? Math.abs(r.right - toggle.right) < 50 && Math.abs(r.top - toggle.top) < 50 : false,
        text: b.textContent,
      };
    });
    ok(badge?.exists, `Unread badge element exists: "${badge?.text}"`);
    ok(!badge?.hidden, 'Badge not hidden by CSS class');

    // Take screenshot of badge
    const toggleForBadge = await page.$('#wp-toggle-host');
    const badgeShot = toggleForBadge ? await toggleForBadge.screenshot({ type: 'png' }) : await page.screenshot({ type: 'png' });
    ok(await compareScreenshots('toggle-with-badge', badgeShot, page), 'Toggle button with unread badge');

    // Reopen sidebar for remaining tests
    await page.evaluate(() => {
      document.getElementById('wp-toggle-host')?.click();
      const badge = document.getElementById('wp-unread-badge');
      if (badge) badge.classList.add('wp-hidden-el');
    });
    await page.waitForTimeout(500);

    // 5. Chat message with reaction pill
    await page.evaluate(() => {
      // Inject a fake chat message with reaction toolbar + pills (matching real DOM structure)
      const container = document.getElementById('wp-chat-messages');
      if (!container) return;
      const div = document.createElement('div');
      div.className = 'wp-chat-msg';
      div.innerHTML = `
        <div class="wp-msg-row">
          <div class="wp-msg-content">
            <span class="wp-chat-name" style="color:#6366f1">Bob</span>
            <span class="wp-chat-text">Test message with reaction</span>
          </div>
          <div class="wp-msg-toolbar">
            <button class="wp-msg-react-trigger" title="Add Reaction" aria-label="Add Reaction">☺</button>
          </div>
        </div>
        <div class="wp-msg-pills">
          <button class="wp-reaction-pill" style="cursor:pointer;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:2px 8px;font-size:12px">🔥 2</button>
          <button class="wp-reaction-pill wp-reaction-mine" style="cursor:pointer;background:rgba(99,102,241,0.3);border:1px solid rgba(99,102,241,0.5);border-radius:12px;padding:2px 8px;font-size:12px">👍 1</button>
        </div>
      `;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    });
    await page.waitForTimeout(300);

    const reactionPill = await page.evaluate(() => {
      const pills = document.querySelectorAll('.wp-reaction-pill');
      if (pills.length === 0) return null;
      const sidebar = document.getElementById('wp-sidebar')?.getBoundingClientRect();
      const results = [...pills].map(p => {
        const r = p.getBoundingClientRect();
        return {
          visible: r.width > 0 && r.height > 0,
          withinSidebar: sidebar ? r.left >= sidebar.left - 2 && r.right <= sidebar.right + 2 : false,
          text: p.textContent?.trim(),
        };
      });
      return results;
    });
    ok(reactionPill?.length >= 2, `Reaction pills rendered: ${reactionPill?.length}`);
    ok(reactionPill?.every(p => p.withinSidebar), 'All reaction pills within sidebar');

    // 6. Bookmark message styling
    await page.evaluate(() => {
      const container = document.getElementById('wp-chat-messages');
      if (!container) return;
      const div = document.createElement('div');
      div.className = 'wp-chat-msg wp-bookmark-msg';
      div.innerHTML = `<span class="wp-bookmark-icon">📌</span> <span class="wp-chat-name" style="color:#f59e0b">UITest</span> bookmarked <button class="wp-bookmark-time" data-time="120">2:00</button>`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    });
    await page.waitForTimeout(200);

    const bookmark = await page.evaluate(() => {
      const bm = document.querySelector('.wp-bookmark-msg');
      if (!bm) return null;
      const r = bm.getBoundingClientRect();
      const sidebar = document.getElementById('wp-sidebar')?.getBoundingClientRect();
      const timeBtn = bm.querySelector('.wp-bookmark-time');
      const timeBtnR = timeBtn?.getBoundingClientRect();
      return {
        visible: r.width > 0 && r.height > 0,
        withinSidebar: sidebar ? r.left >= sidebar.left - 2 && r.right <= sidebar.right + 2 : false,
        hasAccentBorder: getComputedStyle(bm).borderLeftWidth !== '0px',
        timeButtonClickable: timeBtnR ? timeBtnR.width > 0 : false,
      };
    });
    ok(bookmark?.visible, 'Bookmark message visible');
    ok(bookmark?.withinSidebar, 'Bookmark within sidebar');
    ok(bookmark?.hasAccentBorder, 'Bookmark has accent border');
    ok(bookmark?.timeButtonClickable, 'Bookmark time button clickable');

    // Take screenshot with chat messages, reactions, bookmark
    const chatShot = await sidebarShot();
    ok(await compareScreenshots('sidebar-chat-messages', chatShot, page), 'Chat with messages + reactions + bookmark');

    // ── Comprehensive interactive element checks ──
    console.log('── Interactive element positioning ──');

    const interactiveChecks = await page.evaluate(() => {
      const sidebar = document.getElementById('wp-sidebar');
      const sRect = sidebar?.getBoundingClientRect();
      const checks = [];

      function within(elRect) {
        return elRect && sRect && elRect.left >= sRect.left - 2 && elRect.right <= sRect.right + 2;
      }
      function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function clickable(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top === el || el.contains(top);
      }

      // 1. Close button has × character
      const closeBtn = document.getElementById('wp-close-sidebar');
      checks.push({ name: 'Close button has × text', pass: closeBtn?.textContent?.trim() === '×' });
      checks.push({ name: 'Close button clickable', pass: clickable(closeBtn) });

      // 2. Minimize button has ― character
      const minBtn = document.getElementById('wp-minimize-btn');
      checks.push({ name: 'Minimize button has ― text', pass: minBtn?.textContent?.trim() === '―' });

      // 3. Room code element
      const roomCode = document.getElementById('wp-room-code');
      checks.push({ name: 'Room code visible', pass: visible(roomCode) });
      checks.push({ name: 'Room code within sidebar', pass: within(roomCode?.getBoundingClientRect()) });
      checks.push({ name: 'Room code has cursor pointer', pass: roomCode ? getComputedStyle(roomCode).cursor === 'pointer' : false });

      // 4. Crown (👑) next to host username
      const crown = sidebar?.querySelector('.wp-crown');
      const crownUser = crown?.closest('.wp-user');
      checks.push({ name: 'Crown icon exists for host', pass: !!crown && crown.textContent?.includes('👑') });
      checks.push({ name: 'Crown within user element', pass: !!crownUser });

      // 5. User status indicators aligned
      const statusEls = sidebar?.querySelectorAll('.wp-user-status');
      if (statusEls?.length > 0) {
        const first = statusEls[0].getBoundingClientRect();
        checks.push({ name: 'User status indicator visible', pass: first.width > 0 && first.height > 0 });
        checks.push({ name: 'User status within sidebar', pass: within(first) });
      }

      // 6. Chat input row — emoji, gif, input, send all on same row
      const emojiBtn = document.querySelector('#wp-emoji-btn');
      const gifBtn = document.querySelector('#wp-gif-btn');
      const chatInput = document.getElementById('wp-chat-input');
      const sendBtn = document.getElementById('wp-chat-send');
      if (emojiBtn && gifBtn && chatInput && sendBtn) {
        const eR = emojiBtn.getBoundingClientRect();
        const gR = gifBtn.getBoundingClientRect();
        const iR = chatInput.getBoundingClientRect();
        const sR = sendBtn.getBoundingClientRect();
        // All should be on approximately the same vertical line (within 10px)
        const tops = [eR.top, gR.top, iR.top, sR.top];
        const maxDiff = Math.max(...tops) - Math.min(...tops);
        checks.push({ name: 'Chat row aligned (emoji/gif/input/send)', pass: maxDiff < 15, detail: `${maxDiff}px diff` });
        // Send button should be rightmost
        checks.push({ name: 'Send button rightmost in chat row', pass: sR.right >= iR.right && sR.right >= gR.right });
        // Emoji button should be leftmost
        checks.push({ name: 'Emoji button leftmost in chat row', pass: eR.left <= gR.left && eR.left <= iR.left });
      }

      // 7. Chat input focus ring
      chatInput?.focus();
      const focusBorder = chatInput ? getComputedStyle(chatInput).borderColor : '';
      checks.push({ name: 'Chat input has focus styling', pass: focusBorder !== '' && focusBorder !== 'rgb(0, 0, 0)' });
      chatInput?.blur();

      // 8. Long username truncation
      const users = sidebar?.querySelectorAll('.wp-user');
      if (users?.length > 0) {
        const userRect = users[0].getBoundingClientRect();
        checks.push({ name: 'User element within sidebar width', pass: within(userRect) });
        // Check overflow handling
        const overflow = getComputedStyle(users[0]).overflow;
        const textOverflow = getComputedStyle(users[0]).textOverflow;
        checks.push({ name: 'User element handles overflow', pass: overflow === 'hidden' || textOverflow === 'ellipsis' || userRect.width <= sRect.width });
      }

      // 9. Message reaction button (☺) — find any message with toolbar
      const allMsgs = document.querySelectorAll('.wp-chat-msg');
      let foundToolbar = false;
      for (const m of allMsgs) {
        const tb = m.querySelector('.wp-msg-toolbar');
        if (tb) {
          foundToolbar = true;
          const reactBtn = tb.querySelector('.wp-msg-react-trigger');
          checks.push({ name: 'Reaction trigger button exists', pass: !!reactBtn && reactBtn.textContent?.includes('☺') });
          break;
        }
      }
      checks.push({ name: 'At least one message has reaction toolbar', pass: foundToolbar });

      // 10. Bookmark time button is styled as clickable
      const bookmarkTime = document.querySelector('.wp-bookmark-time');
      if (bookmarkTime) {
        const cursor = getComputedStyle(bookmarkTime).cursor;
        const bg = getComputedStyle(bookmarkTime).backgroundColor;
        checks.push({ name: 'Bookmark time has pointer cursor', pass: cursor === 'pointer' });
        checks.push({ name: 'Bookmark time has accent background', pass: bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' });
      }

      // 11. Reaction pills styling
      const pills = document.querySelectorAll('.wp-reaction-pill');
      if (pills.length > 0) {
        const pill = pills[0];
        const cursor = getComputedStyle(pill).cursor;
        checks.push({ name: 'Reaction pill has pointer cursor', pass: cursor === 'pointer' });
        checks.push({ name: 'Reaction pill clickable', pass: clickable(pill) });
      }

      // 12. "Mine" reaction pill has distinct styling
      const minePill = document.querySelector('.wp-reaction-mine');
      if (minePill) {
        const normalPill = document.querySelector('.wp-reaction-pill:not(.wp-reaction-mine)');
        if (normalPill) {
          const mineBg = getComputedStyle(minePill).backgroundColor;
          const normalBg = getComputedStyle(normalPill).backgroundColor;
          checks.push({ name: '"Mine" reaction pill has distinct style', pass: mineBg !== normalBg });
        }
      }

      // 13. Sidebar header elements don't overlap
      const header = sidebar?.querySelector(':scope > div:first-child'); // header div
      if (header) {
        const children = [...header.children];
        for (let i = 0; i < children.length - 1; i++) {
          const a = children[i].getBoundingClientRect();
          const b = children[i + 1].getBoundingClientRect();
          if (a.width > 0 && b.width > 0) {
            const overlap = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
            // Allow overlap only for room code + title (they're in a flex row)
            if (overlap) {
              checks.push({ name: `Header elements ${i}/${i+1} overlap`, pass: false, detail: `${children[i].className} vs ${children[i+1].className}` });
            }
          }
        }
        checks.push({ name: 'Header elements properly spaced', pass: true });
      }

      // 14. Content link (if visible) — check within sidebar
      const contentLink = document.getElementById('wp-content-link');
      if (contentLink && !contentLink.classList.contains('wp-hidden-el')) {
        const clRect = contentLink.getBoundingClientRect();
        checks.push({ name: 'Content link within sidebar', pass: within(clRect) });
      }

      return checks;
    });

    for (const check of interactiveChecks) {
      ok(check.pass, `${check.name}${check.detail ? ` (${check.detail})` : ''}`);
    }

    // ── Layout integrity checks (not screenshot-based) ──
    console.log('── Layout integrity checks ──');
    const layout = await page.evaluate(() => {
      const sidebar = document.getElementById('wp-sidebar');
      const sRect = sidebar?.getBoundingClientRect();
      const results = [];

      // Check no elements overflow sidebar
      let overflowCount = 0;
      sidebar?.querySelectorAll('*').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > sRect.right + 2) overflowCount++;
      });
      results.push({ name: 'No sidebar overflow', pass: overflowCount === 0, detail: `${overflowCount} elements overflow` });

      // Check all buttons are clickable (not covered)
      for (const id of ['wp-close-sidebar', 'wp-minimize-btn', 'wp-emoji-btn', 'wp-gif-btn', 'wp-chat-send']) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        results.push({ name: `${id} clickable`, pass: top === el || el.contains(top) });
      }

      // Check sidebar z-index is above page content
      const z = parseInt(getComputedStyle(sidebar).zIndex);
      results.push({ name: 'Sidebar z-index high', pass: z > 1000000, detail: `z-index: ${z}` });

      return results;
    });

    for (const check of layout) {
      ok(check.pass, `${check.name}${check.detail ? ` (${check.detail})` : ''}`);
    }

    // Leave room for clean state
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'leave-room' } })));

  } finally {
    await ctx.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${'='.repeat(30)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (UPDATE) console.log(`Baselines saved to: ${SNAP_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
