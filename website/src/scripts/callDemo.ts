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
import { HERO_SECONDS, MODES, mmss, formatDuration } from '../components/overlay/content';
import { detectOS } from './os';

const HERO_MS = 8000;
// The pace of an answer comes from the numbers content.ts writes on it (data-send, data-first, data-think, data-total, in ms),
// as ResponseProgress.tsx walks them: sending until `send`, waiting until `first` (or until the thinking starts), then,
// on the Deep tier only (Recap), thinking until `first`; writing runs from `first` and the stream ends at `total`.
// Fast tier answers (Haiku, thinking off) never think (docs/user-guide/claude-subscription.md L22-26).
const PHASE_TEXT: Record<string, string> = {
  sending: 'Sending…',
  waiting: 'Waiting for the first words…',
  thinking: 'Thinking…',
  writing: 'Writing…',
};
// A touch screen has no hover and no Space key: it taps.
const TOUCH = matchMedia('(hover: none)').matches;
const HINT = {
  wait: 'Listening to the call',
  hold: TOUCH ? 'Question caught. Tap Assist.' : 'Question caught. Click Assist or press Space.',
  run: 'Answering',
  done: TOUCH ? 'Try another action in the overlay.' : 'Try another action, or keys 1 to 5 in the overlay.',
};

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

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
  send: number;
  first: number;
  think: number;
  total: number;
  shown: number;
  phase: string;
  lastElapsed: number;
}
interface Span {
  id: string;
  top: number;
  bottom: number;
  /** Meeting time of the beat (seconds), and the earliest the timer may read in it: just after its last line. */
  t: number;
  t0: number;
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
  const detEl = $('[data-det]', ov);
  const langEn = $('.ov-lg .l-en', ov);
  const langEs = $('.ov-lg .l-es', ov);
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
      // aria-disabled, not disabled: a disabled button drops keyboard focus to the page while the answer streams.
      assistMain.setAttribute('aria-disabled', String(running));
      assistMain.setAttribute('aria-busy', String(running));
    }
  }

  function showAnswer(mode: string) {
    for (const w of wordsOf(mode)) w.classList.remove('off');
    ov.dataset.mode = mode;
    ov.dataset.ans = 'done';
    if (doneLabel) doneLabel.textContent = labelOf(mode);
    // One timing per answer, written in content.ts and printed everywhere (not the time the animation took).
    const own = ov.querySelector<HTMLElement>(`.ov-ans[data-answer="${mode}"]`)?.dataset.timing;
    if (doneTiming && own) doneTiming.textContent = own;
    setModeButtons(null, false);
    const text = ov.querySelector(`.ov-ans[data-answer="${mode}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
    say(`${labelOf(mode)} answer: ${text}`);
    if (active === 'h') hint(HINT.done);
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
    const own = ov.querySelector<HTMLElement>(`.ov-ans[data-answer="${mode}"]`)?.dataset;
    const think = Number(own?.think ?? 0);
    if (detEl) detEl.textContent = (think ? detEl.dataset.sentDeep : detEl.dataset.sentFast) ?? '';
    if (reduce) return showAnswer(mode);
    const total = Number(own?.total);
    const first = Number(own?.first);
    if (!(total > first && first > 0)) return showAnswer(mode); // no timing on the answer: show it whole
    run = { mode, t: 0, words: wordsOf(mode), send: Number(own?.send ?? 0), first, think, total, shown: 0, phase: '', lastElapsed: -1 };
    if (progLabel) progLabel.textContent = labelOf(mode);
    ov.dataset.ans = 'sending';
    setModeButtons(mode, true);
    hint(HINT.run);
    kick();
  }

  function stepRun(dt: number) {
    if (!run) return;
    run.t = Math.min(run.total, run.t + dt);
    const { t, send, first, think, total } = run;
    const phase = t < send ? 'sending' : think && t >= first - think && t < first ? 'thinking' : t < first ? 'waiting' : 'writing';
    if (phase !== run.phase) {
      run.phase = phase;
      ov.dataset.ans = phase;
      if (phaseEl) phaseEl.textContent = PHASE_TEXT[phase];
    }
    // The live counter and the label the answer ends on are the same two numbers: the counter stops at `total`.
    const tenth = Math.floor(t / 100);
    if (elapsedEl && tenth !== run.lastElapsed) {
      run.lastElapsed = tenth;
      elapsedEl.textContent = formatDuration(t);
    }
    if (phase === 'writing') {
      // The first word lands at `first`, the last at `total`.
      const n = Math.min(run.words.length, Math.ceil(((t - first) / (total - first)) * run.words.length));
      if (n !== run.shown) {
        for (let i = run.shown; i < n; i++) run.words[i].classList.remove('off');
        run.shown = n;
        if (caret && run.words[n - 1]) run.words[n - 1].after(caret);
      }
      if (t >= total) {
        if (elapsedEl) elapsedEl.textContent = formatDuration(total);
        const mode = run.mode;
        run = null;
        showAnswer(mode);
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
  // The overlay's keyboard line is only true in the hero moment: in the beats the keys are inert, so it is not read.
  const keysDesc = $('#nx-ov-keys', ov);
  const describeKeys = (on: boolean) => {
    if (!keysDesc) return;
    if (on) ov.setAttribute('aria-describedby', keysDesc.id);
    else ov.removeAttribute('aria-describedby');
  };
  let autoStealthTimer = 0;
  function setActive(next: string) {
    if (!wide.matches) next = 'h';
    if (next === active) return;
    // Leaving the hero before its opening has played out: finish it, so no half-played wave or half-written
    // transcript is left behind under the later beats.
    if (active === 'h' && p < 1) {
      p = 1;
      applyHero();
    }
    active = next;
    stage.dataset.beat = next;
    ov.dataset.view = viewNow();
    syncLang();
    // A beat's one visible change plays the first time it is shown, and never again.
    if (next !== 'h' && !reduce && !played.has(next)) {
      played.add(next);
      ov.dataset.play = [...played].join(' ');
    }
    const heroNow = next === 'h';
    for (const el of heroOnly) el?.toggleAttribute('inert', !heroNow);
    ov.tabIndex = heroNow ? 0 : -1;
    describeKeys(heroNow);
    for (const b of beats) b.classList.toggle('is-active', b.dataset.beatId === next);
    const h = heroNow ? (p >= 1 ? HINT.hold : HINT.wait) : $(`[data-beat-id="${next}"]`)?.dataset.hint;
    if (h) hint(h);
    // The stealth beat switches Hide from screen share on once, so the change is seen.
    clearTimeout(autoStealthTimer);
    if (next === 'e') autoStealthTimer = window.setTimeout(autoStealth, 1000);
    renderTimer();
    kick();
  }

  // The other side's chip holds both language codes and swaps them with CSS: only the one on show is read aloud.
  function syncLang() {
    const es = ov.dataset.view === 'a';
    langEn?.setAttribute('aria-hidden', String(es));
    langEs?.setAttribute('aria-hidden', String(!es));
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
      const t = Number(b.dataset.t);
      return { id: b.dataset.beatId!, top: r.top + sy, bottom: r.bottom + sy, t, t0: Number(b.dataset.t0 ?? t) };
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
    // Never read earlier than the last line on show: the clock may not run behind the transcript.
    if (here) t = Math.max(t, here.t0);
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
    // A constant name with aria-pressed (pressed = paused), so the label and the state never disagree.
    pauseBtn.setAttribute('aria-pressed', String(paused));
    stage.toggleAttribute('data-paused', paused);
    kick();
  });
  const touch = () => {
    interacted = true;
  };
  pin.addEventListener('pointerdown', touch, { capture: true, once: true });
  pin.addEventListener('keydown', touch, { capture: true, once: true });
  assistMain?.addEventListener('click', () => {
    if (assistMain.getAttribute('aria-disabled') === 'true') return;
    start('Assist');
  });
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
  // A visitor who arrives part-way down (a link to #knows or #stealth, a reload, or a restored scroll position)
  // sees the beat that is on screen, not the hero. The scroll position can settle after this script runs
  // (fonts, scroll restoration), so it is read once now and once more when the page has loaded.
  // Reading scrollY or a rect while the page has not been laid out yet forces the whole page's layout inside this
  // script's task (a ~230 ms long task on a throttled phone). So only a link with a hash syncs at once (it needs
  // the layout anyway); a restored scroll position is read after the first frame, when the layout is clean.
  const syncOnArrival = () => {
    if (location.hash || window.scrollY > 0) syncScroll();
  };
  const syncAfterPaint = () => requestAnimationFrame(() => setTimeout(syncOnArrival, 0));
  const syncAtBoot = () => (location.hash ? syncOnArrival() : syncAfterPaint());
  window.addEventListener('load', syncAfterPaint, { once: true });
  ov.tabIndex = 0; // the keys only work with focus, so the sample is reachable by keyboard
  describeKeys(true);
  if (reduce) {
    setStealth(true); // the final state: on
    pauseBtn?.setAttribute('hidden', '');
    hint(HINT.hold);
    renderTimer();
    syncLang();
    syncAtBoot();
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
  syncLang();
  syncAtBoot();
  setTimeout(kick, 600);
}

const stage = document.querySelector<HTMLElement>('[data-stage]');
if (stage) init(stage);
