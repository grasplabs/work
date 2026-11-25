import { loadWholeCatalog } from "./i18n.ts";
import { leanStylesMeta, wholeStylesMeta } from "./lean-pages.ts";

// The lean pages (lean-pages.ts) start with a lean copy of the stylesheet
// and a lean part of their language's catalog. Any other page needs the
// whole of both before it shows: the root route loads them as it goes
// there (and only the first time), whether that is where the tab opened
// or where a lean page leads, as the setup does into the app.

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

/** The lean pages' stylesheet, before one of them first shows. */
export const loadLeanStyles = async (): Promise<void> => {
  await loadStyles(leanStylesMeta);
};

let loading: Promise<void> | undefined;

/** Loads the whole stylesheet and catalog, once; again after a failure. */
const loadWhole = async (): Promise<void> => {
  await Promise.all([loadStyles(wholeStylesMeta), loadWholeCatalog()]);
};

export const loadWholeApp = async (): Promise<void> => {
  loading ??= loadWhole();
  try {
    await loading;
  } catch (error) {
    // Asked again, it tries again.
    loading = undefined;
    throw error;
  }
};
