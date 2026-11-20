import { useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { open } from "@tauri-apps/plugin-shell";
import { SourcesModal } from "../sources/SourcesModal";

/** The address of a link the user may be sent to, or `null` for anything else. */
function webAddress(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

/**
 * A link in an answer. The link text can say anything, so a click never goes
 * anywhere by itself: it shows the real address and opens the system browser
 * only when the user confirms. The window itself never navigates. Anything that
 * is not an http(s) address shows as plain text.
 */
function AnswerLink({ href, children }: { href?: string; children?: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const address = webAddress(href);
  if (!address) return <span>{children}</span>;
  const hold = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setAsking(true);
  };
  return (
    <>
      <a href={address} onClick={hold} onAuxClick={hold} rel="noreferrer noopener" className="underline underline-offset-2">
        {children}
      </a>
      {asking && (
        <SourcesModal title="Open this link in your browser?" onClose={() => setAsking(false)}>
          <p className="break-all rounded-lg border border-border/40 bg-secondary/30 px-3 py-2 text-xs text-foreground">{address}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAsking(false)}
              className="cursor-pointer rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                void open(address);
              }}
              className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Open link
            </button>
          </div>
        </SourcesModal>
      )}
    </>
  );
}

/**
 * An AI answer is built from notes, mail and tool results, which can carry an
 * image link. Opening one fetches it, which can leak what the answer was about
 * to whoever owns that address. So an image never loads in an answer: it shows
 * as its description, as plain text. Links are held back the same way
 * ([AnswerLink]).
 */
export const noRemoteImages: Components = {
  a: ({ href, children }) => <AnswerLink href={href}>{children}</AnswerLink>,
  img: ({ alt }) => <span className="text-muted-foreground">{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
};

/** `components` with answer images blocked, for every renderer of AI text. */
export function withoutImages(components?: Components): Components {
  return { ...components, ...noRemoteImages };
}
