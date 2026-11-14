import type {
  BrainCard,
  BrainEntity,
  BrainEntityKind,
  BrainMemory,
  BrainPack,
  BrainSkill,
  BrainSkillText,
} from "@grasp-os/runtime/app";
import { brainQuestionMaxLength } from "@grasp-os/shared/brain-sources";
import { z } from "zod";

/**
 * A pack, as code's recall answers one (`BrainPack`), and nothing more:
 * what the function host lets an App's recall hand back, and what a test
 * run's fixture may answer a workflow's recall with (workflows/
 * brain-calls.ts). Typed against the SDK's own, so neither can drift.
 */
export const brainPackSchema: z.ZodType<BrainPack> = z.strictObject({
  items: z.array(
    z.strictObject({
      source: z.strictObject({
        producer: z.enum(["upload", "chat", "run"]),
        id: z.string().min(1),
      }),
      version: z.int().positive(),
      position: z.int().nonnegative(),
      text: z.string(),
      whole: z.boolean(),
      found: z.enum(["exact", "words", "stop words", "meaning"]),
    })
  ),
  notFound: z.array(z.string()),
  truncated: z.boolean(),
});

/** A task to select skills for, in the asker's words, as a question is. */
export const skillsSelectSchema: z.ZodType<{ task: string }> = z.strictObject({
  task: z.string().trim().min(1).max(brainQuestionMaxLength),
});

/**
 * A skill at a version to read, as a selection gives it: what else it
 * carries (its description) is accepted and dropped, by name.
 */
export const skillReadSchema = z.strictObject({
  skill: z
    .looseObject({
      scope: z.enum(["grasp", "company"]),
      name: z.string(),
      version: z.int().positive(),
    })
    .transform(({ scope, name, version }) => ({ scope, name, version })),
}) satisfies z.ZodType<{
  skill: Pick<BrainSkill, "scope" | "name" | "version">;
}>;

const skillScopeSchema = z.enum(["grasp", "company"]);

/**
 * What a selection answers code (`{ skills }`, each a `BrainSkill`), and nothing more:
 * as the function host lets an App's hand back, and a test run's fixture
 * may answer a workflow's.
 */
export const brainSkillsSelectedSchema: z.ZodType<{
  skills: readonly BrainSkill[];
}> = z.strictObject({
  skills: z.array(
    z.strictObject({
      scope: skillScopeSchema,
      name: z.string().min(1),
      version: z.int().positive(),
      description: z.string(),
    })
  ),
});

/** A skill read, whole (`BrainSkillText`), and nothing more. */
export const brainSkillTextSchema: z.ZodType<BrainSkillText> = z.strictObject({
  scope: skillScopeSchema,
  name: z.string().min(1),
  version: z.int().positive(),
  text: z.string(),
});

/** What `remember` answers code: the memory and its entity, by id. */
export const brainRememberedSchema = z.strictObject({
  memory: z.uuid(),
  entity: z.uuid(),
});

/** What `correct` answers code: the fix, or null for no memory it may correct. */
export const brainCorrectedSchema = z
  .strictObject({ memory: z.uuid() })
  .nullable();

/** Every kind of entity, each once: the SDK's own (`BrainEntityKind`). */
const brainEntityKinds = {
  person: "person",
  team: "team",
  customer: "customer",
  supplier: "supplier",
  project: "project",
  product: "product",
  tool: "tool",
  routine: "routine",
  app: "app",
  workflow: "workflow",
  connection: "connection",
  term: "term",
} as const satisfies { readonly [Kind in BrainEntityKind]: Kind };

/** An entity, as code is handed one (`BrainEntity`), and nothing more. */
const brainEntitySchema: z.ZodType<BrainEntity> = z.strictObject({
  id: z.uuid(),
  kind: z.enum(brainEntityKinds),
  name: z.string().nullable(),
});

/** A memory on a card, as code is handed one (`BrainMemory`), and nothing more. */
const brainMemorySchema: z.ZodType<BrainMemory> = z.strictObject({
  id: z.uuid(),
  attribute: z.string().nullable(),
  value: z.string().nullable(),
  statement: z.string(),
  learnedAt: z.iso.datetime(),
  confirmed: z.boolean(),
  contested: z.boolean(),
});

/**
 * A page of an entity's card, as code is handed it (`BrainCard`), and
 * nothing more: what the function host lets an App's `entities.get` hand
 * back, and what a test run's fixture may answer a workflow's.
 */
export const brainCardSchema: z.ZodType<BrainCard> = z.strictObject({
  entity: brainEntitySchema,
  attributes: z.array(
    z.strictObject({
      attribute: z.string(),
      memories: z.array(brainMemorySchema),
      contested: z.boolean(),
    })
  ),
  relations: z.array(
    z.strictObject({
      attribute: z.string().nullable(),
      side: z.enum(["about", "object"]),
      other: brainEntitySchema,
      memory: brainMemorySchema,
    })
  ),
  notes: z.array(brainMemorySchema),
  next: z.string().nullable(),
});

/** A page of entities, as code is handed it, and nothing more. */
export const brainEntitiesSchema = z.strictObject({
  entities: z.array(brainEntitySchema),
  next: z.string().nullable(),
});
