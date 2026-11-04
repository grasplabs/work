/**
 * How a chat's preview's frame takes its draft's updates (spec 19.2.1):
 * the page hands it each version of the screen over the frame's own
 * bridge, as the address of its screen's module (`PreviewLoad`); the frame
 * imports it from core, which serves only the modules the frame hasn't
 * loaded yet, and React Fast Refresh swaps its components in, keeping
 * what the screen holds (preview-refresh.ts). The way Vite's HMR client
 * takes an update.
 *
 * What can go wrong, and what this does about it:
 * - Bytes other than core's, or modules of another preview: the frame
 *   imports only from its own module address, which core serves only
 *   with its MAC over the preview's scope (core's screen-frame.ts).
 * - An update that doesn't evaluate: what it registered is discarded, so
 *   the screen runs on as it was; the error goes to the page, which tells
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
 */
import type {
  PreviewApplied,
  PreviewLoad,
  ScreenComponent,
} from "./screen-runtime.ts";

/** What the receiver works with: Refresh, the frame, and the page. */
export interface PreviewFrame {
  /** Imports the screen's module `load` names, registering its components. */
  evaluate: (load: PreviewLoad) => Promise<unknown>;
  /** Registers what the last evaluation staged (preview-refresh.ts). */
  commit: () => void;
  /** Forgets what the last evaluation staged. */
  discard: () => void;
  /** Swaps the registered components in: false once Refresh can't go on. */
  refresh: () => boolean;
  /**
   * Shows `screen`, the evaluated module's default export, as the screen,
   * rendering it at once: what Refresh can't swap in, a screen renamed in
   * an update (screen-runtime.ts `ShownScreen`).
   */
  show: (screen: ScreenComponent) => void;
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

/** What a module's address looks like: core's hash of it. */
const addressPattern = /^[0-9a-f]{64}$/u;

/** Whether `value` is a version as the page sends one. */
const isLoad = (value: unknown): value is PreviewLoad => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry: unknown = Reflect.get(value, "entry");
  const visit: unknown = Reflect.get(value, "visit");
  return (
    typeof entry === "string" &&
    addressPattern.test(entry) &&
    Number.isSafeInteger(visit) &&
    typeof visit === "number" &&
    visit >= 0 &&
    typeof Reflect.get(value, "css") === "string"
  );
};

/**
 * Whether `value` is a component React can render as the screen: a
 * function, as the compiler makes every screen's default export one.
 */
const isScreen = (value: unknown): value is ScreenComponent =>
  typeof value === "function";

/** A module's default export, whatever it is: the screen, in a screen's module. */
const defaultOf = (evaluated: unknown): unknown =>
  typeof evaluated === "object" && evaluated !== null
    ? Reflect.get(evaluated, "default")
    : undefined;

/**
 * The frame's receiver of its draft's updates: what the page calls with
 * each version (`ScreenBridge.refresh`), one at a time.
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
    let screen: ScreenComponent;
    try {
      const found = defaultOf(await frame.evaluate(load));
      if (!isScreen(found)) {
        throw new TypeError(
          "The screen's module has no default export to render."
        );
      }
      screen = found;
    } catch (error) {
      frame.discard();
      frame.setCss(css);
      frame.report(error);
      return "failed";
    }
    frame.commit();
    if (!frame.refresh()) {
      return "reset";
    }
    // What Refresh swapped is shown; a screen of another name only so.
    frame.show(screen);
    await frame.settle();
    return frame.renderFailures() === failuresBefore ? "applied" : "broken";
  };
