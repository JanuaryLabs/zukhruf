// One tooltip for each mark that has data-tip. Its text goes in with
// textContent, and keyboard focus shows it as hover does. A copy of mteb's
// (packages/mteb/src/report/script.ts, docs/copied-code.md).
export const script = `
const tip = document.getElementById('tip');
let shown = null;
function show(target) {
  const { title, rows } = JSON.parse(target.dataset.tip);
  const head = document.createElement('div');
  head.className = 'tip-title';
  head.textContent = title;
  tip.replaceChildren(head, ...rows.map(([value, label, series]) => {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const swatch = document.createElement('span');
    swatch.className = 'tip-key';
    if (series) swatch.dataset.series = series;
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
`;
