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
 */
import { commit } from "./preview-refresh.ts";
import type { ScreenStart } from "./screen-runtime.ts";

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
    onLoaded?: () => void
  ) => Promise<void>;
}

const isScreenRuntime = (module: unknown): module is ScreenRuntime =>
  typeof module === "object" &&
  module !== null &&
  "runScreen" in module &&
  typeof module.runScreen === "function";

/**
 * Runs the preview's screen as `runScreen` runs a screen, registering its
 * components with Refresh once its modules have evaluated, before it
 * first renders.
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
  await screens.runScreen(port, screen, start, filePort, linkPort, commit);
};
