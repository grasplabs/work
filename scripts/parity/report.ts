/**
 * The side-by-side report `vp run parity` writes (run.ts): for each page,
 * at each width and in each theme, the prototype's screenshot next to
 * Grasp OS's, or why one is missing. Plain HTML with no script, so a PR
 * can attach it and anyone can open it straight from disk.
 */
import type { ParityTheme, ParityWidth } from "./routes.ts";

/** One app's screenshot of one page: where it is, or why there is none. */
export type Shot = { readonly file: string } | { readonly missing: string };

/** One page at one width in one theme, in both apps. */
export interface ShotPair {
  readonly width: ParityWidth;
  readonly theme: ParityTheme;
  readonly prototype: Shot;
  readonly grasp: Shot;
}

/** One page of the report: its name, each app's path, and its pairs. */
export interface ReportPage {
  readonly name: string;
  readonly prototypePath: string;
  readonly graspPath: string;
  readonly pairs: readonly ShotPair[];
}

const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const unsafe = /[&<>"']/gu;

/** `text` as HTML text or an attribute's value. */
export const escapeHtml = (text: string): string =>
  text.replaceAll(unsafe, (character) => escapes[character] ?? character);

/** A relative path as a URL path, each segment encoded, `/` kept. */
const hrefOf = (file: string): string =>
  file.split("/").map(encodeURIComponent).join("/");

const shotHtml = (label: string, shot: Shot): string => {
  const caption = `<figcaption>${escapeHtml(label)}</figcaption>`;
  if ("missing" in shot) {
    return `<figure class="missing">${caption}<p>${escapeHtml(shot.missing)}</p></figure>`;
  }
  const href = hrefOf(shot.file);
  return `<figure>${caption}<a href="${href}"><img alt="${escapeHtml(label)}" loading="lazy" src="${href}"></a></figure>`;
};

const pairHtml = (pair: ShotPair): string =>
  [
    `<h3>${pair.width} px · ${pair.theme}</h3>`,
    `<div class="pair w${pair.width}">`,
    shotHtml("Prototype", pair.prototype),
    shotHtml("Grasp OS", pair.grasp),
    "</div>",
  ].join("");

const pageHtml = (page: ReportPage): string =>
  [
    `<section id="${escapeHtml(page.name)}">`,
    `<h2>${escapeHtml(page.name)}</h2>`,
    `<p class="paths">Prototype <code>${escapeHtml(page.prototypePath)}</code> · Grasp OS <code>${escapeHtml(page.graspPath)}</code></p>`,
    ...page.pairs.map(pairHtml),
    "</section>",
  ].join("");

const style = `
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1800px;padding:24px;color:#18181b;background:#fafafa}
nav{display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:24px}
section{border-top:1px solid #e4e4e7;padding-top:16px;margin-top:24px}
h2{margin:0}h3{font-weight:500;color:#52525b;margin:16px 0 8px}
.paths{color:#71717a;margin:4px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.pair.w390{grid-template-columns:repeat(2,minmax(0,390px))}
figure{margin:0}figcaption{font-weight:500;margin-bottom:4px}
img{width:100%;height:auto;border:1px solid #e4e4e7;display:block}
.missing p{border:1px dashed #a1a1aa;padding:24px;color:#71717a;margin:0}
`;

/**
 * The report for `pages`, compared against the prototype at `commit` and
 * taken at `takenAt` (an ISO time): one HTML document, its screenshots
 * referenced by their paths relative to it.
 */
export const reportHtml = (
  pages: readonly ReportPage[],
  { commit, takenAt }: { commit: string; takenAt: string }
): string =>
  [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Prototype parity</title>",
    `<style>${style}</style></head><body>`,
    "<h1>Prototype parity</h1>",
    `<p>The prototype at <code>${escapeHtml(commit)}</code> next to Grasp OS, taken ${escapeHtml(takenAt)}.</p>`,
    `<nav>${pages
      .map(
        ({ name }) =>
          `<a href="#${encodeURIComponent(name)}">${escapeHtml(name)}</a>`
      )
      .join("")}</nav>`,
    ...pages.map(pageHtml),
    "</body></html>",
    "",
  ].join("\n");
