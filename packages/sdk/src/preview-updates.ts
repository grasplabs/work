/**
 * How a chat's preview's frame takes its draft's updates:
 * the page hands it each version of the pages over the frame's own
 * bridge, as the address of their route tree's module (`PreviewLoad`); the
 * frame imports it from core, which serves only the modules the frame
 * hasn't loaded yet, routes by the new tree, and React Fast Refresh swaps
 * the components in, keeping what the pages hold (preview-refresh.ts).
 * The way Vite's HMR client and TanStack Router's hot updates take one.
 *
 * What can go wrong, and what this does about it:
 * - Bytes other than core's, or modules of another preview: the frame
 *   imports only from its own module address, which core serves only
 *   with its MAC over the preview's scope (core's page-frame.ts).
 * - An update that doesn't evaluate: what it registered is discarded, so
 *   the page runs on as it was; the error goes to the page, which tells
 *   the chat's agent.
 * - An update that evaluates but fails to render: `broken`, and the page
 *   hands the last version that rendered back (preview-updates.ts in the
 *   web app), which its error boundary, remounted by Refresh, then shows.
 * - Code the frame evaluated before, an update back to an earlier write
 *   or the version swapped back: a browser evaluates one address once, so
 *   importing it again registers nothing, and Refresh would keep the
 *   newer code. The page then names a new `visit`, under which every
 *   module is at an address of its own.
 * - Refresh can't go on (an error it can't recover from): the page is
 *   told to start the frame afresh.
 * - The module doesn't load at all, as when the frame's module token has
 *   expired after hours open (`ModuleNotLoadedError`): nothing of the draft
 *   is at fault, so nothing is reported, and the page is told to start the
 *   frame afresh, with a fresh token.
 */

import { sha256Pattern } from "./declaration.ts";
import type { PreviewApplied, PreviewLoad } from "./page-runtime.ts";

/** What the receiver works with: Refresh, the frame, and the page. */
export interface PreviewFrame {
  /** Imports the route tree's module `load` names, registering its components. */
  evaluate: (load: PreviewLoad) => Promise<unknown>;
  /** Registers what the last evaluation staged (preview-refresh.ts). */
  commit: () => void;
  /** Forgets what the last evaluation staged. */
  discard: () => void;
  /** Swaps the registered components in: false once Refresh can't go on. */
  refresh: () => boolean;
  /**
   * Routes by the route tree the evaluated module exports (page-runtime.ts
   * `routeBy`): routes added, removed or renamed, and components Refresh
   * can't swap in, a page's renamed in an update. False for a module
   * with no route tree.
   */
  route: (module: unknown) => boolean;
  /** How many render errors React met so far. */
  renderFailures: () => number;
  /** Waits for what the swap rendered to settle (effects, a boundary). */
  settle: () => Promise<void>;
  /** The frame's CSS now. */
  css: () => string;
  /** Puts `css` in place of the frame's CSS. */
  setCss: (css: string) => void;
  /** Tells the page what went wrong. */
  report: (value: unknown) => void;
}

/**
 * What `PreviewFrame.evaluate` throws when the module didn't load: core
 * refused or lost it, or the network failed, before any of the draft's
 * code ran (`notLoaded`).
 */
export class ModuleNotLoadedError extends Error {
  override name = "ModuleNotLoadedError";
}

/**
 * Whether `error`, from importing a module of `directory`, says the module
 * graph didn't load rather than that its code threw: the TypeError each
 * engine's loader rejects with, which Chromium and Firefox write with the
 * address imported, and WebKit as one fixed sentence. Code of the page
 * that throws rejects with what it threw.
 */
export const notLoaded = (error: unknown, directory: string): boolean =>
  error instanceof TypeError &&
  (error.message.includes(directory) ||
    error.message === "Importing a module script failed.");

/** Whether `value` is a version as the page sends one. */
const isLoad = (value: unknown): value is PreviewLoad => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry: unknown = Reflect.get(value, "entry");
  const visit: unknown = Reflect.get(value, "visit");
  return (
    typeof entry === "string" &&
    sha256Pattern.test(entry) &&
    Number.isSafeInteger(visit) &&
    typeof visit === "number" &&
    visit >= 0 &&
    typeof Reflect.get(value, "css") === "string"
  );
};

/**
 * The frame's receiver of its draft's updates: what the page calls with
 * each version (`PageBridge.refresh`), one at a time.
 */
export const previewReceiver =
  (frame: PreviewFrame): ((load: unknown) => Promise<PreviewApplied>) =>
  async (load) => {
    if (!isLoad(load)) {
      return "refused";
    }
    const failuresBefore = frame.renderFailures();
    const css = frame.css();
    frame.setCss(load.css);
    let evaluated: unknown;
    try {
      evaluated = await frame.evaluate(load);
    } catch (error) {
      frame.discard();
      frame.setCss(css);
      if (error instanceof ModuleNotLoadedError) {
        return "reset";
      }
      frame.report(error);
      return "failed";
    }
    frame.commit();
    if (!frame.route(evaluated)) {
      frame.report(new TypeError("The route tree's module has no routeTree."));
      return "failed";
    }
    if (!frame.refresh()) {
      return "reset";
    }
    await frame.settle();
    return frame.renderFailures() === failuresBefore ? "applied" : "broken";
  };
