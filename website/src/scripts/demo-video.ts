// The demo video (Demo.astro): click to play. Nothing is fetched until the visitor clicks.
// The files have no audio track (checked with ffprobe: one video stream each), so the player
// is muted and says so, rather than offering a volume control that does nothing.
const frame = document.querySelector<HTMLElement>('[data-demo-video]');
frame?.querySelector('button')?.addEventListener('click', () => {
  const v = document.createElement('video');
  v.controls = true;
  v.muted = true;
  v.autoplay = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.poster = frame.dataset.poster!;
  v.setAttribute('aria-label', 'NexQ demo mode, a scripted conversation. No sound.');
  for (const [src, type] of [[frame.dataset.webm!, 'video/webm'], [frame.dataset.mp4!, 'video/mp4']]) {
    const s = document.createElement('source');
    s.src = src;
    s.type = type;
    v.append(s);
  }
  frame.replaceChildren(v);
  v.focus();
});

export {};
