import type { Workspace } from "@grasp-os/shared/brain";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../../core-connection.ts";
import { useCore } from "../../use-core.ts";
import { atlasOf } from "../brain-atlas.ts";
import type { Atlas } from "../brain-atlas.ts";
import { buildBrain } from "../brain.ts";
import type { Brain } from "../brain.ts";
import { readBrain } from "../read-brain.ts";

// The brain an answer's thinking card lays its shape out in, on a page
// that has not read the brain (the chat page, the dock outside the brain):
// read from core as the person may read it, once for the tab and only
// when an answer that thought in the brain is shown, as every read of the
// brain is in the audit log; read again after it failed.

/** The brain as a shape is laid out in it. */
export interface ThinkingBrain {
  ws: Workspace;
  brain: Brain;
  atlas: Atlas;
}

const reads = new WeakMap<CoreConnection, Promise<ThinkingBrain | null>>();

const readOnce = async (
  core: CoreConnection
): Promise<ThinkingBrain | null> => {
  const read = await readBrain(core).catch(() => null);
  if (read?.state !== "ready") {
    reads.delete(core);
    return null;
  }
  const brain = buildBrain(read.data);
  return { ws: read.data, brain, atlas: atlasOf(read.data, brain) };
};

/** The tab's read of the brain, started on the first ask. */
const brainFor = async (
  core: CoreConnection
): Promise<ThinkingBrain | null> => {
  const started = reads.get(core);
  if (started !== undefined) {
    return await started;
  }
  const reading = readOnce(core);
  reads.set(core, reading);
  return await reading;
};

/** Reads the brain for `setRead`, unless left first; the way to leave. */
const readFor = (
  core: CoreConnection,
  setRead: (brain: ThinkingBrain | null) => void
): (() => void) => {
  let left = false;
  void (async () => {
    const brain = await brainFor(core);
    if (!left) {
      setRead(brain);
    }
  })();
  return () => {
    left = true;
  };
};

/** The brain to lay a thinking out in, once read; nothing while it is read or when it can't be. */
export const useThinkingBrain = (): ThinkingBrain | null => {
  const core = useCore();
  const [read, setRead] = useState<ThinkingBrain | null>(null);
  useEffect(() => readFor(core, setRead), [core]);
  return read;
};
