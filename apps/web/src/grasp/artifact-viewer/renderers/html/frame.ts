// The document a sandboxed frame shows: the page's own HTML, with a few lines put first in its
// head. They come before anything of the page's, so the page's own styles always win, and the
// policy they set can only be tightened by the page, never loosened.

/** What the frame may load. Nothing over the network but pictures, fonts and styles; no forms. */
export const policy = (scripts: boolean) =>
  [
    "default-src 'none'",
    "img-src https: data:",
    "media-src https: data:",
    "font-src https: data:",
    "style-src 'unsafe-inline' https:",
    // Scripts, when the caller allows them: the page's own, and libraries from https (a chart
    // library from a CDN, as agents often use). Never fetch, XHR or WebSocket: connect-src is none.
    scripts ? "script-src 'unsafe-inline' https:" : "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

/**
 * Whether the page sets its own colours: a `color-scheme` anywhere, or a colour or a background
 * on `html`, `body` or `:root` (in a style sheet, a `style` attribute, `text=` or `bgcolor=`). A
 * page that sets only its words' colour chose them for a light ground, so it keeps one: it is shown
 * as it draws itself. Otherwise it gets the viewer's ground and words, light or dark.
 */
export const ownsColours = (source: string) =>
  /color-scheme/iu.test(source) ||
  /(?:^|[\s,}>])(?:html|body|:root)\b[^{}<]*\{(?:[^}]*[\s;])?(?:color|background(?:-color)?)\s*:/iu.test(
    source
  ) ||
  /<(?:html|body)\b[^>]*\b(?:bgcolor\s*=|text\s*=|style\s*=\s*["'](?:[^"']*[\s;])?(?:color|background(?:-color)?)\s*:)/iu.test(
    source
  );

/** The message the measuring script sends: the page's height, in its own CSS pixels. */
export const HEIGHT = "artifactViewerHeight";

// Posts the page's height to the viewer whenever it changes. Only when scripts may run at all.
const MEASURE = `<script>(() => {
  const post = () => parent.postMessage({ ${HEIGHT}: Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body ? document.body.scrollHeight : 0)) }, "*");
  const watch = new ResizeObserver(post);
  watch.observe(document.documentElement);
  addEventListener("DOMContentLoaded", () => { watch.observe(document.body); post(); });
  addEventListener("load", post);
})();</script>`;

export interface Ground {
  /** The viewer's page and words, as the viewer draws them now, and whether that is light or dark. */
  background: string;
  color: string;
  scheme: "light" | "dark";
}

/** The page's HTML, ready for `srcdoc`. */
export const framed = (
  source: string,
  { scripts, ground }: { scripts: boolean; ground: Ground | null }
) => {
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${policy(scripts)}">`,
    '<meta name="referrer" content="no-referrer">',
    // Links open in a new tab, never in the frame or over the viewer.
    '<base target="_blank">',
    // A page with no colours of its own takes the viewer's, light or dark. `:where` weighs nothing,
    // so any rule of the page's wins.
    ground && !ownsColours(source)
      ? `<style>:where(html){color-scheme:${ground.scheme};background-color:${ground.background};color:${ground.color};font-family:system-ui,sans-serif}</style>`
      : "",
    scripts ? MEASURE : "",
  ].join("");
  // Before anything of the page's, so nothing in it (a comment, a textarea, a style) can swallow
  // these lines as its text. Only a doctype at the very start goes first, read as a browser reads
  // it: up to its first ">". Anything else follows a doctype of ours, in standards mode.
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/iu.exec(source)?.[0];
  return doctype !== undefined && doctype !== ""
    ? doctype + head + source.slice(doctype.length)
    : `<!doctype html>${head}${source}`;
};
