import { log } from "@grasp-os/shared/log";

import { eraseSource, removeSharedSources } from "../brain-next.ts";
import type { FallingClaim } from "./claims-fall.ts";
import { Onboarding as OnboardingStore } from "./store.ts";
import { claimSource } from "./team-claims.ts";

/**
 * Takes `claims` out of use in the shared store, all at once (throwing
 * when the Brain can't), then erases each, so the Brain's ledger keeps it
 * out after a restore of the store from before. An erasure that fails is
 * left owed, for core's clock: the claim is out of use already. The
 * sources erased.
 */
const takeOut = async (
  env: Env,
  claims: readonly FallingClaim[]
): Promise<string[]> => {
  await removeSharedSources(
    env,
    claims.map(({ source }) => claimSource(source))
  );
  const erased: string[] = [];
  for (const { source, team } of claims) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await eraseSource(env, {
        source: claimSource(source),
        readers: { kind: "interviews", teamId: team },
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
 * itself, taking team claims that stop standing out of use in the shared
 * store before the change that drops them commits (GRA-1946, the store's
 * `#claimsFirst`). Given here, through core's Brain module, as the store
 * can't import that module: it reads the store back (a cycle).
 */
export class Onboarding extends OnboardingStore {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, async (claims) => await takeOut(env, claims));
  }
}
