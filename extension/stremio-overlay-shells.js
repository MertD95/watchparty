// Overlay shell builders: pure markup helpers for settings and room-control cards.
// Loaded before stremio-overlay.js.

const WPOverlayShells = (() => {
  'use strict';

  function buildToggleRow(inputId, label, description, checked) {
    return `
      <label class="wp-setting-row" for="${inputId}">
        <span class="wp-setting-copy">
          <span class="wp-setting-label">${WPUtils.escapeHtml(label)}</span>
          <span class="wp-setting-desc">${WPUtils.escapeHtml(description)}</span>
        </span>
        <span class="wp-toggle-shell">
          <input type="checkbox" id="${inputId}" ${checked ? 'checked' : ''} />
          <span class="wp-toggle-ui" aria-hidden="true">
            <span class="wp-toggle-knob"></span>
          </span>
        </span>
      </label>
    `;
  }

  function buildLocalSettingsShell(accentButtonsHtml) {
    return `
      <div class="wp-card-title">Your settings</div>
      <div class="wp-card-copy">Personal preferences for this browser.</div>
      <label class="wp-settings-subtitle" for="wp-settings-username">Display name</label>
      <div class="wp-name-row">
        <input id="wp-settings-username" class="wp-name-input" type="text" maxlength="25" placeholder="Display name" />
        <button class="wp-name-save" id="wp-settings-save-name" type="button">Save</button>
      </div>
      <div class="wp-settings-subtitle">Appearance</div>
      <div class="wp-setting-list">
        ${buildToggleRow('wp-settings-compact', 'Compact chat', 'Denser chat spacing.', false)}
      </div>
      <div class="wp-color-setting">
        <span class="wp-setting-label" id="wp-accent-label">Accent color</span>
        <div class="wp-color-row" role="group" aria-labelledby="wp-accent-label">${accentButtonsHtml}</div>
      </div>
      <div class="wp-settings-subtitle">Reactions</div>
      <div class="wp-setting-list">
        ${buildToggleRow('wp-settings-sound', 'Play sounds', 'A short sound when someone reacts.', false)}
        ${buildToggleRow('wp-settings-floating', 'Show over the video', 'Float emoji reactions over playback.', false)}
      </div>
      <div class="wp-preference-note">Appearance and reactions save automatically.</div>
    `;
  }

  function buildRoomControlsShell(isHost) {
    return `
      <div class="wp-card-title">Your room</div>
      <div class="wp-card-copy" id="wp-room-controls-copy"></div>
      <div class="wp-inline-grid wp-room-actions">
        <button class="wp-action-btn wp-primary-action" id="wp-copy-invite-btn" type="button">Copy invite</button>
        <button class="wp-action-btn wp-leave-action" id="wp-leave-room-btn" type="button">Leave room</button>
      </div>
      ${isHost ? `
        <details class="wp-settings-details" id="wp-room-settings-details">
        <summary>Room settings <span>For everyone</span></summary>
        <div class="wp-setting-list">
          ${buildToggleRow('wp-session-private', 'Invite-only room', 'Joining requires your full invite link.', false)}
          ${buildToggleRow('wp-session-listed', 'List in Browse rooms', 'Let others discover this room.', true)}
          ${buildToggleRow('wp-session-autopause', 'Pause on disconnect', 'Pause playback if someone disconnects.', false)}
        </div>
        </details>
      ` : `
        <div class="wp-preference-note">The host manages room settings.</div>
      `}
      <details id="wp-room-key-section" class="wp-settings-details wp-hidden-el">
        <summary>Advanced invite settings</summary>
        <label class="wp-settings-subtitle" for="wp-room-key-input">Invite key</label>
        <div class="wp-name-row wp-room-key-row">
          <input id="wp-room-key-input" class="wp-name-input wp-room-key-input" type="text" spellcheck="false" autocomplete="off" />
          ${isHost ? '<button class="wp-name-save wp-room-key-btn" id="wp-room-key-save" type="button">Update</button>' : ''}
        </div>
        <div class="wp-room-key-help" id="wp-room-key-help"></div>
      </details>
    `;
  }

  function buildLobbyShell() {
    return `
      <div class="wp-lobby-card" id="wp-lobby-setup-card">
        <div class="wp-card-title">Watch together</div>
        <div class="wp-card-copy">Create a room or join your friends.</div>

        <label class="wp-settings-subtitle" for="wp-lobby-username">Your name</label>
        <div class="wp-name-row">
          <input id="wp-lobby-username" class="wp-name-input" type="text" maxlength="25" placeholder="Display name" />
          <button class="wp-name-save" id="wp-lobby-save-name" type="button">Save</button>
        </div>

        <div class="wp-lobby-mode-row" role="tablist" aria-label="Room setup mode">
          <button class="wp-lobby-mode is-active" id="wp-lobby-mode-create" data-mode="create" type="button" role="tab" aria-controls="wp-lobby-create-panel" aria-selected="true">Create</button>
          <button class="wp-lobby-mode" id="wp-lobby-mode-join" data-mode="join" type="button" role="tab" aria-controls="wp-lobby-join-panel" aria-selected="false" tabindex="-1">Join</button>
        </div>

        <div id="wp-lobby-create-panel" class="wp-lobby-panel" role="tabpanel" aria-labelledby="wp-lobby-mode-create">
          <div class="wp-setting-list">
            ${buildToggleRow('wp-lobby-private', 'Invite-only room', 'Joining requires your full invite link.', true)}
          </div>
          <details class="wp-settings-details wp-lobby-options">
            <summary>Room name &amp; visibility</summary>
            <label class="wp-settings-subtitle" for="wp-lobby-room-name">Room name (optional)</label>
            <input id="wp-lobby-room-name" class="wp-name-input wp-lobby-full-input" type="text" maxlength="30" placeholder="Movie night" />
            <div class="wp-setting-list">
              ${buildToggleRow('wp-lobby-listed', 'List in Browse rooms', 'Let others discover this room.', true)}
            </div>
          </details>
          <button class="wp-action-btn wp-lobby-primary" id="wp-lobby-create-btn" type="button">Create Room</button>
          <div class="wp-lobby-feedback" id="wp-lobby-create-feedback" aria-live="polite"></div>
        </div>

        <div id="wp-lobby-join-panel" class="wp-lobby-panel wp-hidden-el" role="tabpanel" aria-labelledby="wp-lobby-mode-join">
          <label class="wp-settings-subtitle" for="wp-lobby-join-input">Invite link or room ID</label>
          <input id="wp-lobby-join-input" class="wp-name-input wp-lobby-full-input" type="text" placeholder="Paste invite link or room ID" />
          <button class="wp-action-btn wp-lobby-primary" id="wp-lobby-join-btn" type="button">Join Room</button>
          <div class="wp-lobby-feedback" id="wp-lobby-join-feedback" aria-live="polite"></div>
        </div>
      </div>

      <div class="wp-lobby-card" id="wp-lobby-directory-card">
        <div class="wp-lobby-card-head">
          <div>
            <div class="wp-card-title">Browse rooms</div>
            <div class="wp-card-copy" id="wp-lobby-directory-copy">Rooms you can join.</div>
          </div>
          <button class="wp-action-btn" id="wp-lobby-refresh-btn" type="button">Refresh</button>
        </div>
        <div id="wp-lobby-directory-status" class="wp-lobby-feedback"></div>
        <div id="wp-lobby-room-list" class="wp-lobby-room-list"></div>
      </div>
    `;
  }

  return {
    buildLobbyShell,
    buildLocalSettingsShell,
    buildRoomControlsShell,
  };
})();
