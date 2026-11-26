/**
 * The meeting window is transparent. A CSS animation that never ends keeps that window
 * compositing on every display frame: one 8 px pulsing dot cost 15 to 20% of a core in the
 * real app (and the same in the previous release). Inside the meeting window a pulse or ping
 * draws attention a few times and then rests; the state it marks stays visible.
 */
export const OVERLAY_MOTION_CSS = `.overlay-bg .animate-pulse { animation-iteration-count: 3; }
.overlay-bg .animate-ping { animation-iteration-count: 3; }`;
