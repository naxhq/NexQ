import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** `lazy` for a module that has a named export (the app does not use default exports). */
export function lazyNamed<M extends Record<string, unknown>, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K] extends ComponentType<infer P> ? ComponentType<P> : never> {
  return lazy(async () => ({ default: (await load())[name] as never }));
}
