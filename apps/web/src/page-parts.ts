import { loadWholeCatalog } from "./i18n.ts";
import { partAt, stylesMeta } from "./lean-pages.ts";
import type { Part } from "./lean-pages.ts";

// A lean page (lean-pages.ts) starts with its own part of the stylesheet
// and of its language's catalog. Any other page needs the whole of both
// before it shows: the root route loads them as it goes there (and only
// the first time), whether that is where the tab opened or where a lean
// page leads, as the setup does into the app.

/**
 * Links the stylesheet a build's index.html names in the meta tag `meta`
 * (lean-parts.ts), and waits for it. The preload script may have linked
 * it already (locale-preload.ts): a link of this one's own still waits
 * for it, and the browser fetches the file once.
 */
const loadStyles = async (meta: string): Promise<void> => {
  const href = document
    .querySelector<HTMLMetaElement>(`meta[name="${meta}"]`)
    ?.getAttribute("content");
  if (href === null || href === undefined) {
    // The dev server and tests: every style is in already.
    return;
  }
  const loaded = [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  ].some((link) => link.getAttribute("href") === href && link.sheet !== null);
  if (loaded) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.crossOrigin = "";
  link.href = href;
  // oxlint-disable-next-line promise/avoid-new -- a link's load has no promise form
  await new Promise<void>((resolve, reject) => {
    link.addEventListener("load", () => {
      resolve();
    });
    link.addEventListener("error", () => {
      link.remove();
      reject(new Error(`The stylesheet ${href} didn't load`));
    });
    document.head.append(link);
  });
};

/** The part the tab started with: the page's own, or the whole. */
let started: Part = "whole";

/**
 * Before the first page shows: a lean page's own stylesheet. Any other
 * page's comes with the whole, as the root route loads.
 */
export const loadStartStyles = async (part: Part): Promise<void> => {
  started = part;
  if (part !== "whole") {
    await loadStyles(stylesMeta(part));
  }
};

let loading: Promise<void> | undefined;

/** Loads the whole stylesheet and catalog, once; again after a failure. */
const loadWhole = async (): Promise<void> => {
  await Promise.all([loadStyles(stylesMeta("whole")), loadWholeCatalog()]);
};

const loadWholeApp = async (): Promise<void> => {
  loading ??= loadWhole();
  try {
    await loading;
  } catch (error) {
    // Asked again, it tries again.
    loading = undefined;
    throw error;
  }
};

/**
 * What the page at `pathname` needs before it shows: nothing more on the
 * lean page the tab started with, the whole anywhere else.
 */
export const loadPartsFor = async (pathname: string): Promise<void> => {
  if (started === "whole" || partAt(pathname) !== started) {
    await loadWholeApp();
  }
};
