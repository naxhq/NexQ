// Download section: mark the visitor's platform, and play the installer wave once when it scrolls
// into view. Nothing here moves layout: the "Your system" label slot is always reserved.
import { detectOS } from './os';

const root = document.querySelector<HTMLElement>('[data-dl]');

if (root) {
  const os = detectOS();

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
