import type { ThinkingGround } from "@grasp-os/shared/brain";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../../core-connection.ts";
import { useCore } from "../../use-core.ts";

// What an answer's thinking card draws its shape from, on a page that has
// not read the brain (the chat page, the dock outside the brain): core's
// narrow read for it (`brain.thinking`), the teams, what they said and the
// workflows, nothing else of the brain and no brain to build. Read once
// for the tab, only once an answer that thought in the brain is shown;
// read again after it failed, and forgotten with whoever signed out.

let reads = new WeakMap<CoreConnection, Promise<ThinkingGround | null>>();

/** Forgets what was read: it was what whoever signed out may read. */
export const forgetCardGround = (): void => {
  reads = new WeakMap();
};

const readOnce = async (
  core: CoreConnection
): Promise<ThinkingGround | null> => {
  try {
    return await core.withSession(
      async (session) => await session.brain.thinking()
    );
  } catch {
    // The card says where to see it instead; the next card reads again.
    reads.delete(core);
    return null;
  }
};

/** The tab's read, started on the first ask. */
const groundFor = async (
  core: CoreConnection
): Promise<ThinkingGround | null> => {
  const started = reads.get(core);
  if (started !== undefined) {
    return await started;
  }
  const reading = readOnce(core);
  reads.set(core, reading);
  return await reading;
};

/** Reads it for `setRead`, unless left first; the way to leave. */
const readFor = (
  core: CoreConnection,
  setRead: (ground: ThinkingGround | null) => void
): (() => void) => {
  let left = false;
  void (async () => {
    const ground = await groundFor(core);
    if (!left) {
      setRead(ground);
    }
  })();
  return () => {
    left = true;
  };
};

/**
 * What a card draws its shape from: `undefined` while it is read, `null`
 * when it can't be.
 */
export const useCardGround = (): ThinkingGround | null | undefined => {
  const core = useCore();
  const [read, setRead] = useState<ThinkingGround | null>();
  useEffect(() => readFor(core, setRead), [core]);
  return read;
};
