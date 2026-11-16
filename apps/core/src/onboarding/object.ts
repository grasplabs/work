import { removeSharedSources } from "../brain-next.ts";
import { Onboarding as OnboardingStore } from "./store.ts";
import { claimSource } from "./team-claims.ts";

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
    super(ctx, env, async (sources) => {
      await removeSharedSources(
        env,
        sources.map((source) => claimSource(source))
      );
    });
  }
}
