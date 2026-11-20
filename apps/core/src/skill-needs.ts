import { skillFrontmatterOf } from "@grasp-os/brain-next/skills";
import {
  composioToolkitSchema,
  connectorProviderSchema,
} from "@grasp-os/shared/connect";
import { permissionActionSchema } from "@grasp-os/shared/permissions";
import { z } from "zod";

// What a skill needs to be of use (GRA-1844), as its `SKILL.md` declares
// it in its frontmatter, by the names the platform already gives a
// caller's connections and tools:
//
//   requires:
//     connections: [microsoft]   # a native provider, or a toolkit's slug
//     tools: [mail.send]         # a connection's action: its tool's name
//
// A skill whose needs the caller lacks is never listed, selected or read
// for them (brain-skills.ts): it is as if it weren't there. A need is
// never a grant: nothing about a skill is checked when a call is made.
// Checked when a skill is written (brain-next.ts), so a malformed
// declaration is refused there, never read as "needs nothing".

/** A connection's provider, as connect names it: a native one, or a toolkit's slug. */
const providerSchema = z.union([
  connectorProviderSchema,
  composioToolkitSchema,
]);

const needsSchema = z
  .strictObject({
    connections: z.array(providerSchema).min(1).optional(),
    tools: z.array(permissionActionSchema).min(1).optional(),
  })
  .optional();

/** What a skill needs: connections by provider, tools by name; none of either when it declares none. */
export interface SkillNeeds {
  connections: readonly string[];
  tools: readonly string[];
}

/** What a caller holds now, as a skill's needs are met against it. */
export interface HeldCapabilities {
  /** The providers of the active connections they may use. */
  connections: ReadonlySet<string>;
  /** The actions they may call on those connections. */
  tools: ReadonlySet<string>;
}

/** Holds nothing: where no connection is used (a conversation others share), or none could be read. */
export const heldNothing: HeldCapabilities = {
  connections: new Set(),
  tools: new Set(),
};

/**
 * What the skill `text` declares it needs, or null when it isn't a skill or
 * its declaration isn't the format's (above).
 */
export const skillNeedsOf = (text: string): SkillNeeds | null => {
  const frontmatter = skillFrontmatterOf(text);
  if (frontmatter === null) {
    return null;
  }
  const parsed = needsSchema.safeParse(frontmatter.requires);
  if (!parsed.success) {
    return null;
  }
  return {
    connections: parsed.data?.connections ?? [],
    tools: parsed.data?.tools ?? [],
  };
};

/** Whether `needs` declares anything at all. */
export const needsAnything = (needs: SkillNeeds): boolean =>
  needs.connections.length > 0 || needs.tools.length > 0;

/** Whether `held` meets every one of `needs`. */
export const meets = (held: HeldCapabilities, needs: SkillNeeds): boolean =>
  needs.connections.every((provider) => held.connections.has(provider)) &&
  needs.tools.every((tool) => held.tools.has(tool));
