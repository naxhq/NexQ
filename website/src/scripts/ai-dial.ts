// The "Where your words go" dial (YourAI.astro). A radiogroup: role=radio buttons with aria-checked, roving tabindex, arrow keys, Home and End,
// no state beyond the selected index. Panels show with [data-on]; without JS all stay visible.
const dial = document.querySelector<HTMLElement>('[data-ai-dial]');
if (dial) {
  const buttons = Array.from(dial.querySelectorAll<HTMLButtonElement>('button[data-pos]'));
  const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-ai-panel]'));

  const select = (i: number, focus = false) => {
    buttons.forEach((b, j) => {
      b.setAttribute('aria-checked', String(j === i));
      b.tabIndex = j === i ? 0 : -1;
    });
    panels.forEach((p, j) => p.toggleAttribute('data-on', j === i));
    dial.style.setProperty('--i', String(i));
    if (focus) buttons[i].focus();
  };

  dial.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-pos]');
    if (b) select(Number(b.dataset.pos));
  });

  dial.addEventListener('keydown', (e) => {
    const cur = buttons.findIndex((b) => b === document.activeElement);
    if (cur < 0) return;
    let next = cur;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur + buttons.length - 1) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else return;
    e.preventDefault();
    select(next, true);
  });
}
