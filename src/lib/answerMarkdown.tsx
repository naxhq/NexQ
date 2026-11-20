import type { Components } from "react-markdown";

/**
 * An AI answer is built from notes, mail and tool results, which can carry an
 * image link. Opening one fetches it, which can leak what the answer was about
 * to whoever owns that address. So an image never loads in an answer: it shows
 * as its description, as plain text.
 */
export const noRemoteImages: Components = {
  img: ({ alt }) => <span className="text-muted-foreground">{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
};

/** `components` with answer images blocked, for every renderer of AI text. */
export function withoutImages(components?: Components): Components {
  return { ...components, ...noRemoteImages };
}
