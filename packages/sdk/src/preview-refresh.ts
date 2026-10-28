/**
 * React Fast Refresh in a chat's preview frame (spec 19.2.1, 22.7): the
 * preview kit's only module that loads the Refresh runtime. It hooks into
 * React before React DOM loads (`@grasp-os/sdk/preview-runtime` loads it
 * first), so the renderer hands Refresh what it needs to swap components.
 *
 * A preview build's modules register their components here, by family
 * (the App file's path and the component's name, never a revision or a
 * hash), through the names the compiler's Refresh instrumentation calls.
 * Registrations are staged: they count only once the code that made them
 * has evaluated whole (`commit`), so a failed update leaves the families
 * of the code that runs as they were. Never in a production build: the
 * runtime's own production build throws, and only the preview kit has
 * this module.
 */
import runtime from "react-refresh/runtime";

runtime.injectIntoGlobalHook(globalThis);

const staged: [type: unknown, family: string][] = [];

/** Stages `type` as the component of `family`, until `commit`. */
export const register = (type: unknown, family: string): void => {
  staged.push([type, family]);
};

/** What the instrumentation tracks a component's hooks with, as React's. */
export const signature = runtime.createSignatureFunctionForTransform;

/** Registers what was staged: the code that staged it evaluated whole. */
export const commit = (): void => {
  for (const [type, family] of staged.splice(0)) {
    runtime.register(type, family);
  }
};

/** Forgets what was staged: the code that staged it failed to evaluate. */
export const discard = (): void => {
  staged.length = 0;
};

/**
 * Swaps the committed families' new components into what is rendered,
 * keeping the state of each whose hooks are the same. False once Refresh
 * can't go on in this frame (an error it can't recover from): the frame
 * then needs a reset.
 */
export const refresh = (): boolean => {
  runtime.performReactRefresh();
  return !runtime.hasUnrecoverableErrors();
};
