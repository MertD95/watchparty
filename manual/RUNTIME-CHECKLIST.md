# Manual Runtime Checklist

Manual browser testing is the source of truth for runtime confidence. Use scripts only to prepare, perturb, and inspect local state. The browser sessions should make the actual product judgment.

## Setup

```bash
npm run manual:urls
npm run manual:reset
npm run manual:users -- room --peers 3 --room-name manual-bot-room
```

Prepare an automation-only unpacked extension copy with localhost WatchParty origins promoted to normal host permissions before local bridge checks. Local `http://127.0.0.1:8090` bridge flows can then be tested without changing the production extension manifest.
Routine stack restarts should preserve active browser profiles unless the persistent profiles themselves must be rebuilt.
Browser tooling health checks do not replace manual product testing in the browser profiles.

Use three browser profiles:

- `playwright` - host profile with the extension loaded.
- `playwright_peer` - peer profile with the extension loaded.
- `playwright_web` - clean website profile without extension state.

Use `npm run manual:state` between scenarios to inspect room, session, websocket, and diagnostic state. Use `npm run manual:users -- join <roomId> --peers 5` when a browser-created room needs more live users than the host and peer profiles can provide.

## Website And Bridge

- Local landing at `http://127.0.0.1:8090` with no extension state: install/extension-needed copy, public room preview, invalid invite input.
- Local landing at `http://127.0.0.1:8090` with the host extension loaded: extension-ready state opens Stremio for setup; Join Room, Direct Join, and `/r/<roomId>` remain fallback invite handoffs.
- Production landing at `https://watchparty.mertd.me` with the host extension loaded: smoke extension-ready state and redirect handoff when release behavior needs confirmation.
- Listed public rooms: cards appear, summary counts update, SSE refreshes without full reload, stale snapshots do not overwrite newer SSE state.
- Listed private rooms: invite-key copy appears, direct join requires key entry, full invite link forwards room ID, access key, and E2E key through the landing bridge. `seed private` is a listing fixture; use the real host UI when validating a joinable private invite.
- Hidden rooms: host listing toggle removes the room from `/rooms` and the website, then re-listing restores it.
- Reconnecting rooms: use `npm run manual -- seed reconnecting` or `reconnect-grace`; confirm reconnecting label, grace countdown, and card alignment.
- Debrid/manual-join rooms: use `npm run manual -- seed debrid`; confirm the warning, title-page handoff, and no direct use of the host's debrid stream URL.

## Stremio Host And Peer

- Create room from the Stremio sidebar no-room Rooms tab; confirm host controls attach and `/rooms` exposes safe listing metadata.
- Join room from the Stremio sidebar no-room Rooms tab using a full invite link or room ID.
- Browse Active Rooms from the Stremio sidebar; public rooms can join directly, private listed rooms prompt for the full invite link with both access and E2E keys.
- Popup and side panel are launcher/recovery surfaces only; confirm they open Stremio instead of presenting primary setup UI.
- Create room directly from a Stremio player page; confirm host controls attach and `/rooms` exposes safe direct-join metadata.
- Detail page to player route upgrade: create on detail page, then open player; confirm direct-join metadata updates.
- Player sync: host play/pause/seek changes reach peer; peer catches up after opening a video late; only the active video tab sends sync.
- Manual/debrid peer flow: peer opens a different local stream for the same title and still catches up.
- Multi-tab same profile: second Stremio tab hydrates room state and chat history; inactive tabs do not publish gated sync/presence messages.
- Bot-assisted occupancy: start `manual:users`, then inspect website counts, People panel, active/away status, chat activity, bookmark entries, and playback drift while real WebSocket users stay connected.

## Realtime Collaboration

- Chat roundtrip host to peer and peer to host.
- Chat unread badge increments while closed and clears after opening chat.
- Rapid second message is blocked by client cooldown.
- Typing indicator appears remotely and clears after send/timeout.
- Per-message reaction from host appears on peer message pill; peer reaction appears on host message pill.
- Floating reactions and reaction sound preferences work independently of per-message pills.
- Bookmark creation propagates to peer; clicking bookmark seeks the peer video.
- Ready check and countdown are centered, synchronized, and recover after sidebar open/close.

## Room Access And Recovery

- Private room join without key fails.
- Private room join with wrong valid-shape key fails.
- Private room join with full invite succeeds.
- Occupied public room can become invite-only without exposing raw keys to existing peers; existing peers reconnect with admission token.
- Occupied private room rejects access-key rotation.
- Duplicate display names in the same room are rejected.
- Leave while disconnected clears the public room after reconnect.
- Host disconnect enters reconnect grace; reconnecting host resumes ownership; expired empty room disappears.
- Owner-only settings remain unavailable to peer: invite key, listing, auto-pause, ownership transfer.
- Peer personal settings remain available: reaction sound, appearance.

## Perturbation Helpers

```bash
npm run manual:slow
npm run manual -- sse-burst 10
npm run manual -- controls --ws-delay-ms 2500 --rooms-stream-debounce-ms 0
npm run manual:users -- join <roomId> --peers 5
npm run manual:normal
```

Use these while host and peer tabs are open to inspect delay, burst, reconnect, stale-data, and UI recovery behavior.

## Evidence

Collect snapshots/screenshots and console errors from all three profiles for each broad pass. Do not treat script output as proof that the UI works; it is only state context for manual inspection.
