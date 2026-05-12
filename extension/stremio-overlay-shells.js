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
      <div class="wp-card-title">Settings</div>
      <div class="wp-card-copy">Only for this browser.</div>
      <div class="wp-settings-subtitle">Display name</div>
      <div class="wp-name-row">
        <input id="wp-settings-username" class="wp-name-input" type="text" maxlength="25" placeholder="Display name" />
        <button class="wp-name-save" id="wp-settings-save-name" type="button">Save</button>
      </div>
      <div class="wp-settings-subtitle">Sidebar</div>
      <div class="wp-setting-list">
        ${buildToggleRow('wp-settings-compact', 'Compact chat', 'Denser chat spacing.', false)}
        ${buildToggleRow('wp-settings-sound', 'Reaction sounds', 'Play a short sound for reactions.', false)}
        ${buildToggleRow('wp-settings-floating', 'Floating reactions', 'Show reactions over the video.', false)}
      </div>
      <div class="wp-settings-subtitle">Accent color</div>
      <div class="wp-color-row">${accentButtonsHtml}</div>
    `;
  }

  function buildRoomControlsShell(isHost) {
    return `
      <div class="wp-card-title">Room controls</div>
      <div class="wp-card-copy" id="wp-room-controls-copy"></div>
      ${isHost ? `
        <div class="wp-settings-subtitle">Shared with everyone</div>
        <div class="wp-setting-list">
          ${buildToggleRow('wp-session-private', 'Require invite key', 'Require a full invite link to join.', false)}
          ${buildToggleRow('wp-session-listed', 'Show in room list', 'Show this room in Active Rooms.', true)}
          ${buildToggleRow('wp-session-autopause', 'Pause if someone drops', 'Pause on disconnect.', false)}
        </div>
      ` : `
        <div class="wp-settings-note">Only the host can edit room controls.</div>
      `}
      <div id="wp-room-key-section" class="wp-hidden-el">
        <div class="wp-settings-subtitle">Invite key</div>
        <div class="wp-name-row wp-room-key-row">
          <input id="wp-room-key-input" class="wp-name-input wp-room-key-input" type="text" spellcheck="false" autocomplete="off" />
          ${isHost ? '<button class="wp-name-save wp-room-key-btn" id="wp-room-key-save" type="button">Update Key</button>' : ''}
        </div>
        <div class="wp-room-key-help" id="wp-room-key-help"></div>
      </div>
      <div class="wp-settings-subtitle">Actions</div>
      <div class="wp-inline-grid">
        <button class="wp-action-btn" id="wp-copy-invite-btn" type="button">Copy Invite</button>
        <button class="wp-action-btn" id="wp-leave-room-btn" type="button">Leave Room</button>
      </div>
    `;
  }

  function buildLobbyShell() {
    return `
      <div class="wp-lobby-card" id="wp-lobby-setup-card">
        <div class="wp-card-title">Rooms</div>

        <div class="wp-settings-subtitle">Display name</div>
        <div class="wp-name-row">
          <input id="wp-lobby-username" class="wp-name-input" type="text" maxlength="25" placeholder="Display name" />
          <button class="wp-name-save" id="wp-lobby-save-name" type="button">Save</button>
        </div>

        <div class="wp-lobby-mode-row" role="tablist" aria-label="Room setup mode">
          <button class="wp-lobby-mode is-active" id="wp-lobby-mode-create" data-mode="create" type="button" role="tab" aria-selected="true">Create</button>
          <button class="wp-lobby-mode" id="wp-lobby-mode-join" data-mode="join" type="button" role="tab" aria-selected="false">Join</button>
        </div>

        <div id="wp-lobby-create-panel" class="wp-lobby-panel">
          <div class="wp-settings-subtitle">New room</div>
          <input id="wp-lobby-room-name" class="wp-name-input wp-lobby-full-input" type="text" maxlength="30" placeholder="Room name, optional" />
          <div class="wp-setting-list">
            ${buildToggleRow('wp-lobby-private', 'Require invite key', 'Require a full invite link to join.', true)}
            ${buildToggleRow('wp-lobby-listed', 'Show in room list', 'Show this room in Active Rooms.', true)}
          </div>
          <button class="wp-action-btn wp-lobby-primary" id="wp-lobby-create-btn" type="button">Create Room</button>
          <div class="wp-lobby-feedback" id="wp-lobby-create-feedback" aria-live="polite"></div>
        </div>

        <div id="wp-lobby-join-panel" class="wp-lobby-panel wp-hidden-el">
          <div class="wp-settings-subtitle">Join room</div>
          <input id="wp-lobby-join-input" class="wp-name-input wp-lobby-full-input" type="text" placeholder="Paste invite link or room ID" />
          <button class="wp-action-btn wp-lobby-primary" id="wp-lobby-join-btn" type="button">Join Room</button>
          <div class="wp-lobby-feedback" id="wp-lobby-join-feedback" aria-live="polite"></div>
        </div>
      </div>

      <div class="wp-lobby-card" id="wp-lobby-directory-card">
        <div class="wp-lobby-card-head">
          <div>
            <div class="wp-card-title">Active Rooms</div>
            <div class="wp-card-copy" id="wp-lobby-directory-copy">Active backend.</div>
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
