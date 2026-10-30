// One tooltip for each mark that has data-tip. Its text goes in with
// textContent, and keyboard focus shows it as hover does. The split switch
// shows the sections of one split at a time.
export const script = `
const tip = document.getElementById('tip');
let shown = null;
function show(target) {
  const { title, rows } = JSON.parse(target.dataset.tip);
  const head = document.createElement('div');
  head.className = 'tip-title';
  head.textContent = title;
  tip.replaceChildren(head, ...rows.map(([value, label, key]) => {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const swatch = document.createElement('span');
    swatch.className = 'tip-key';
    if (key) swatch.dataset.role = key;
    const strong = document.createElement('strong');
    strong.textContent = value;
    const text = document.createElement('span');
    text.textContent = label;
    row.append(swatch, strong, text);
    return row;
  }));
  tip.hidden = false;
  shown = target;
}
function place(x, y) {
  const { width, height } = tip.getBoundingClientRect();
  const left = Math.min(x + 14, innerWidth - width - 8);
  const top = y + 14 + height > innerHeight ? y - height - 14 : y + 14;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}
function hide() {
  tip.hidden = true;
  shown = null;
}
function track(event) {
  const target = event.target.closest?.('[data-tip]');
  if (!target) return hide();
  if (target !== shown) show(target);
  place(event.clientX, event.clientY);
}
document.addEventListener('pointermove', track);
document.addEventListener('pointerdown', track);
document.documentElement.addEventListener('pointerleave', hide);
document.addEventListener('focusin', (event) => {
  const target = event.target.closest?.('[data-tip]');
  if (!target) return;
  show(target);
  const box = target.getBoundingClientRect();
  place(box.left + box.width / 2, box.bottom);
});
document.addEventListener('focusout', hide);
for (const button of document.querySelectorAll('.splits button'))
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.splits button'))
      other.setAttribute('aria-pressed', String(other === button));
    for (const split of document.querySelectorAll('.split'))
      split.hidden = split.dataset.split !== button.dataset.split;
    hide();
  });
`;
