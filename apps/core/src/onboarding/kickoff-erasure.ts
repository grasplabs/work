import type { OnErase } from "@grasp-os/brain/purge";
import { auditActorSchema } from "@grasp-os/shared/audit";

import { onboardingStore } from "./store.ts";

/**
 * The kickoff as a Knowledge purge reaches it: a content purge whose
 * terms its transcript, reading or answers hold forgets it whole (the
 * store's `forgetKickoff`), as the admin's hard delete; and a transcript
 * whose reading began before it is refused once read (`notePurge`). Rewriting it
 * instead would leave it able to give the brain its words again: its
 * next answer reads the kickoff, not the rewritten records. It names no
 * one, so a personal purge has no one to forget here.
 */
export const kickoffErasure = (
  env: Env
): Pick<OnErase, "count" | "rewrite" | "forgetActor"> => {
  const store = onboardingStore(env);
  return {
    count: async (holds) => {
      const texts = await store.kickoffTexts();
      return texts.some(holds) ? 1 : 0;
    },
    rewrite: async (by, rewrite) => {
      // First: a save whose reading began before now is refused from here
      // on; one saved already is in the kickoff read next.
      await store.notePurge();
      const texts = await store.kickoffTexts();
      if (texts.some((text) => rewrite(text) !== text)) {
        await store.forgetKickoff(auditActorSchema.parse(by.actor));
      }
    },
    forgetActor: async () => {
      // The kickoff keeps no one's name of its own.
    },
  };
};
