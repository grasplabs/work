import type { RpcStub } from "capnweb";

/**
 * What runs a chat's preview of a draft in its frame (spec 22.7): the
 * screen runtime (screen-runtime.ts) with React Fast Refresh. The preview
 * frame's document loads this in place of the screen runtime; published
 * screens never do, and only the preview kit has it.
 *
 * Refresh must hook into React before React DOM first loads. A bundler
 * may order a module's static imports as it likes, so this imports only
 * the Refresh runtime (preview-refresh.ts), which imports nothing of
 * React, statically, and the screen runtime, which imports React DOM,
 * once this has run: by its flat name, which the frame's import map
 * resolves (the compiler puts it in every preview's closure).
 *
 * Once the screen has rendered, it hands the page its receiver of the
 * draft's updates (preview-updates.ts), and tells the page when the
 * screen rendered nothing at all: a problem the agent hears of, as of an
 * error.
 */
import { commit, discard, refresh } from "./preview-refresh.ts";
import {
  ModuleNotLoadedError,
  notLoaded,
  previewReceiver,
} from "./preview-updates.ts";
import type {
  PreviewLoad,
  ScreenBridge,
  ScreenComponent,
  ScreenHooks,
  ScreenStart,
} from "./screen-runtime.ts";

/** The screen runtime's module, by its flat name in the kit. */
const screenRuntimeModule = "@grasp-os~sdk~screen-runtime.js";

/** What the screen runtime's module exports, as this calls it. */
interface ScreenRuntime {
  runScreen: (
    port: MessagePort,
    screen: string,
    start: ScreenStart,
    filePort: MessagePort,
    linkPort: MessagePort,
    hooks?: ScreenHooks
  ) => Promise<void>;
  reportProblem: (kind: "error" | "rejection", value: unknown) => void;
}

const isScreenRuntime = (module: unknown): module is ScreenRuntime =>
  typeof module === "object" &&
  module !== null &&
  "runScreen" in module &&
  typeof module.runScreen === "function" &&
  "reportProblem" in module &&
  typeof module.reportProblem === "function";

/** Waits for the next task: what a swap rendered has run its effects. */
const nextTask = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  setTimeout(() => {
    resolve(null);
  }, 0);
  await promise;
};

/**
 * Where `load`'s module is, beside `screen`, the address the frame first
 * loaded the screen's module at: in the same directory, the preview's
 * own (core's screen-frame.ts), under its visit from 1 on.
 */
const addressOf = (screen: string, { entry, visit }: PreviewLoad): string =>
  new URL(visit === 0 ? `${entry}.js` : `${visit}/${entry}.js`, screen).href;

/**
 * The style element the frame's document put the screen's CSS in, which
 * an update's CSS replaces: the document's only one.
 */
const screenStyle = (): HTMLStyleElement => {
  const found = document.head.querySelector("style");
  if (found !== null) {
    return found;
  }
  const made = document.createElement("style");
  document.head.append(made);
  return made;
};

/**
 * Runs the preview's screen as `runScreen` runs a screen, registering its
 * components with Refresh once its modules have evaluated, before it
 * first renders, and taking the draft's updates once it has rendered.
 */
export const runScreen = async (
  port: MessagePort,
  screen: string,
  start: ScreenStart,
  filePort: MessagePort,
  linkPort: MessagePort
): Promise<void> => {
  const screens: unknown = await import(screenRuntimeModule);
  if (!isScreenRuntime(screens)) {
    throw new Error("The preview kit has no screen runtime.");
  }
  let failures = 0;
  // What shows another component as the screen, once the screen rendered.
  const showing: { screen?: (screen: ScreenComponent) => void } = {};
  let following = false;
  const rendersNothing = (root: HTMLElement): void => {
    if (root.childNodes.length === 0) {
      screens.reportProblem(
        "error",
        new Error("The screen rendered nothing: it returned no content.")
      );
    }
  };
  const follow = (page: RpcStub<ScreenBridge>, root: HTMLElement): void => {
    rendersNothing(root);
    // Its boundary remounts what it shows after an error (as Refresh
    // does): the page has the receiver already.
    if (following) {
      return;
    }
    following = true;
    const receive = previewReceiver({
      evaluate: async (load) => {
        try {
          const evaluated: unknown = await import(addressOf(screen, load));
          return evaluated;
        } catch (error) {
          throw notLoaded(error, new URL("./", screen).href)
            ? new ModuleNotLoadedError("The screen's module didn't load.", {
                cause: error,
              })
            : error;
        }
      },
      commit,
      discard,
      refresh,
      show: (shown) => {
        showing.screen?.(shown);
      },
      renderFailures: () => failures,
      settle: nextTask,
      css: () => screenStyle().textContent,
      setCss: (css) => {
        screenStyle().textContent = css;
      },
      report: (value) => {
        screens.reportProblem("error", value);
      },
    });
    void page.refresh(async (load) => {
      const answer = await receive(load);
      if (answer === "applied") {
        rendersNothing(root);
      }
      return answer;
    });
  };
  await screens.runScreen(port, screen, start, filePort, linkPort, {
    loaded: commit,
    renderFailed: () => {
      failures += 1;
    },
    mounted: follow,
    shows: (show) => {
      showing.screen = show;
    },
  });
};
