/**
 * Whether the CSS esbuild wrote would load anything from outside the
 * artifact. Pure checks on text, run in the package builder's isolate
 * after esbuild, which doesn't resolve every URL a stylesheet can name
 * (`image-set()` strings never reach a plugin). Only positions a browser
 * fetches count (css.ts): text that merely looks like a URL is never one.
 */
import { cssFetches } from "./css.ts";

/** Data URLs that stay inline as they are: images and fonts, never SVG. */
export const inertDataUrl =
  /^data:(?:image\/(?:png|jpeg|gif|webp|avif)|font\/[a-z0-9]+|application\/font-woff2?)[;,]/iu;

/** `text` with each match of `pattern` replaced by what `replace` makes of it. */
export const replaced = (
  text: string,
  pattern: RegExp,
  replace: (groups: Record<string, string | undefined>, whole: string) => string
): string => {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    out += text.slice(at, match.index) + replace(match.groups ?? {}, match[0]);
    at = match.index + match[0].length;
  }
  return out + text.slice(at);
};

/** A URL that reaches outside the artifact: a scheme, or `//`. */
const outside = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/** Whether a URL stays within the artifact without being a file of it. */
const inline = (url: string): boolean =>
  url.startsWith("#") || inertDataUrl.test(url);

/**
 * Every URL a stylesheet esbuild wrote would fetch from outside the
 * artifact (`cssFetches`): a scheme or `//`, other than inline image and
 * font data URLs. Up to `limit`.
 */
export const remoteInCss = (css: string, limit = 50): string[] =>
  [
    ...new Set(
      cssFetches(css)
        .map(({ url }) => url)
        .filter((url) => outside.test(url) && !inline(url))
        .map((url) => url.slice(0, 120))
    ),
  ].slice(0, limit);

/**
 * Local files a stylesheet names where esbuild doesn't resolve them:
 * strings in image functions (`image-set("./a.png" 1x)`) and `src()`.
 * They would name paths the artifact doesn't have. Up to `limit`.
 */
export const unbundledInCss = (css: string, limit = 50): string[] =>
  [
    ...new Set(
      cssFetches(css)
        .filter(
          ({ url, bundled }) => !(bundled || outside.test(url) || inline(url))
        )
        .map(({ url }) => url.slice(0, 120))
    ),
  ].slice(0, limit);
