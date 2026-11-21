// Release timeline (Releases.astro): a tablist of versions, one panel each.
// Roving tabindex, arrow keys, Home/End, newer/older buttons. Selecting a version plays its
// wave: only the --progress custom property changes (it transitions in CSS), never a bar height.

const root = document.querySelector<HTMLElement>('[data-rel]');

if (root) {
  const list = root.querySelector<HTMLElement>('[role="tablist"]')!;
  const wrap = list.parentElement!;
  const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-rel-panel]'));
  const prev = root.querySelector<HTMLButtonElement>('[data-rel-prev]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-rel-next]')!;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const wide = matchMedia('(min-width: 768px)');
  let current = 0;

  panels.forEach((p, i) => {
    p.setAttribute('role', 'tabpanel');
    p.hidden = i !== 0;
  });

  // Fill a panel's big wave from the tab's small one (same bars, same heights).
  const stageWave = (i: number): HTMLElement | null => {
    const stage = panels[i].querySelector<HTMLElement>('[data-rel-stage]')!;
    let wave = stage.querySelector<HTMLElement>('.nx-wave');
    if (!wave) {
      wave = tabs[i].querySelector<HTMLElement>('.nx-wave')!.cloneNode(true) as HTMLElement;
      wave.classList.replace('nx-wave--sm', 'nx-wave--lg');
      wave.setAttribute('aria-label', `Release waveform for ${tabs[i].querySelector('.rel-tab__v')!.textContent}`);
      wave.style.setProperty('--progress', '1');
      stage.append(wave);
    }
    return wave;
  };

  const edges = () => {
    const end = wide.matches
      ? list.scrollLeft + list.clientWidth >= list.scrollWidth - 4
      : list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    wrap.dataset.end = String(end);
  };

  const reveal = (tab: HTMLElement) => {
    const smooth = reduce.matches ? 'auto' : 'smooth';
    if (wide.matches) list.scrollTo({ left: tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2, behavior: smooth });
    else list.scrollTo({ top: tab.offsetTop - (list.clientHeight - tab.offsetHeight) / 2, behavior: smooth });
  };

  const select = (i: number, focus = false) => {
    if (i < 0 || i >= tabs.length) return;
    const changed = i !== current;
    tabs.forEach((t, j) => {
      t.setAttribute('aria-selected', String(j === i));
      t.tabIndex = j === i ? 0 : -1;
      panels[j].hidden = j !== i;
    });
    current = i;
    prev.disabled = i === 0;
    next.disabled = i === tabs.length - 1;
    if (focus) tabs[i].focus();
    reveal(tabs[i]);

    if (changed) {
      // Rewind, then let the CSS transition play the fill to the end.
      const wave = stageWave(i)!;
      wave.style.setProperty('--progress', '0');
      void wave.offsetWidth;
      wave.style.setProperty('--progress', '1');
    }
  };

  const orient = () => list.setAttribute('aria-orientation', wide.matches ? 'horizontal' : 'vertical');
  orient();
  wide.addEventListener('change', () => {
    orient();
    edges();
  });

  tabs.forEach((t, i) => t.addEventListener('click', () => select(i)));
  prev.addEventListener('click', () => select(current - 1));
  next.addEventListener('click', () => select(current + 1));

  list.addEventListener('keydown', (e) => {
    const back = wide.matches ? 'ArrowLeft' : 'ArrowUp';
    const fwd = wide.matches ? 'ArrowRight' : 'ArrowDown';
    const target =
      e.key === back ? current - 1 : e.key === fwd ? current + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (target < 0) return;
    e.preventDefault();
    select(Math.min(tabs.length - 1, target), true);
  });

  list.addEventListener('scroll', edges, { passive: true });
  select(0);
  edges();
}

export {};
