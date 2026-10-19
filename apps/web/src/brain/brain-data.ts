import type { Workspace } from "@grasp-os/shared/brain";
import { getRouteApi } from "@tanstack/react-router";

import type { Brain } from "./brain.ts";

/** What every page of the brain is drawn from: the workspace core gave, and the brain built from it. */
export interface BrainData {
  workspace: Workspace;
  brain: Brain;
}

const layout = getRouteApi("/_shell/brain");

/**
 * The brain, as its layout (routes/_shell.brain.tsx) read and built it, for
 * the pages inside it. The layout shows them only once the brain is there.
 */
export const useBrainData = (): BrainData => {
  const loaded = layout.useLoaderData();
  if (loaded.state !== "ready") {
    throw new Error("The brain's pages show only once the brain is read");
  }
  return loaded.data;
};
