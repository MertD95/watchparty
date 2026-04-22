// WatchParty Extension - Routing and Protocol Contract Test
// Verifies:
// 1. Generated internal actions resolve across overlay/popup/background/content
// 2. Canonical WPProtocol command/event contracts are fully consumed
//
// Usage: node extension/test/routing.mjs

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
let total = 0;

function ok(condition, label) {
  total++;
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

function readSrc(file) {
  return readFileSync(resolve(EXT, file), 'utf8');
}

function extractObjectMap(source, varName) {
  const map = {};
  const pattern = new RegExp(`const ${varName} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`);
  const match = pattern.exec(source);
  if (!match) return map;
  const re = /([A-Z0-9_]+):\s*'([^']+)'/g;
  let next;
  while ((next = re.exec(match[1])) !== null) {
    map[next[1]] = next[2];
  }
  return map;
}

function extractSwitchCases(source, switchVar) {
  const cases = new Set();
  const switchPattern = new RegExp(`switch\\s*\\(\\w+\\.${switchVar}\\)\\s*\\{`);
  const match = switchPattern.exec(source);
  if (!match) return cases;
  let depth = 1;
  let index = match.index + match[0].length;
  const start = index;
  while (index < source.length && depth > 0) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    index++;
  }
  const block = source.slice(start, index);
  const re = /case\s+'([^']+)'\s*:/g;
  let next;
  while ((next = re.exec(block)) !== null) {
    cases.add(next[1]);
  }
  return cases;
}

function extractObjectHandlerKeys(source, varName, actionMap) {
  const keys = new Set();
  const pattern = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`);
  const match = pattern.exec(source);
  if (!match) return keys;
  let depth = 1;
  let index = match.index + match[0].length;
  const start = index;
  while (index < source.length && depth > 0) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    index++;
  }
  const block = source.slice(start, index - 1);
  const re = /'([^']+)'\s*:|\[WPConstants\.ACTION\.(\w+)\]\s*:/g;
  let next;
  while ((next = re.exec(block)) !== null) {
    if (next[1]) keys.add(next[1]);
    else if (next[2] && actionMap[next[2]]) keys.add(actionMap[next[2]]);
  }
  return keys;
}

function extractSentActions(source, actionMap) {
  const actions = new Set();
  const patterns = [
    /chrome\.runtime\.sendMessage\s*\(\s*\{[^}]*action:\s*(?:'([^']+)'|WPConstants\.ACTION\.(\w+))/g,
    /CustomEvent\s*\(\s*'wp-action'\s*,\s*\{\s*detail:\s*\{[^}]*action:\s*(?:'([^']+)'|WPConstants\.ACTION\.(\w+))/g,
    /dispatchAction\s*\(\s*(?:'([^']+)'|WPConstants\.ACTION\.(\w+))/g,
    /sendRuntimeMessage\s*\(\s*\{[^}]*action:\s*(?:'([^']+)'|WPConstants\.ACTION\.(\w+))/g,
  ];
  for (const pattern of patterns) {
    let next;
    while ((next = pattern.exec(source)) !== null) {
      if (next[1]) actions.add(next[1]);
      else if (next[2] && actionMap[next[2]]) actions.add(actionMap[next[2]]);
    }
  }
  return actions;
}

function extractProtocolSwitchCases(source, prefix) {
  const cases = new Set();
  const re = new RegExp(`case\\s+WPProtocol\\.${prefix}\\.(\\w+)\\s*:`, 'g');
  let next;
  while ((next = re.exec(source)) !== null) {
    cases.add(next[1]);
  }
  return cases;
}

function extractProtocolSends(source) {
  const sends = new Set();
  const re = /(?:WPWS\.)?send\(\s*\{\s*type:\s*WPProtocol\.COMMAND\.(\w+)/g;
  let next;
  while ((next = re.exec(source)) !== null) {
    sends.add(next[1]);
  }
  return sends;
}

function extractProtocolErrorCodes(source) {
  const codes = new Set();
  const re = /WPProtocol\.ERROR_CODE\.(\w+)/g;
  let next;
  while ((next = re.exec(source)) !== null) {
    codes.add(next[1]);
  }
  return codes;
}

function findHardcodedTypes(source) {
  const problems = [];
  const sendRe = /WPWS\.send\(\s*\{\s*type:\s*'([^']+)'/g;
  let next;
  while ((next = sendRe.exec(source)) !== null) problems.push(next[1]);
  const caseRe = /case\s+'([a-z]+(?:\.[a-z]+|[A-Z][a-zA-Z]+))'\s*:/g;
  while ((next = caseRe.exec(source)) !== null) problems.push(next[1]);
  return problems;
}

console.log('\n=== Message Routing Table Test ===\n');

const bgSource = readSrc('background.js');
const contentSource = readSrc('stremio-content.js');
const bridgeSource = readSrc('content.js');
const overlaySource = readSrc('stremio-overlay.js');
const popupSource = readSrc('popup.js');
const sidepanelSource = readSrc('sidepanel.js');
const actionsSource = readSrc('wp-actions.js');
const constantsSource = readSrc('constants.js');
const optionsSource = readSrc('options.js');
const protocolSource = readSrc('wp-protocol.js');
const wsSource = readSrc('stremio-ws.js');

const ACTION_MAP = extractObjectMap(actionsSource, 'ACTION');
const COMMAND_MAP = extractObjectMap(protocolSource, 'COMMAND');
const EVENT_MAP = extractObjectMap(protocolSource, 'EVENT');
const ERROR_CODE_MAP = extractObjectMap(protocolSource, 'ERROR_CODE');

let bgCases = extractSwitchCases(bgSource, 'action');
if (bgCases.size === 0) bgCases = extractObjectHandlerKeys(bgSource, 'messageHandlers', ACTION_MAP);

let contentCases = extractSwitchCases(contentSource, 'action');
if (contentCases.size === 0) contentCases = extractObjectHandlerKeys(contentSource, 'actionHandlers', ACTION_MAP);

const overlaySends = extractSentActions(overlaySource, ACTION_MAP);
const popupSends = extractSentActions(popupSource, ACTION_MAP);
const bridgeSends = extractSentActions(bridgeSource, ACTION_MAP);
const contentEventCases = extractProtocolSwitchCases(contentSource, 'EVENT');
const commandSends = new Set([...extractProtocolSends(contentSource), ...extractProtocolSends(wsSource)]);
const contentErrorCodes = extractProtocolErrorCodes(contentSource);

console.log('--- Parsed routing table ---');
console.log(`  background.js cases:     ${[...bgCases].sort().join(', ')}`);
console.log(`  stremio-content cases:   ${[...contentCases].sort().join(', ')}`);
console.log(`  overlay sends:           ${[...overlaySends].sort().join(', ')}`);
console.log(`  popup sends:             ${[...popupSends].sort().join(', ')}`);
console.log(`  landing bridge sends:    ${[...bridgeSends].sort().join(', ')}`);

const BG_ONLY_ACTIONS = new Set([
  ACTION_MAP.STATUS_GET,
  ACTION_MAP.SESSION_STATE_PUBLISH,
  ACTION_MAP.PROFILE_UPDATED,
  ACTION_MAP.CLIPBOARD_COPY,
  ACTION_MAP.AUTH_KEY_SAVE,
  ACTION_MAP.ROOM_RESUME,
  ACTION_MAP.APP_STREMIO_OPEN,
  ACTION_MAP.APP_OPTIONS_OPEN,
  ACTION_MAP.CONTROLLER_LEASE_CLAIM,
  ACTION_MAP.CONTROLLER_LEASE_RELEASE,
  ACTION_MAP.ACTIVE_VIDEO_LEASE_CLAIM,
  ACTION_MAP.ACTIVE_VIDEO_LEASE_RELEASE,
]);

const BG_NON_UI_SENDERS = new Set([
  ACTION_MAP.CONTROLLER_RELEASED,
  ACTION_MAP.SESSION_STATE_PUBLISH,
  ACTION_MAP.PROFILE_UPDATED,
  ACTION_MAP.CLIPBOARD_COPY,
  ACTION_MAP.AUTH_KEY_SAVE,
  ACTION_MAP.ROOM_RESUME,
  ACTION_MAP.APP_STREMIO_OPEN,
  ACTION_MAP.APP_OPTIONS_OPEN,
  ACTION_MAP.ROOM_MEMBER_PRESENCE_PUBLISH,
  ACTION_MAP.ROOM_MEMBER_PLAYBACK_STATUS_PUBLISH,
  ACTION_MAP.SESSION_USERNAME_UPDATE,
  ACTION_MAP.ROOM_CHAT_EVENT,
  ACTION_MAP.ROOM_TYPING_EVENT,
  ACTION_MAP.ROOM_BOOKMARK_EVENT,
  ACTION_MAP.ROOM_REACTION_EVENT,
  ACTION_MAP.ROOM_ERROR_EVENT,
  ACTION_MAP.SURFACE_READY,
  ACTION_MAP.ROOM_CHAT_SEND,
  ACTION_MAP.ROOM_TYPING_SEND,
  ACTION_MAP.ROOM_REACTION_SEND,
  ACTION_MAP.ROOM_BOOKMARK_ADD,
  ACTION_MAP.ROOM_BOOKMARK_SEEK,
  ACTION_MAP.ROOM_READY_CHECK_UPDATE,
  ACTION_MAP.ROOM_OWNERSHIP_TRANSFER,
  ACTION_MAP.ROOM_PLAYBACK_REQUEST_SYNC,
  ACTION_MAP.ROOM_VISIBILITY_UPDATE,
  ACTION_MAP.ROOM_SETTINGS_UPDATE,
]);

console.log('\n--- Test 1: Overlay actions -> stremio-content ---');
for (const action of overlaySends) {
  ok(contentCases.has(action), `overlay sends '${action}' -> stremio-content has case`);
}

console.log('\n--- Test 2: Popup actions -> background ---');
for (const action of popupSends) {
  ok(bgCases.has(action), `popup sends '${action}' -> background has case`);
}

console.log('\n--- Test 2b: Landing bridge actions -> background ---');
for (const action of [
  ACTION_MAP.STATUS_GET,
  ACTION_MAP.SURFACE_READY,
  ACTION_MAP.AUTH_KEY_SAVE,
  ACTION_MAP.ROOM_JOIN,
  ACTION_MAP.ROOM_CREATE,
  ACTION_MAP.ROOM_RESUME,
  ACTION_MAP.APP_OPTIONS_OPEN,
  ACTION_MAP.APP_STREMIO_OPEN,
]) {
  ok(bridgeSends.has(action), `landing bridge sends '${action}'`);
  ok(bgCases.has(action) || BG_ONLY_ACTIONS.has(action), `landing bridge action '${action}' resolves in background`);
}

console.log('\n--- Test 3: Forwarded actions -> stremio-content ---');
const allSenderActions = new Set([...overlaySends, ...popupSends]);
for (const action of allSenderActions) {
  if (BG_ONLY_ACTIONS.has(action)) continue;
  ok(contentCases.has(action), `forwarded '${action}' -> stremio-content has case`);
}

console.log('\n--- Test 4: No dead cases in background ---');
for (const action of bgCases) {
  if (BG_NON_UI_SENDERS.has(action) || BG_ONLY_ACTIONS.has(action)) continue;
  ok(allSenderActions.has(action), `background case '${action}' is sent by overlay or popup`);
}

console.log('\n--- Test 5: Action contract sanity ---');
ok(Object.keys(ACTION_MAP).length >= 20, `wp-actions.js exposes ${Object.keys(ACTION_MAP).length} actions`);
ok(actionsSource.includes('AUTO-GENERATED'), 'wp-actions.js is generated');
ok(constantsSource.includes('const ACTION = WPAction;'), 'constants.js consumes the generated action contract');
ok(constantsSource.includes('BOOTSTRAP_ROOM_INTENT'), 'constants.js defines bootstrap room intent');
ok(constantsSource.includes('STORAGE_CONTRACT'), 'constants.js documents the storage contract');
ok(constantsSource.includes('SESSION_RUNTIME'), 'constants.js defines session runtime storage keys');
ok(constantsSource.includes('BOOTSTRAP_SESSION'), 'constants.js defines bootstrap session keys');
ok(constantsSource.includes('CONTROLLER_TAB_LEASE'), 'constants.js defines controller lease contract');
ok(constantsSource.includes('VIDEO_TAB_LEASE'), 'constants.js defines active video lease contract');
ok(!sidepanelSource.includes('PENDING_ACTION'), 'sidepanel does not use transient action storage');
ok(!bgSource.includes('PENDING_ACTION'), 'background does not use transient action storage');
ok(!contentSource.includes('PENDING_ACTION'), 'stremio-content does not use transient action storage');
ok(!contentSource.includes('PENDING_ROOM_CREATE'), 'stremio-content does not stage create commands in storage');
ok(!contentSource.includes('PENDING_LEAVE_ROOM'), 'stremio-content does not depend on old pending leave storage state');
ok(optionsSource.includes('btn-copy-diagnostics'), 'options exposes diagnostics actions');

console.log('\n=== Protocol Completeness Tests ===\n');
console.log(`  COMMAND types: ${Object.keys(COMMAND_MAP).length}`);
console.log(`  EVENT types:   ${Object.keys(EVENT_MAP).length}`);
console.log(`  Error codes:   ${Object.keys(ERROR_CODE_MAP).length}`);

console.log('\n--- Test 6: Every EVENT type has a handler ---');
const EVENT_HANDLED_ELSEWHERE = new Set(['SESSION_CLOCK_PONG']);
for (const [constName, value] of Object.entries(EVENT_MAP)) {
  if (EVENT_HANDLED_ELSEWHERE.has(constName)) {
    ok(wsSource.includes(`WPProtocol.EVENT.${constName}`), `EVENT.${constName} ('${value}') handled in stremio-ws.js`);
  } else {
    ok(contentEventCases.has(constName), `EVENT.${constName} ('${value}') handled in stremio-content`);
  }
}

console.log('\n--- Test 7: Every send uses a valid COMMAND constant ---');
for (const constName of commandSends) {
  ok(constName in COMMAND_MAP, `COMMAND.${constName} exists in wp-protocol.js`);
}

console.log('\n--- Test 8: Every COMMAND type is sent by the extension ---');
for (const [constName, value] of Object.entries(COMMAND_MAP)) {
  ok(commandSends.has(constName), `COMMAND.${constName} ('${value}') is used in a send() call`);
}

console.log('\n--- Test 9: Error handler covers key error codes ---');
for (const code of ['ROOM_NOT_FOUND', 'NOT_OWNER', 'COOLDOWN', 'VALIDATION_FAILED']) {
  ok(contentErrorCodes.has(code), `ERROR_CODE.${code} handled in stremio-content`);
}

console.log('\n--- Test 10: No hardcoded WS message type strings remain ---');
const contentHardcoded = findHardcodedTypes(contentSource);
const wsHardcoded = findHardcodedTypes(wsSource);
ok(contentHardcoded.length === 0, `stremio-content has no hardcoded WS message types${contentHardcoded.length ? `: ${contentHardcoded.join(', ')}` : ''}`);
ok(wsHardcoded.length === 0, `stremio-ws has no hardcoded WS message types${wsHardcoded.length ? `: ${wsHardcoded.join(', ')}` : ''}`);

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed (${total} total)`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
