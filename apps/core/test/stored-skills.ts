import { brainOf } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";

import { inJurisdiction } from "../src/durable-objects.ts";

// A test-only seam: a skill written straight into the Brain's store, as a
// writer core doesn't have yet would (the company's approved publish,
// GRA-1754), or as an older release left one. Product code can't import
// it: it lives with the tests. The key and readers are brain-next.ts's
// (`skillKeyOf`, readable by the company's group).

/** Writes `text` as the next version of the skill `scope`/`name`. */
export const storeSkill = async (
  scope: "grasp" | "company",
  name: string,
  text: string
): Promise<number> => {
  const { version } = await brainOf(
    inJurisdiction(env, env.BRAIN_STORE)
  ).addInstructions({
    source: `skill:${scope}:${name}`,
    change: crypto.randomUUID(),
    text,
    access: { kind: "audience", group: "company" },
  });
  return version;
};
