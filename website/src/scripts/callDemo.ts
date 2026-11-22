/*
 * The sample call. One state machine, one requestAnimationFrame loop.
 *
 *  - Hero: the opening plays once (transcript words follow the release wave's playhead), then it HOLDS
 *    on the detected question. Assist (button, Space or 1-5 while the demo has focus) streams an answer.
 *  - Beats (900px and up): scrolling drives the call. One passive, rAF-throttled scroll handler reads
 *    where the middle of the screen sits among the beats (rects are measured once, on the first scroll,
 *    and again only after a resize), then picks the moment (`data-view` on .ov), sets the header timer
 *    and, where CSS scroll-driven animations are missing, the call-progress line. A beat's one visible
 *    change plays the first time it is shown (`data-play`) and never again.
 *  - Phones: no pin. Each still in a beat plays its change once when it scrolls into view.
 *  - The loop only runs while the demo is on screen, the tab is visible and nothing is paused.
 *
 * All text lives in the HTML (content.ts renders it), so this file only moves attributes and
 * reveals words. Without JavaScript, and under reduced motion, the HTML is already the final state.
 */
import { HERO_SECONDS, MODES, mmss } from '../components/overlay/content';
import { detectOS } from './os';

const HERO_MS = 8000;
// Boundaries between sending, waiting, thinking and writing (ms). The demo answers on the Fast tier
// (Haiku): first words in under a second.
const PHASES_ASSIST = [250, 450, 700];
const PHASES_QUICK = [200, 350, 500];
const WORD_MS = 70;
const PHASE_TEXT: Record<string, string> = {
  sending: 'Sending…',
  waiting: 'Waiting for the first words…',
  thinking: 'Thinking…',
  writing: 'Writing…',
};
const HINT = {
  wait: 'Listening to the call',
  hold: 'Question caught. Click Assist or press Space.',
  run: 'Answering',
  done: 'Try another action, or keys 1 to 4 in the overlay.',
};

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

interface HeroLine {
  tx: HTMLElement;
  tail: HTMLElement;
  el: HTMLElement;
  words: string[];
  from: number;
  to: number;
  shown: number;
  fin: number;
}
interface Run {
  mode: string;
  t: number;
  words: HTMLElement[];
  phases: number[];
  shown: number;
  phase: string;
  lastElapsed: number;
}
interface Span {
  id: string;
  top: number;
  bottom: number;
  t: number;
}

function init(stage: HTMLElement) {
  const ovFound = stage.querySelector<HTMLElement>('#nx-overlay');
  if (!ovFound) return;
  const ov: HTMLElement = ovFound;
  const $ = <T extends HTMLElement>(sel: string, root: ParentNode = stage) => root.querySelector<T>(sel);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wide = matchMedia('(min-width: 900px)');
  const pin = $('[data-pin]') ?? ov;
  const wave = $('[data-wave]');
  const timerEl = $('[data-timer]', ov);
  const liveEl = $('[data-sr]', ov);
  const hintEl = $('[data-hint]');
  const phaseEl = $('[data-phase]', ov);
  const elapsedEl = $('[data-elapsed]', ov);
  const progLabel = $('[data-prog-label]', ov);
  const doneLabel = $('[data-done-label]', ov);
  const doneTiming = $('[data-done-timing]', ov);
  const caret = $('.ov-caret', ov);
  const askBox = $('[data-ask-box]', ov);
  const assistMain = $('[data-assist-main]');
  const pauseBtn = $<HTMLButtonElement>('[data-pause]');
  const toggle = $<HTMLButtonElement>('[data-stealth-toggle]');
  const statusEl = $('[data-stealth-status]');
  const callLine = $('.nx-callline');
  const modeBtns = [...ov.querySelectorAll<HTMLButtonElement>('[data-mode-btn]')];
  // The keys and the card's Assist only belong to the hero moment (see setActive).
  const heroOnly = [$('.ov-modes', ov), $('.ov-qa[data-assist]', ov)];
  const beats = [...stage.querySelectorAll<HTMLElement>('[data-beat-id]')];

  // OS-aware download label (the link is the same for both: the latest release).
  if (detectOS() === 'mac') {
    stage.querySelectorAll<HTMLElement>('[data-os="win"]').forEach((n) => (n.hidden = true));
    stage.querySelectorAll<HTMLElement>('[data-os="mac"]').forEach((n) => (n.hidden = false));
  }

  const say = (text: string) => {
    if (liveEl) liveEl.textContent = text;
  };
  const hint = (text: string) => {
    if (hintEl) hintEl.textContent = text;
  };

  // ── State ──
  let p = reduce ? 1 : 0; // hero playhead 0..1
  let active = 'h'; // 'h' or a beat letter
  let paused = false;
  let onScreen = true;
  let run: Run | null = null;
  let raf = 0;
  let last = 0;
  let scrollT = HERO_SECONDS; // meeting time the scroll position stands for (seconds)
  let timerShown = '';
  let stealthTouched = false;
  let interacted = false; // the visitor has used the demo: only then do we speak up in the live region
  const played = new Set<string>();

  // ── Hero transcript ──
  const lines: HeroLine[] = [...ov.querySelectorAll<HTMLElement>('.ov-line[data-live]')].map((el) => {
    const tx = el.querySelector<HTMLElement>('.ov-tx')!;
    return {
      el,
      tx,
      tail: el.querySelector<HTMLElement>('.ov-tail')!,
      words: (tx.textContent ?? '').trim().split(/\s+/),
      from: Number(el.dataset.from),
      to: Number(el.dataset.to),
      shown: -1,
      fin: -1,
    };
  });
  const heroQuestion = ov.querySelector('.ov-qrow[data-for~="h1"] .ov-qt')?.textContent ?? '';

  const heroView = () => (p >= 1 ? 'h1' : 'h0');
  const viewNow = () => (active === 'h' ? heroView() : active);

  // ── Header timer: the opening plays it, then the scroll position sets it ──
  function renderTimer() {
    const t = active === 'h' && p < 1 ? p * HERO_SECONDS : scrollT;
    const s = mmss(t);
    if (timerEl && s !== timerShown) {
      timerShown = s;
      timerEl.textContent = s;
    }
  }

  function applyHero() {
    for (const l of lines) {
      const f = clamp((p - l.from) / (l.to - l.from));
      const n = l.words.length;
      const shown = Math.ceil(f * n);
      // The last few words are still "interim": dimmed and italic until the line settles.
      const fin = f >= 1 ? n : Math.max(0, shown - 3);
      if (shown === l.shown && fin === l.fin) continue;
      l.shown = shown;
      l.fin = fin;
      l.el.classList.toggle('is-on', shown > 0);
      l.tx.textContent = l.words.slice(0, fin).join(' ');
      l.tail.textContent = (fin > 0 && shown > fin ? ' ' : '') + l.words.slice(fin, shown).join(' ');
    }
    wave?.style.setProperty('--progress', p.toFixed(3));
    renderTimer();
    const v = viewNow();
    if (active === 'h' && ov.dataset.view !== v) {
      ov.dataset.view = v;
      if (v === 'h1') {
        if (interacted) say(`Question detected: ${heroQuestion}`);
        hint(HINT.hold);
      }
    }
  }

  // ── Answer ──
  const wordsOf = (mode: string) => [...ov.querySelectorAll<HTMLElement>(`.ov-ans[data-answer="${mode}"] .w`)];
  const labelOf = (mode: string) => modeBtns.find((b) => b.dataset.modeBtn === mode)?.querySelector('span')?.textContent ?? mode;

  function setModeButtons(mode: string | null, running: boolean) {
    for (const b of modeBtns) {
      const on = running && b.dataset.modeBtn === mode;
      b.classList.toggle('is-active', on);
      b.classList.toggle('is-run', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (assistMain) {
      assistMain.toggleAttribute('disabled', running);
      assistMain.setAttribute('aria-busy', String(running));
    }
  }

  function showAnswer(mode: string, total: number, first: number) {
    for (const w of wordsOf(mode)) w.classList.remove('off');
    ov.dataset.mode = mode;
    ov.dataset.ans = 'done';
    if (doneLabel) doneLabel.textContent = labelOf(mode);
    if (doneTiming) doneTiming.textContent = `${secs(total)} · first words ${secs(first)}`;
    setModeButtons(null, false);
    const text = ov.querySelector(`.ov-ans[data-answer="${mode}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
    say(`${labelOf(mode)} answer: ${text}`);
    hint(HINT.done);
  }

  function setAsk(open: boolean) {
    ov.dataset.ask = open ? 'on' : 'off';
    askBox?.querySelector('input')?.[open ? 'focus' : 'blur']();
    modeBtns.find((b) => b.dataset.modeBtn === 'AskQuestion')?.setAttribute('aria-pressed', String(open));
  }

  function start(mode: string) {
    if (active !== 'h') return; // the keys belong to the hero moment
    if (mode === 'AskQuestion') return setAsk(ov.dataset.ask !== 'on');
    if (run) return;
    setAsk(false);
    if (p < 1) {
      p = 1;
      applyHero();
    }
    for (const w of ov.querySelectorAll('.ov-ans .w')) w.classList.add('off');
    ov.dataset.mode = mode;
    const phases = mode === 'Assist' ? PHASES_ASSIST : PHASES_QUICK;
    if (reduce) {
      const total = phases[2] + wordsOf(mode).length * WORD_MS;
      return showAnswer(mode, total, phases[2]);
    }
    run = { mode, t: 0, words: wordsOf(mode), phases, shown: 0, phase: '', lastElapsed: -1 };
    if (progLabel) progLabel.textContent = labelOf(mode);
    ov.dataset.ans = 'sending';
    setModeButtons(mode, true);
    hint(HINT.run);
    kick();
  }

  function stepRun(dt: number) {
    if (!run) return;
    run.t += dt;
    const [a, b, c] = run.phases;
    const phase = run.t < a ? 'sending' : run.t < b ? 'waiting' : run.t < c ? 'thinking' : 'writing';
    if (phase !== run.phase) {
      run.phase = phase;
      ov.dataset.ans = phase;
      if (phaseEl) phaseEl.textContent = PHASE_TEXT[phase];
    }
    const tenth = Math.floor(run.t / 100);
    if (elapsedEl && tenth !== run.lastElapsed) {
      run.lastElapsed = tenth;
      elapsedEl.textContent = secs(run.t);
    }
    if (phase === 'writing') {
      const n = Math.min(run.words.length, Math.floor((run.t - c) / WORD_MS) + 1);
      if (n !== run.shown) {
        for (let i = run.shown; i < n; i++) run.words[i].classList.remove('off');
        run.shown = n;
        if (caret && run.words[n - 1]) run.words[n - 1].after(caret);
      }
      if (n >= run.words.length && run.t - c > run.words.length * WORD_MS + 250) {
        const total = run.t;
        const mode = run.mode;
        run = null;
        showAnswer(mode, total, c);
      }
    }
  }

  // ── The loop: the hero opening and a streaming answer ──
  const running = () => !paused && onScreen && !document.hidden;
  const busy = () => p < 1 || !!run;
  function frame(t: number) {
    raf = 0;
    const dt = Math.min(64, t - last);
    last = t;
    if (!running()) return;
    if (p < 1) {
      p = clamp(p + dt / HERO_MS);
      applyHero();
    }
    stepRun(dt);
    if (busy()) raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (raf || !running()) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  // ── Which moment shows (beats) ──
  let autoStealthTimer = 0;
  function setActive(next: string) {
    if (!wide.matches) next = 'h';
    if (next === active) return;
    active = next;
    stage.dataset.beat = next;
    ov.dataset.view = viewNow();
    // A beat's one visible change plays the first time it is shown, and never again.
    if (next !== 'h' && !reduce && !played.has(next)) {
      played.add(next);
      ov.dataset.play = [...played].join(' ');
    }
    const heroNow = next === 'h';
    for (const el of heroOnly) el?.toggleAttribute('inert', !heroNow);
    ov.tabIndex = heroNow ? 0 : -1;
    for (const b of beats) b.classList.toggle('is-active', b.dataset.beatId === next);
    const h = heroNow ? (p >= 1 ? HINT.hold : HINT.wait) : $(`[data-beat-id="${next}"]`)?.dataset.hint;
    if (h) hint(h);
    // The stealth beat switches Hide from screen share on once, so the change is seen.
    clearTimeout(autoStealthTimer);
    if (next === 'e') autoStealthTimer = window.setTimeout(autoStealth, 1000);
    renderTimer();
    kick();
  }

  // Scroll position -> moment, meeting time and call progress. Rects are measured once (on the first
  // scroll) and again only after a resize or a layout change; a scroll frame reads scrollY and nothing else.
  let spans: Span[] = [];
  let callTop = 0;
  let dirty = true;
  const cssLine = () => wide.matches && !reduce && CSS.supports('animation-timeline: view()') && CSS.supports('timeline-scope: --nx-beats');
  function measure() {
    const sy = window.scrollY;
    callTop = ($('#call')?.getBoundingClientRect().top ?? 0) + sy;
    spans = beats.map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.dataset.beatId!, top: r.top + sy, bottom: r.bottom + sy, t: Number(b.dataset.t) };
    });
    dirty = false;
  }
  function syncScroll() {
    if (!wide.matches) {
      setActive('h');
      return;
    }
    if (dirty) measure();
    if (!spans.length) return;
    const mid = window.scrollY + window.innerHeight / 2; // the middle of the screen, in page coordinates
    const here = spans.find((s) => mid >= s.top && mid < s.bottom) ?? (mid >= spans[spans.length - 1].bottom ? spans[spans.length - 1] : null);
    // Meeting time: HERO_SECONDS above the call, then straight lines between each beat's centre and its stamp.
    let t = HERO_SECONDS;
    let prevY = callTop;
    let prevT = HERO_SECONDS;
    for (const s of spans) {
      const y = (s.top + s.bottom) / 2;
      if (mid <= y) {
        t = mid <= prevY ? prevT : prevT + ((mid - prevY) / (y - prevY)) * (s.t - prevT);
        break;
      }
      prevY = y;
      prevT = s.t;
      t = s.t;
    }
    scrollT = t;
    if (callLine && !cssLine()) {
      const span = spans[spans.length - 1].bottom - spans[0].top;
      callLine.style.setProperty('--call-p', clamp((mid - spans[0].top) / span).toFixed(3));
    }
    setActive(here?.id ?? 'h');
    renderTimer();
  }
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      syncScroll();
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener(
    'resize',
    () => {
      dirty = true;
      onScroll();
    },
    { passive: true },
  );
  wide.addEventListener('change', () => {
    dirty = true;
    if (wide.matches) onScroll();
    else setActive('h');
  });
  // Headings and fonts can change the column's height without a scroll: measure again at the next one.
  if ('ResizeObserver' in window) new ResizeObserver(() => (dirty = true)).observe($('#call') ?? stage);

  // Run only while the demo is on screen.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        if (onScreen) kick();
      },
      { threshold: 0 },
    ).observe(pin);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) kick();
  });

  // ── Phones: each still plays its one change when it scrolls into view ──
  if (!reduce) {
    const frames = [...stage.querySelectorAll<HTMLElement>('.ov--still')];
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            e.target.classList.add('is-play');
            io.unobserve(e.target);
          }
        },
        { threshold: 0.4 },
      );
      frames.forEach((f) => io.observe(f));
    } else {
      frames.forEach((f) => f.classList.add('is-play'));
    }
  }

  // ── Stealth demo ──
  function setStealth(on: boolean) {
    stage.dataset.stealth = on ? 'on' : 'off';
    ov.dataset.stealth = on ? 'on' : 'off';
    if (toggle) toggle.setAttribute('aria-pressed', String(on));
    if (statusEl)
      statusEl.textContent = on
        ? 'On. The overlay stays on your screen and is left out of what they see.'
        : 'Off. The overlay is in the share, so they see it too.';
  }
  let autoDone = false;
  function autoStealth() {
    if (autoDone || stealthTouched) return;
    autoDone = true;
    setStealth(true);
  }
  toggle?.addEventListener('click', () => {
    stealthTouched = true;
    clearTimeout(autoStealthTimer);
    statusEl?.setAttribute('role', 'status'); // announce changes only once the visitor is the one changing it
    setStealth(toggle.getAttribute('aria-pressed') !== 'true');
  });
  // Phones show the two screens inside the beat: switch it on when they scroll into view.
  const beatPanes = $('.nx-panes--beat');
  if (beatPanes && !reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (!wide.matches && entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          autoStealthTimer = window.setTimeout(autoStealth, 1000);
        }
      },
      { threshold: 0.6 },
    );
    io.observe(beatPanes);
  }

  // ── Controls ──
  pauseBtn?.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.setAttribute('aria-label', paused ? 'Play the sample' : 'Pause the sample');
    stage.toggleAttribute('data-paused', paused);
    kick();
  });
  const touch = () => {
    interacted = true;
  };
  pin.addEventListener('pointerdown', touch, { capture: true, once: true });
  pin.addEventListener('keydown', touch, { capture: true, once: true });
  assistMain?.addEventListener('click', () => start('Assist'));
  $('[data-assist]', ov)?.addEventListener('click', () => start('Assist'));
  modeBtns.forEach((b) => b.addEventListener('click', () => start(b.dataset.modeBtn!)));
  ov.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (target.tagName === 'INPUT') {
      if (e.key === 'Escape') setAsk(false);
      e.stopPropagation();
      return;
    }
    const n = /^Digit([1-5])$/.exec(e.code);
    const mode = e.code === 'Space' ? 'Assist' : n ? MODES[Number(n[1])].mode : null;
    if (!mode) return;
    if (target.tagName === 'BUTTON' && e.code === 'Space') return; // a focused button handles its own Space
    e.preventDefault();
    start(mode);
  });

  // ── Boot ──
  ov.tabIndex = 0; // the keys only work with focus, so the sample is reachable by keyboard
  if (reduce) {
    setStealth(true); // the final state: on
    pauseBtn?.setAttribute('hidden', '');
    hint(HINT.hold);
    renderTimer();
    return;
  }
  setStealth(false); // switched on by the stealth beat
  // Rewind the hero to its first frame, then play it once the demo is on screen.
  for (const l of lines) {
    l.tx.textContent = '';
    l.tail.textContent = '';
  }
  for (const w of ov.querySelectorAll('.ov-ans .w')) w.classList.add('off');
  ov.dataset.ans = 'idle';
  ov.dataset.view = 'h0';
  wave?.style.setProperty('--progress', '0');
  renderTimer();
  stage.classList.add('is-ready');
  hint(HINT.wait);
  setTimeout(kick, 600);
}

const stage = document.querySelector<HTMLElement>('[data-stage]');
if (stage) init(stage);
