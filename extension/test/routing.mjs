// WatchParty Extension — Message Routing Table Test
// Statically parses extension source to verify every action sent by
// overlay/popup has a matching case in both background.js AND content.js.
//
// This catches bugs like a missing 'send-chat' case in background.js
// without needing a browser or any chrome.* APIs.
//
// Usage:  node extension/test/routing.mjs

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, '..');

let passed = 0, failed = 0, total = 0;
function ok(cond, label) {
  total++;
  if (cond) { console.log('  \u2713 ' + label); passed++; }
  else      { console.error('  \u2717 ' + label); failed++; }
}

// ── Source readers ──

function readSrc(file) {
  return readFileSync(resolve(EXT, file), 'utf8');
}

// ── Extract case values from switch blocks ──
// Matches:  case 'foo':  patterns. When switchVar is given, only extracts from
// the switch block that switches on that variable name.

function extractSwitchCases(source, label, switchVar) {
  const cases = new Set();

  if (switchVar) {
    // Find the switch block for the specific variable and extract cases from it only.
    // Strategy: find "switch (X.var)" then collect cases until the matching closing brace.
    const switchPattern = new RegExp(`switch\\s*\\(\\w+\\.${switchVar}\\)\\s*\\{`);
    const switchMatch = switchPattern.exec(source);
    if (!switchMatch) {
      console.error(`  WARNING: No switch(*.${switchVar}) found in ${label}`);
      return cases;
    }
    // Extract the block content by counting braces
    let depth = 1, i = switchMatch.index + switchMatch[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    const block = source.slice(start, i);
    const re = /case\s+'([^']+)'\s*:/g;
    let m;
    while ((m = re.exec(block)) !== null) cases.add(m[1]);
  } else {
    // Extract all case statements from the entire file
    const re = /case\s+'([^']+)'\s*:/g;
    let m;
    while ((m = re.exec(source)) !== null) cases.add(m[1]);
  }

  if (cases.size === 0) {
    console.error(`  WARNING: No case statements found in ${label} — parser may be broken`);
  }
  return cases;
}

// ── Extract actions sent via chrome.runtime.sendMessage ──

function extractSentActions(source, label) {
  const actions = new Set();
  // Pattern 1: action: 'foo'  (inside sendMessage object literal)
  const re1 = /chrome\.runtime\.sendMessage\s*\(\s*\{[^}]*action:\s*'([^']+)'/g;
  let m;
  while ((m = re1.exec(source)) !== null) {
    actions.add(m[1]);
  }
  // Pattern 2: CustomEvent('wp-action', { detail: { action: 'foo' } })  (direct DOM events)
  const re2 = /CustomEvent\s*\(\s*'wp-action'\s*,\s*\{\s*detail:\s*\{[^}]*action:\s*'([^']+)'/g;
  while ((m = re2.exec(source)) !== null) {
    actions.add(m[1]);
  }
  if (actions.size === 0) {
    console.error(`  WARNING: No actions found in ${label} — parser may be broken`);
  }
  return actions;
}

// ── Parse all sources ──

console.log('\n=== Message Routing Table Test ===\n');

const bgSource      = readSrc('background.js');
const contentSource = readSrc('stremio-content.js');
const overlaySource = readSrc('stremio-overlay.js');
const popupSource   = readSrc('popup.js');

// background.js has one switch on message.action
const bgCases      = extractSwitchCases(bgSource, 'background.js', 'action');
// stremio-content.js has TWO switches: one on msg.type (server messages) and one on message.action (extension messages)
// We only care about the message.action switch for routing validation
const contentCases = extractSwitchCases(contentSource, 'stremio-content.js', 'action');
const overlaySends = extractSentActions(overlaySource, 'stremio-overlay.js');
const popupSends   = extractSentActions(popupSource, 'popup.js');

console.log('── Parsed routing table ──');
console.log(`  background.js cases:       ${[...bgCases].sort().join(', ')}`);
console.log(`  content.js action cases:   ${[...contentCases].sort().join(', ')}`);
console.log(`  stremio-overlay.js sends:  ${[...overlaySends].sort().join(', ')}`);
console.log(`  popup.js sends:            ${[...popupSends].sort().join(', ')}`);

// ── Actions that background.js handles internally (not forwarded to content script) ──
// These are handled entirely in background.js and don't need a content.js case.
const BG_ONLY_ACTIONS = new Set([
  'get-status',         // Responds with status from storage, no forwarding
  'ws-status-changed',  // Badge update from content→background, no forwarding
  'profile-updated',    // Broadcasts to WatchParty tabs, not Stremio tabs
  'save-auth-key',      // Stores auth key + triggers profile sync
  'proxy-fetch',        // CORS proxy handled entirely in background
]);

// ── Actions that content.js handles but aren't sent by overlay/popup ──
// These originate from background.js broadcasts or internal logic.
const CONTENT_INTERNAL_ACTIONS = new Set([
  'get-ws-status',      // Background queries content script WS status
  'stremio-status',     // Background broadcasts Stremio detection changes
]);

// ── Test 1: Every overlay action has a case in stremio-content.js ──
// Overlay now uses direct DOM events (wp-action) to content script, not background.js
console.log('\n── Test 1: Overlay actions → stremio-content.js ──');
for (const action of overlaySends) {
  ok(contentCases.has(action), `overlay sends '${action}' → stremio-content.js has case`);
}

// ── Test 2: Every popup action has a case in background.js ──
console.log('\n── Test 2: Popup actions → background.js ──');
for (const action of popupSends) {
  ok(bgCases.has(action), `popup sends '${action}' → background.js has case`);
}

// ── Test 3: Every forwarded action has a case in content.js ──
// "Forwarded" = handled by background.js AND not in BG_ONLY_ACTIONS
console.log('\n── Test 3: Forwarded actions → stremio-content.js ──');
const allSenderActions = new Set([...overlaySends, ...popupSends]);
for (const action of allSenderActions) {
  if (BG_ONLY_ACTIONS.has(action)) continue; // Not forwarded
  ok(contentCases.has(action), `forwarded '${action}' → stremio-content.js has case`);
}

// ── Test 4: No dead cases in background.js ──
// Actions in background.js that are sent by other sources (not overlay/popup UI).
// These are excluded from the "dead case" check because they have legitimate senders.
console.log('\n── Test 4: No dead cases in background.js ──');
const BG_NON_UI_SENDERS = new Set([
  'ws-status-changed',     // content script → background (notifyBackground)
  'profile-updated',       // content.js WPProfile → background
  'save-auth-key',         // content.js (landing page) → background
  'proxy-fetch',           // content.js → background (CORS proxy for localhost)
  'send-presence',         // content.js programmatic (visibility change)
  'send-playback-status',  // content.js programmatic (periodic status)
  'update-username',       // content.js processPendingActions (username from storage)
  // Overlay actions now use DOM events directly — background.js cases kept for popup relay
  'send-chat', 'send-typing', 'send-reaction', 'send-bookmark',
  'ready-check', 'transfer-ownership', 'request-sync',
]);
for (const action of bgCases) {
  if (BG_NON_UI_SENDERS.has(action)) continue;
  ok(allSenderActions.has(action), `background.js case '${action}' is sent by overlay or popup`);
}

// ── Test 5: Sanity — minimum expected action counts ──
console.log('\n── Test 5: Sanity checks ──');
ok(bgCases.size >= 10,      `background.js has ${bgCases.size} cases (expected >= 10)`);
ok(contentCases.size >= 10,  `stremio-content.js has ${contentCases.size} cases (expected >= 10)`);
ok(overlaySends.size >= 5,   `stremio-overlay.js sends ${overlaySends.size} actions (expected >= 5)`);
ok(popupSends.size >= 4,     `popup.js sends ${popupSends.size} actions (expected >= 4)`);

// ── Results ──
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed (${total} total)`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
