const frame = document.getElementById('preview');
const stage = document.querySelector('.stage');
const scenario = document.getElementById('scenario');
let screen = 'overlay';
const hints = {
  overlay: 'Open Settings in the sidebar to try the new preferences.',
  options: 'Expand Connection, Fix a problem or Technical details. Resets affect preview data only.',
  popup: 'Try the compact launcher. Open Stremio leads to the sample sidebar, not the live site.',
  sidepanel: 'Try the room actions and sample chat, or select Not in a room to see the empty state.',
};
function render() {
  for (const button of document.querySelectorAll('[data-screen]')) {
    if (button instanceof HTMLButtonElement) button.setAttribute('aria-pressed', String(button.dataset.screen === screen));
  }
  stage.dataset.screen = screen;
  frame.title = `${screen} — sample extension UI`;
  document.getElementById('screen-hint').textContent = hints[screen];
  frame.src = `${screen === 'overlay' ? '/preview/overlay.html' : `/extension/${screen}.html`}?scenario=${scenario.value}`;
}
document.querySelectorAll('button[data-screen]').forEach(button => button.addEventListener('click', () => { screen = button.dataset.screen; render(); }));
scenario.addEventListener('change', render);
