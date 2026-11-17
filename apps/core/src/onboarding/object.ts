import { log } from "@grasp-os/shared/log";

import { eraseSource, removeSharedSources } from "../brain-next.ts";
import type { FallingSource } from "./sources-fall.ts";
import { Onboarding as OnboardingStore } from "./store.ts";

/**
 * Takes the team claims and drawings `sources` out of use in the shared
 * store, all at once (throwing when the Brain can't), then erases each, so
 * the Brain's ledger keeps it out after a restore of the store from
 * before. An erasure that fails is left owed, for core's clock: the source
 * is out of use already. The sources erased.
 */
const takeOut = async (
  env: Env,
  sources: readonly FallingSource[]
): Promise<FallingSource[]> => {
  await removeSharedSources(env, sources);
  const erased: FallingSource[] = [];
  for (const source of sources) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await eraseSource(env, {
        source,
        readers: { kind: "members" },
        reason: "deleted",
      });
      erased.push(source);
    } catch (error) {
      log.error("onboarding.brain_erasure_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return erased;
};

/**
 * The onboarding's object as the Worker runs it (the `Onboarding` class
 * its binding names): the store, given the one way it reaches the Brain
 * itself, taking team claims and drawings that stop standing out of use in
 * the shared store before the change that drops them commits (GRA-1946,
 * GRA-1748, the store's `#fallenFirst`). Given here, through core's Brain module, as the store
 * can't import that module: it reads the store back (a cycle).
 */
export class Onboarding extends OnboardingStore {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, async (sources) => await takeOut(env, sources));
  }
}
