import type { ReactNode } from "react";

/**
 * The corner where the launcher's one-time notices (settings restored, damaged meetings file) stack:
 * one fixed column above the footer, oldest at the bottom so the newest is on top, each notice closable,
 * scrolling when there are more than fit. Its width gives way to the star card and the update toast on
 * the right (392 px and 300 px) so the three never cover each other, down to the 700 px minimum window.
 */
export function NoticeStack({ children }: { children: ReactNode }) {
  return (
    <div
      className="pointer-events-none fixed bottom-14 left-4 z-50 flex max-h-[calc(100vh-7rem)] w-[clamp(15rem,calc(100vw-28.5rem),21.25rem)] flex-col-reverse gap-2 overflow-y-auto [&>*]:pointer-events-auto"
      aria-label="Notices"
    >
      {children}
    </div>
  );
}
