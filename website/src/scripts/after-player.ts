// After the call (AfterCall.astro): the sample recording. A playhead, a transcript that follows it,
// and tabs. No audio: the playhead runs fast.
// Without JS the markup shows its resting state (playhead at data-rest, every panel stacked).
// No layout reads at startup: the transcript is first centred on the active line when the section
// comes near the viewport (IntersectionObserver) or the visitor interacts, not on page load.
const root = document.querySelector<HTMLElement>('[data-ac]');
if (root) {
  const DUR = Number(root.dataset.dur);
  const REST = Number(root.dataset.rest);
  const RATE = DUR / 30; // sample seconds per real second
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  const pane = $('[data-ac-lines]');
  const lines = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-t]'));
  const times = lines.map((l) => Number(l.dataset.t));
  const slider = $('[data-ac-slider]');
  const clock = $('[data-ac-now]');
  const play = $<HTMLButtonElement>('[data-ac-play]');

  let t = REST * DUR;
  let playing = false;
  let manual = reduce; // once the visitor takes over (or reduced motion), scrolling no longer moves the playhead
  let onscreen = false;
  let active = lines.findIndex((l) => l.getAttribute('aria-current') === 'true');
  let raf = 0;
  let last = 0;
  let armed = false; // layout reads (follow) wait until the section is near or the visitor acts

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const follow = (smooth: boolean) => {
    if (!armed) return;
    const li = lines[active]?.parentElement;
    if (!li || !pane.offsetParent) return;
    pane.scrollTo({
      top: li.offsetTop - (pane.clientHeight - li.offsetHeight) / 2,
      behavior: smooth && !reduce ? 'smooth' : 'auto',
    });
  };

  const arm = () => {
    if (armed) return;
    armed = true;
    if (active >= 0) follow(false);
  };

  // --progress lives on the player's waveform only, so moving it restyles a handful of nodes.
  const render = (smooth = false) => {
    slider.style.setProperty('--progress', String(t / DUR));
    clock.textContent = fmt(t);
    slider.setAttribute('aria-valuenow', String(Math.floor(t)));
    slider.setAttribute('aria-valuetext', `${fmt(t)} of ${fmt(DUR)}`);
    let a = -1;
    for (let i = 0; i < times.length; i++) if (times[i] <= t) a = i;
    if (a !== active) {
      lines[active]?.removeAttribute('aria-current');
      active = a;
      lines[a]?.setAttribute('aria-current', 'true');
      follow(smooth);
      if (a >= 0 && !pane.contains(document.activeElement)) setStop(a);
    }
  };

  const seek = (s: number, smooth = true) => {
    arm();
    t = Math.max(0, Math.min(DUR, s));
    manual = true;
    render(smooth);
  };

  // One rAF loop, only while playing, on screen and the tab is visible.
  const tick = (now: number) => {
    t = Math.min(DUR, t + ((now - last) / 1000) * RATE);
    last = now;
    render(true);
    if (t >= DUR) setPlaying(false);
    else raf = requestAnimationFrame(tick);
  };
  const sync = () => {
    const run = playing && onscreen && !document.hidden;
    if (run && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  const setPlaying = (v: boolean) => {
    playing = v;
    if (!v && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    play.toggleAttribute('data-playing', v);
    play.setAttribute('aria-label', v ? 'Pause' : 'Play');
    if (v) {
      arm();
      manual = true;
      if (t >= DUR - 1) t = 0;
    }
    sync();
  };
  play.addEventListener('click', () => setPlaying(!playing));
  document.addEventListener('visibilitychange', sync);

  new IntersectionObserver(
    (e) => {
      onscreen = e[0].isIntersecting;
      if (onscreen) arm();
      sync();
      if (onscreen) onScroll();
    },
    { rootMargin: '300px 0px' },
  ).observe(root);

  // Scrolling moves the playhead until the visitor takes over: 0 as the window enters, 1 as it leaves.
  let pending = 0;
  function onScroll() {
    if (manual || pending || !onscreen) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      const r = root!.getBoundingClientRect();
      const vh = innerHeight;
      const p = (0.85 * vh - r.top) / (0.35 * vh + r.height);
      t = Math.max(0, Math.min(1, p)) * DUR;
      render(false);
    });
  }
  addEventListener('scroll', onScroll, { passive: true });

  // Rows and bookmarks seek. The transcript is one tab stop (roving tabindex): Tab lands on the current
  // line, Up and Down move between lines, Home and End jump to the first and last, Enter or Space seeks.
  let stop = Math.max(0, active);
  const setStop = (i: number) => {
    lines[stop].tabIndex = -1;
    stop = i;
    lines[stop].tabIndex = 0;
  };
  lines.forEach((l, i) => l.addEventListener('click', () => seek(times[i])));
  lines.forEach((l, i) => l.addEventListener('focus', () => setStop(i)));
  lines.forEach((l) =>
    l.addEventListener('keydown', (e) => {
      const i = lines.indexOf(l);
      const n = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? lines.length - 1 : -1;
      if (n < 0 || n >= lines.length) return;
      e.preventDefault();
      lines[n].focus();
    }),
  );
  root.querySelectorAll<HTMLElement>('[data-seek]').forEach((b) =>
    b.addEventListener('click', () => {
      showTab(0);
      seek(Number(b.dataset.seek));
    }),
  );

  // The waveform is a slider: drag or click, arrows, Page keys, Home and End.
  const at = (x: number) => {
    const r = slider.getBoundingClientRect();
    seek(((x - r.left) / r.width) * DUR, false);
  };
  slider.addEventListener('pointerdown', (e) => {
    slider.setPointerCapture(e.pointerId);
    at(e.clientX);
  });
  slider.addEventListener('pointermove', (e) => {
    if (slider.hasPointerCapture(e.pointerId)) at(e.clientX);
  });
  slider.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -30, ArrowDown: -30, ArrowRight: 30, ArrowUp: 30, PageDown: -300, PageUp: 300 }[e.key];
    if (step !== undefined) seek(t + step);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(DUR);
    else return;
    e.preventDefault();
  });

  // Tabs.
  const tabs = Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));
  const feats = Array.from(document.querySelectorAll<HTMLElement>('[data-go]'));
  // Tabs that do not fit scroll sideways. The wrapper says which edge still has tabs beyond it (a fade, see CSS),
  // and a tab the visitor picks is scrolled into the middle so it is never left half hidden.
  const bar = $('[data-ac-tabs]');
  const barWrap = $('[data-ac-tabs-wrap]');
  const edges = () => {
    barWrap.toggleAttribute('data-more-l', bar.scrollLeft > 4);
    barWrap.toggleAttribute('data-more-r', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4);
  };
  bar.addEventListener('scroll', edges, { passive: true });
  new ResizeObserver(edges).observe(bar);
  const reveal = (b: HTMLElement) =>
    bar.scrollTo({ left: b.offsetLeft - (bar.clientWidth - b.offsetWidth) / 2, behavior: reduce ? 'auto' : 'smooth' });

  function showTab(i: number, focus = false) {
    tabs.forEach((b, j) => {
      b.setAttribute('aria-selected', String(j === i));
      b.tabIndex = j === i ? 0 : -1;
      root!.querySelector(`#${b.getAttribute('aria-controls')}`)?.toggleAttribute('data-on', j === i);
    });
    feats.forEach((f) => (f.dataset.go === tabs[i].dataset.tab ? f.setAttribute('aria-current', 'true') : f.removeAttribute('aria-current')));
    if (focus) tabs[i].focus();
    if (i === 0) follow(false);
  }
  tabs.forEach((b, i) =>
    b.addEventListener('click', () => {
      showTab(i);
      reveal(b);
    }),
  );
  $('[data-ac-tabs]').addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    showTab(n, true);
  });
  feats.forEach((f) =>
    f.addEventListener('click', () => {
      const i = tabs.findIndex((b) => b.dataset.tab === f.dataset.go);
      showTab(i);
      reveal(tabs[i]);
    }),
  );
  showTab(0);
}

export {};
