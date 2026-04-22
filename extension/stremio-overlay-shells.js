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
          ${buildToggleRow('wp-session-private', 'Require invite key', 'Only people with the invite key or full invite link can join this room.', false)}
          ${buildToggleRow('wp-session-listed', 'Show on WatchParty', 'Display this room on the WatchParty website so people can discover it there.', true)}
          ${buildToggleRow('wp-session-autopause', 'Pause if someone drops', 'Pause playback if someone disconnects unexpectedly.', false)}
        </div>
      ` : `
        <div class="wp-settings-note">Only the host can change join access, WatchParty listing, and playback safeguards. You can still copy the invite link and leave from here.</div>
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

  return {
    buildLocalSettingsShell,
    buildRoomControlsShell,
  };
})();
