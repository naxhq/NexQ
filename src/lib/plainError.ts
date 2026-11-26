// What a person reads when something fails: the backend's own sentence stays, a JavaScript
// error ("Cannot read properties of null") never reaches the screen.

const JS_ERRORS = ["TypeError", "ReferenceError", "RangeError", "SyntaxError", "EvalError", "URIError"];
const JS_TEXT = /cannot read propert|is not defined|is not a function|is not iterable|undefined \(reading|null \(reading|unexpected token|unexpected end of json|is not valid json|maximum call stack/i;

export const GENERIC_ERROR = "Something went wrong. Try again.";

/** The sentence to show for a failure; `fallback` replaces a JS error's own text. */
export function plainError(e: unknown, fallback: string = GENERIC_ERROR): string {
  if (typeof e === "string") return e && !JS_TEXT.test(e) ? e : fallback;
  if (e instanceof Error) {
    if (JS_ERRORS.includes(e.name) || e instanceof TypeError || e instanceof ReferenceError || JS_TEXT.test(e.message)) return fallback;
    return e.message || fallback;
  }
  return fallback;
}

/** Same, with the generic sentence: the shape the stores' `messageOf` helpers had. */
export const messageOf = (e: unknown): string => plainError(e);
