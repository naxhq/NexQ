/*
 * The sample call. One state machine, one requestAnimationFrame loop.
 *
 *  - Hero: the opening plays once (transcript words follow the release wave's playhead), then it HOLDS
 *    on the detected question. Assist (button, Space or 1-5 while the demo has focus) streams an answer.
 *  - Beats: an IntersectionObserver on the beat text sets which moment of the overlay shows
 *    (`data-view` on .ov); CSS does all the transitions.
 *  - The loop only runs while the demo is on screen, the tab is visible and nothing is paused.
 *
 * All text lives in the HTML (content.ts renders it), so this file only moves attributes and
 * reveals words. Without JavaScript, and under reduced motion, the HTML is already the final state.
 */

const HERO_MS = 11500;
const HERO_SECONDS = 38;
// Boundaries between sending, waiting, thinking and writing (ms).
const PHASES_ASSIST = [450, 1050, 1800];
const PHASES_QUICK = [300, 600, 900];
const WORD_MS = 70;
const MODES = ['Assist', 'WhatToSay', 'Shorten', 'FollowUp', 'Recap', 'AskQuestion'];
const PHASE_TEXT: Record<string, string> = {
  sending: 'Sending…',
  waiting: 'Waiting for the first words…',
  thinking: 'Thinking…',
  writing: 'Writing…',
};
const HINT = {
  wait: 'Listening to the call',
  hold: 'Question caught. Click Assist, or press Space in the overlay.',
  run: 'Answering',
  done: 'Try Say, Short, F/U or Recap, or keys 1 to 4 in the overlay.',
};

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
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
  const modeBtns = [...ov.querySelectorAll<HTMLButtonElement>('[data-mode-btn]')];
  const timeOf = (el: Element | null, d = 0) => Number((el as HTMLElement | null)?.dataset.t ?? d);

  // OS-aware download label (the link is the same for both: the latest release).
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad|iPod/.test(ua) && navigator.maxTouchPoints < 2) {
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
  let timerCur = reduce ? HERO_SECONDS : 0;
  let timerShown = '';
  let stealthTouched = false;

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
    const v = viewNow();
    if (active === 'h' && ov.dataset.view !== v) {
      ov.dataset.view = v;
      if (v === 'h1') {
        say(`Question detected: ${heroQuestion}`);
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

  // ── Timer in the overlay header ──
  const timerTarget = () => (active === 'h' ? p * HERO_SECONDS : timeOf($(`[data-beat-id="${active}"]`)));
  function stepTimer(dt: number) {
    const target = timerTarget();
    if (reduce || Math.abs(target - timerCur) < 0.4) timerCur = target;
    else timerCur += (target - timerCur) * (1 - Math.exp(-dt / 260));
    const s = mmss(timerCur);
    if (timerEl && s !== timerShown) {
      timerShown = s;
      timerEl.textContent = s;
    }
  }

  // ── The loop ──
  const running = () => !paused && onScreen && !document.hidden;
  const busy = () => p < 1 || !!run || Math.abs(timerTarget() - timerCur) >= 0.4;
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
    stepTimer(dt);
    if (busy()) raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (raf || !running()) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  // ── Which moment shows (beats) ──
  function setActive(next: string) {
    if (!wide.matches) next = 'h';
    if (next === active) return;
    active = next;
    stage.dataset.beat = next;
    ov!.dataset.view = viewNow();
    const h = next === 'h' ? (p >= 1 ? HINT.hold : HINT.wait) : $(`[data-beat-id="${next}"]`)?.dataset.hint;
    if (h) hint(h);
    kick();
  }

  const beats = [...stage.querySelectorAll<HTMLElement>('[data-beat-id]')];
  let current = 'h';
  const inBand = new Set<string>();
  const hero = $('#hero');
  if ('IntersectionObserver' in window) {
    const bandIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target === hero ? 'h' : (e.target as HTMLElement).dataset.beatId!;
          if (e.isIntersecting) inBand.add(id);
          else inBand.delete(id);
          (e.target as HTMLElement).classList.toggle('is-active', e.isIntersecting);
        }
        const first = ['h', 'a', 'b', 'c', 'd', 'e'].find((k) => inBand.has(k));
        if (first) current = first;
        setActive(current);
        // The stealth beat switches Hide from screen share on once, so the change is seen.
        if (current === 'e' && !stealthTouched) {
          stealthTouched = true;
          setTimeout(() => setStealth(true), 1000);
        }
      },
      { rootMargin: '-42% 0px -42% 0px' },
    );
    if (hero) bandIO.observe(hero);
    beats.forEach((b) => bandIO.observe(b));
    // Run only while the demo is on screen.
    new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        if (onScreen) kick();
      },
      { threshold: 0 },
    ).observe(pin);
  }
  wide.addEventListener('change', () => setActive(current));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) kick();
  });

  // ── Stealth demo ──
  function setStealth(on: boolean) {
    stage.dataset.stealth = on ? 'on' : 'off';
    ov!.dataset.stealth = on ? 'on' : 'off';
    if (toggle) toggle.setAttribute('aria-pressed', String(on));
    if (statusEl)
      statusEl.textContent = on
        ? 'On. The overlay stays on your screen and is left out of what they see.'
        : 'Off. The overlay is in the share, so they see it too.';
  }
  toggle?.addEventListener('click', () => {
    stealthTouched = true;
    setStealth(toggle.getAttribute('aria-pressed') !== 'true');
  });
  setStealth(false);

  // ── Controls ──
  pauseBtn?.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.setAttribute('aria-label', paused ? 'Play the sample' : 'Pause the sample');
    stage.toggleAttribute('data-paused', paused);
    kick();
  });
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
    const mode = e.code === 'Space' ? 'Assist' : n ? MODES[Number(n[1])] : null;
    if (!mode) return;
    if (target.tagName === 'BUTTON' && e.code === 'Space') return; // a focused button handles its own Space
    e.preventDefault();
    start(mode);
  });

  // ── Boot ──
  setStealth(false);
  if (reduce) {
    pauseBtn?.setAttribute('hidden', '');
    hint(HINT.hold);
    stepTimer(0);
    return;
  }
  // Rewind the hero to its first frame, then play it once the demo is on screen.
  for (const l of lines) {
    l.tx.textContent = '';
    l.tail.textContent = '';
  }
  for (const w of ov.querySelectorAll('.ov-ans .w')) w.classList.add('off');
  ov.dataset.ans = 'idle';
  ov.dataset.view = 'h0';
  wave?.style.setProperty('--progress', '0');
  if (timerEl) timerEl.textContent = mmss(0);
  stage.classList.add('is-ready');
  hint(HINT.wait);
  setTimeout(kick, 600);
}

const stage = document.querySelector<HTMLElement>('[data-stage]');
if (stage) init(stage);
