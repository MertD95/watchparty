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

// ── Extract keys from an object literal handler map ──
// Matches:  const actionHandlers = { 'foo': ..., 'bar': ... }

function extractObjectHandlerKeys(source, varName) {
  const keys = new Set();
  const pattern = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`);
  const match = pattern.exec(source);
  if (!match) return keys;
  // Count braces to find the object block
  let depth = 1, i = match.index + match[0].length;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  const block = source.slice(match.index + match[0].length, i - 1);
  const re = /'([^']+)'\s*:/g;
  let m;
  while ((m = re.exec(block)) !== null) keys.add(m[1]);
  return keys;
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
  // Pattern 3: dispatchAction('foo' ...)  (helper wrapper for CustomEvent)
  const re3 = /dispatchAction\s*\(\s*'([^']+)'/g;
  while ((m = re3.exec(source)) !== null) {
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

// background.js uses a messageHandlers object map (or switch on message.action)
let bgCases = extractSwitchCases(bgSource, 'background.js', 'action');
if (bgCases.size === 0) {
  bgCases = extractObjectHandlerKeys(bgSource, 'messageHandlers');
}
// stremio-content.js uses an actionHandlers object map (not a switch statement)
// Fall back to extracting keys from the object literal if switch parsing finds nothing
let contentCases = extractSwitchCases(contentSource, 'stremio-content.js', 'action');
if (contentCases.size === 0) {
  contentCases = extractObjectHandlerKeys(contentSource, 'actionHandlers');
}
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
  'chat-message',          // content.js → background (relay to sidepanel)
  'bookmark',              // content.js → background (relay to sidepanel)
  // Overlay actions now use DOM events directly — background.js cases kept for popup relay
  'send-chat', 'send-typing', 'send-reaction', 'send-bookmark', 'seek-bookmark',
  'ready-check', 'transfer-ownership', 'request-sync',
  // Settings actions now use chrome.storage.local directly (popup → PENDING_ACTION → content script)
  'toggle-public', 'update-room-settings',
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

// ══════════════════════════════════════════════════
// Protocol Completeness Tests (wp-protocol.js)
// ══════════════════════════════════════════════════

console.log('\n=== Protocol Completeness Tests ===\n');

const protocolSource = readSrc('wp-protocol.js');

// ── Parse wp-protocol.js to extract C2S, S2C, and ERROR_CODE values ──

function extractProtocolMap(source, mapName) {
  const map = {};
  const pattern = new RegExp(`const ${mapName} = Object\\.freeze\\(\\{([^}]+)\\}\\)`, 's');
  const match = pattern.exec(source);
  if (!match) { console.error(`  WARNING: Could not parse ${mapName} from wp-protocol.js`); return map; }
  const re = /(\w+):\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(match[1])) !== null) map[m[1]] = m[2];
  return map;
}

const C2S_MAP = extractProtocolMap(protocolSource, 'C2S');
const S2C_MAP = extractProtocolMap(protocolSource, 'S2C');
const ERROR_CODE_MAP = extractProtocolMap(protocolSource, 'ERROR_CODE');

// ── Extract WPProtocol.S2C.* case statements from processWsEvent switch ──

function extractProtocolSwitchCases(source, prefix) {
  const cases = new Set();
  const re = new RegExp(`case\\s+WPProtocol\\.${prefix}\\.(\\w+)\\s*:`, 'g');
  let m;
  while ((m = re.exec(source)) !== null) cases.add(m[1]);
  return cases;
}

// ── Extract WPProtocol.C2S.* from WPWS.send() or internal send() calls ──

function extractProtocolSends(source) {
  const sends = new Set();
  // Match both WPWS.send({type: WPProtocol.C2S.X}) and send({type: WPProtocol.C2S.X})
  const re = /(?:WPWS\.)?send\(\s*\{\s*type:\s*WPProtocol\.C2S\.(\w+)/g;
  let m;
  while ((m = re.exec(source)) !== null) sends.add(m[1]);
  return sends;
}

// ── Extract WPProtocol.ERROR_CODE.* from error handler ──

function extractProtocolErrorCodes(source) {
  const codes = new Set();
  const re = /WPProtocol\.ERROR_CODE\.(\w+)/g;
  let m;
  while ((m = re.exec(source)) !== null) codes.add(m[1]);
  return codes;
}

const wsSource = readSrc('stremio-ws.js');
const contentS2CCases = extractProtocolSwitchCases(contentSource, 'S2C');
const contentC2SSends = extractProtocolSends(contentSource);
const wsC2SSends = extractProtocolSends(wsSource);
const allC2SSends = new Set([...contentC2SSends, ...wsC2SSends]);
const contentErrorCodes = extractProtocolErrorCodes(contentSource);

console.log('── Parsed protocol table ──');
console.log(`  wp-protocol.js C2S types:    ${Object.keys(C2S_MAP).length}`);
console.log(`  wp-protocol.js S2C types:    ${Object.keys(S2C_MAP).length}`);
console.log(`  wp-protocol.js error codes:  ${Object.keys(ERROR_CODE_MAP).length}`);
console.log(`  content.js S2C cases:        ${[...contentS2CCases].sort().join(', ')}`);
console.log(`  content+ws C2S sends:        ${[...allC2SSends].sort().join(', ')}`);
console.log(`  content.js error codes used: ${[...contentErrorCodes].sort().join(', ')}`);

// ── Test 6: Every S2C type has a handler in processWsEvent ──
// clock.pong is handled internally by stremio-ws.js (not the content script switch)
const S2C_HANDLED_ELSEWHERE = new Set(['CLOCK_PONG']);

console.log('\n── Test 6: Every S2C type has a handler ──');
for (const [constName, value] of Object.entries(S2C_MAP)) {
  if (S2C_HANDLED_ELSEWHERE.has(constName)) {
    // Verify it's referenced in stremio-ws.js instead
    ok(wsSource.includes(`WPProtocol.S2C.${constName}`), `S2C.${constName} ('${value}') handled in stremio-ws.js`);
  } else {
    ok(contentS2CCases.has(constName), `S2C.${constName} ('${value}') has case in processWsEvent`);
  }
}

// ── Test 7: Every WPWS.send() uses a valid C2S constant ──
console.log('\n── Test 7: Every send uses a valid C2S constant ──');
for (const constName of allC2SSends) {
  ok(constName in C2S_MAP, `C2S.${constName} used in send() exists in wp-protocol.js`);
}

// ── Test 8: Every C2S type is sent somewhere ──
// Some types may only be used in specific flows; we allow a small exclusion list.
const C2S_OPTIONAL = new Set(); // All C2S types should be sent by the extension
console.log('\n── Test 8: Every C2S type is sent by the extension ──');
for (const [constName, value] of Object.entries(C2S_MAP)) {
  if (C2S_OPTIONAL.has(constName)) continue;
  ok(allC2SSends.has(constName), `C2S.${constName} ('${value}') is used in a WPWS.send() call`);
}

// ── Test 9: Error handler covers key error codes ──
const CRITICAL_ERROR_CODES = ['ROOM_NOT_FOUND', 'NOT_OWNER', 'COOLDOWN', 'VALIDATION_FAILED'];
console.log('\n── Test 9: Error handler covers key error codes ──');
for (const code of CRITICAL_ERROR_CODES) {
  ok(contentErrorCodes.has(code), `ERROR_CODE.${code} handled in error case`);
}

// ── Test 10: No hardcoded message type strings remain in content/ws scripts ──
console.log('\n── Test 10: No hardcoded WS message type strings ──');

function findHardcodedTypes(source, label) {
  const problems = [];
  // Check for hardcoded type strings in WPWS.send calls
  const sendRe = /WPWS\.send\(\s*\{\s*type:\s*'([^']+)'/g;
  let m;
  while ((m = sendRe.exec(source)) !== null) problems.push(m[1]);
  // Check for hardcoded case strings in msg.type switch (but not action switch)
  // Only flag if it looks like a WS message type (contains dot or is camelCase)
  const caseRe = /case\s+'([a-z]+(?:\.[a-z]+|[A-Z][a-zA-Z]+))'\s*:/g;
  while ((m = caseRe.exec(source)) !== null) problems.push(m[1]);
  return problems;
}

const contentHardcoded = findHardcodedTypes(contentSource, 'stremio-content.js');
const wsHardcoded = findHardcodedTypes(wsSource, 'stremio-ws.js');
ok(contentHardcoded.length === 0, `stremio-content.js has no hardcoded WS message types${contentHardcoded.length ? ': ' + contentHardcoded.join(', ') : ''}`);
ok(wsHardcoded.length === 0, `stremio-ws.js has no hardcoded WS message types${wsHardcoded.length ? ': ' + wsHardcoded.join(', ') : ''}`);

// ── Results ──
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed (${total} total)`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
