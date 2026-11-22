// Release timeline (Releases.astro): a tablist of versions, one panel each.
// Roving tabindex, arrow keys, Home/End, newer/older buttons. Selecting a version plays its
// wave: only the --progress custom property changes (it transitions in CSS), never a bar height.
//
// Nothing here reads layout at startup: the scroll-edge fade is measured when the section comes
// near the viewport (IntersectionObserver), and a tab is only scrolled into view after the
// visitor picks one.

const root = document.querySelector<HTMLElement>('[data-rel]');

if (root) {
  const list = root.querySelector<HTMLElement>('[role="tablist"]')!;
  const wrap = list.parentElement!;
  const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-rel-panel]'));
  const prev = root.querySelector<HTMLButtonElement>('[data-rel-prev]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-rel-next]')!;
  const all = root.querySelector<HTMLButtonElement>('[data-rel-all]');
  const allLabel = root.querySelector<HTMLElement>('[data-rel-all-label]');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const wide = matchMedia('(min-width: 768px)');
  let current = 0;
  let measured = false; // the section has come near the viewport, so layout reads are cheap and useful

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

  // Is the horizontal strip scrolled to its end? Only the wide strip scrolls (the phone list is
  // a plain column), so the fade is a wide-only thing.
  const edges = () => {
    if (!wide.matches) return;
    wrap.dataset.end = String(list.scrollLeft + list.clientWidth >= list.scrollWidth - 4);
  };

  const reveal = (tab: HTMLElement) => {
    if (!wide.matches) {
      // The phone list does not scroll inside itself; bring the tab into the page only if it is hidden.
      return;
    }
    const smooth = reduce.matches ? 'auto' : 'smooth';
    list.scrollTo({ left: tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2, behavior: smooth });
  };

  const setAll = (open: boolean) => {
    list.dataset.collapsed = String(!open);
    all?.setAttribute('aria-expanded', String(open));
    if (allLabel) allLabel.textContent = open ? 'Show fewer releases' : `Show all ${tabs.length} releases`;
  };

  const select = (i: number, opts: { focus?: boolean; user?: boolean } = {}) => {
    if (i < 0 || i >= tabs.length) return;
    const changed = i !== current;
    // A tab hidden behind "Show all" opens the list first, so focus can land on it.
    if (tabs[i].hasAttribute('data-more') && list.dataset.collapsed === 'true' && !wide.matches) setAll(true);
    tabs.forEach((t, j) => {
      t.setAttribute('aria-selected', String(j === i));
      t.tabIndex = j === i ? 0 : -1;
      panels[j].hidden = j !== i;
    });
    current = i;
    prev.disabled = i === 0;
    next.disabled = i === tabs.length - 1;
    if (opts.focus) tabs[i].focus();
    if (opts.user) reveal(tabs[i]);

    if (changed) {
      // Rewind, then let the CSS transition play the fill to the end.
      const wave = stageWave(i)!;
      wave.style.setProperty('--progress', '0');
      void wave.getBoundingClientRect(); // commit the rewind; only after a visitor action
      wave.style.setProperty('--progress', '1');
    }
  };

  const orient = () => list.setAttribute('aria-orientation', wide.matches ? 'horizontal' : 'vertical');
  orient();
  wide.addEventListener('change', () => {
    orient();
    if (measured) edges();
  });

  tabs.forEach((t, i) => t.addEventListener('click', () => select(i, { user: true })));
  prev.addEventListener('click', () => select(current - 1, { user: true }));
  next.addEventListener('click', () => select(current + 1, { user: true }));
  all?.addEventListener('click', () => setAll(list.dataset.collapsed === 'true'));

  list.addEventListener('keydown', (e) => {
    const back = wide.matches ? 'ArrowLeft' : 'ArrowUp';
    const fwd = wide.matches ? 'ArrowRight' : 'ArrowDown';
    const target =
      e.key === back ? current - 1 : e.key === fwd ? current + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (target < 0) return;
    e.preventDefault();
    select(Math.min(tabs.length - 1, target), { focus: true, user: true });
  });

  list.addEventListener('scroll', edges, { passive: true });

  // Select the first release without touching layout, then measure once the section is near.
  select(0);
  new IntersectionObserver(
    (entries, io) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      measured = true;
      edges();
    },
    { rootMargin: '300px 0px' },
  ).observe(root);
}

export {};
