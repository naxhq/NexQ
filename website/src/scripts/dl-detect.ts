// Download section: mark the visitor's platform, and play the installer wave once when it scrolls
// into view. Nothing here moves layout: the "Your system" label slot is always reserved.

const root = document.querySelector<HTMLElement>('[data-dl]');

if (root) {
  const ua = navigator.userAgent;
  // Phones and tablets cannot run either build, so they get no highlight.
  const mobile = /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os = mobile ? '' : /Windows|Win32|Win64/i.test(ua + navigator.platform) ? 'windows' : /Macintosh|MacIntel|Mac OS X/i.test(ua + navigator.platform) ? 'mac' : '';

  if (os) {
    root.dataset.os = os;
    // The detected platform gets the blue button, the other one goes quiet.
    root.querySelectorAll<HTMLElement>('[data-dl-btn]').forEach((b) => {
      const on = b.dataset.dlBtn === os;
      b.classList.toggle('btn-primary', on);
      b.classList.toggle('btn-ghost', !on);
    });
  }

  const wave = root.querySelector<HTMLElement>('[data-dl-wave]');
  if (wave) {
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            wave.classList.add('is-in');
            io.disconnect();
          }
        },
        { threshold: 0.6 },
      );
      io.observe(wave);
    } else {
      wave.classList.add('is-in');
    }
  }
}

export {};
