import {
  brainErrors,
  changeOptionsSchema,
  commandOptionsSchema,
  entitiesListInputSchema,
  entitySourcesInputSchema,
  memoriesGetInputSchema,
  memoriesListInputSchema,
  memoriesProposeChangeInputSchema,
  receiptsGetInputSchema,
  recallInputSchema,
  relationsExplainInputSchema,
  relationsGetInputSchema,
  rememberInputSchema,
  skillsReadInputSchema,
  skillsSelectInputSchema,
} from "@grasp-os/brain/contract";
import type {
  BrainSourceRef,
  ChangeOptions,
  CommandOptions,
  CommandReceipt,
  EntitiesListInput,
  EntitySourcesInput,
  EntitySummary,
  MemoriesGetInput,
  MemoriesListInput,
  MemoriesProposeChangeInput,
  MemoryPack,
  MemoryPage,
  MemoryRecord,
  ReceiptsGetInput,
  RecallInput,
  RelationsAnswer,
  RelationsExplainInput,
  RelationsExplanation,
  RelationsGetInput,
  RememberInput,
  SkillRead,
  SkillSelection,
  SkillsReadInput,
  SkillsSelectInput,
} from "@grasp-os/brain/contract";
import type { z } from "zod";

export type {
  BrainSourceRef,
  ChangeOptions,
  CommandOptions,
  CommandReceipt,
  Coverage,
  EntitiesListInput,
  EntitySourcesInput,
  EntitySummary,
  MemoryItem,
  MemoryPack,
  MemoryPage,
  MemoryRecord,
  RecallInput,
  RelationsAnswer,
  RelationsExplainInput,
  RelationsExplanation,
  RelationsGetInput,
  RelationView,
  RememberInput,
  SkillRead,
  SkillRef,
  SkillSelection,
  SkillsReadInput,
  SkillsSelectInput,
} from "@grasp-os/brain/contract";
export { brainErrors } from "@grasp-os/brain/contract";

// Typed calls to the Brain (the Brain design's "Brain SDK and API"):
// `brain(env.HANDBOOK)` over a binding the host gave the caller. The
// binding is the authority, made by core from the caller's grants: this
// facade can't make one from a person or a collection's name, holds no
// storage, and has no `recordOutcome`, which only the host records.
// Each call's input is checked here, for an early, typed refusal, and
// again in core, which is what counts.

/**
 * What the host binds a Brain resource as: one method per operation the
 * caller was granted. Core builds it; a caller only ever receives it.
 */
export interface BrainBinding {
  recall?: (input: RecallInput) => Promise<MemoryPack>;
  remember?: (
    input: RememberInput,
    options: CommandOptions
  ) => Promise<CommandReceipt>;
  receiptsGet?: (input: ReceiptsGetInput) => Promise<CommandReceipt>;
  memoriesGet?: (input: MemoriesGetInput) => Promise<MemoryRecord>;
  memoriesList?: (input: MemoriesListInput) => Promise<MemoryPage>;
  memoriesProposeChange?: (
    input: MemoriesProposeChangeInput,
    options: ChangeOptions
  ) => Promise<CommandReceipt>;
  skillsSelect?: (input: SkillsSelectInput) => Promise<SkillSelection>;
  skillsRead?: (input: SkillsReadInput) => Promise<SkillRead>;
  entitiesList?: (input: EntitiesListInput) => Promise<EntitySummary[]>;
  entitySources?: (input: EntitySourcesInput) => Promise<BrainSourceRef[]>;
  relationsGet?: (input: RelationsGetInput) => Promise<RelationsAnswer>;
  relationsExplain?: (
    input: RelationsExplainInput
  ) => Promise<RelationsExplanation>;
}

/** The Brain, as a caller uses it. */
export interface Brain {
  /** Evidence that applies to `input.query`: a bounded memory pack. */
  recall: (input: RecallInput) => Promise<MemoryPack>;
  /** Submits something to remember; retry with the same key after a loss. */
  remember: (
    input: RememberInput,
    options: CommandOptions
  ) => Promise<CommandReceipt>;
  receipts: {
    /** A command's receipt, recovered after a lost response. */
    get: (input: ReceiptsGetInput) => Promise<CommandReceipt>;
  };
  memories: {
    get: (input: MemoriesGetInput) => Promise<MemoryRecord>;
    list: (input?: MemoriesListInput) => Promise<MemoryPage>;
    /** A correction, against the revision it was read at. */
    proposeChange: (
      input: MemoriesProposeChangeInput,
      options: ChangeOptions
    ) => Promise<CommandReceipt>;
  };
  skills: {
    /**
     * The skill that applies to a task, pinned at the version read, or an
     * explicit no-skill result: keep the pin for the task's whole run.
     */
    select: (input: SkillsSelectInput) => Promise<SkillSelection>;
    /** A pinned skill, at exactly its version. */
    read: (input: SkillsReadInput) => Promise<SkillRead>;
  };
  entities: {
    /**
     * The entities readable sources mention, by a name's start: at least
     * two characters for a caller that isn't a person.
     */
    list: (input: EntitiesListInput) => Promise<EntitySummary[]>;
    /** The readable sources that mention one entity, at their versions. */
    sources: (input: EntitySourcesInput) => Promise<BrainSourceRef[]>;
  };
  relations: {
    /**
     * What readable sources say about one entity, each with its passage:
     * on a date (`at`), as known at a moment (`knownAt`). Observed, never
     * an accepted fact; conflicting ones both come back. `truncated`: a
     * cap left some out, so what came back isn't all there is.
     */
    get: (input: RelationsGetInput) => Promise<RelationsAnswer>;
    /**
     * The paths out from one entity, one or two relations long, through
     * what the caller may read, within a budget of paths and time.
     */
    explain: (input: RelationsExplainInput) => Promise<RelationsExplanation>;
  };
}

/** `value` checked against `schema`, or refused as `brain.invalid`. */
const checked = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw brainErrors.create("brain.invalid");
  }
  return parsed.data;
};

/**
 * `binding`'s method `name`, called with `args` on `binding` itself, so a
 * host's class keeps its own state; or a refusal, when the binding wasn't
 * granted that operation.
 */
const call = async <Name extends keyof BrainBinding>(
  binding: BrainBinding,
  name: Name,
  ...args: Parameters<NonNullable<BrainBinding[Name]>>
): Promise<Awaited<ReturnType<NonNullable<BrainBinding[Name]>>>> => {
  const method: unknown = binding[name];
  if (typeof method !== "function") {
    throw brainErrors.create("brain.denied");
  }
  // SAFETY: `method` is `binding[name]`, typed by `BrainBinding`, and `args`
  // are that method's parameters.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return (await Reflect.apply(method, binding, args)) as Awaited<
    ReturnType<NonNullable<BrainBinding[Name]>>
  >;
};

/** The Brain over `binding`, a Brain resource the host bound. */
export const brain = (binding: BrainBinding): Brain => ({
  recall: async (input) =>
    await call(binding, "recall", checked(recallInputSchema, input)),
  remember: async (input, options) =>
    await call(
      binding,
      "remember",
      checked(rememberInputSchema, input),
      checked(commandOptionsSchema, options)
    ),
  receipts: {
    get: async (input) =>
      await call(
        binding,
        "receiptsGet",
        checked(receiptsGetInputSchema, input)
      ),
  },
  memories: {
    get: async (input) =>
      await call(
        binding,
        "memoriesGet",
        checked(memoriesGetInputSchema, input)
      ),
    list: async (input = {}) =>
      await call(
        binding,
        "memoriesList",
        checked(memoriesListInputSchema, input)
      ),
    proposeChange: async (input, options) =>
      await call(
        binding,
        "memoriesProposeChange",
        checked(memoriesProposeChangeInputSchema, input),
        checked(changeOptionsSchema, options)
      ),
  },
  skills: {
    select: async (input) =>
      await call(
        binding,
        "skillsSelect",
        checked(skillsSelectInputSchema, input)
      ),
    read: async (input) =>
      await call(binding, "skillsRead", checked(skillsReadInputSchema, input)),
  },
  entities: {
    list: async (input) =>
      await call(
        binding,
        "entitiesList",
        checked(entitiesListInputSchema, input)
      ),
    sources: async (input) =>
      await call(
        binding,
        "entitySources",
        checked(entitySourcesInputSchema, input)
      ),
  },
  relations: {
    get: async (input) =>
      await call(
        binding,
        "relationsGet",
        checked(relationsGetInputSchema, input)
      ),
    explain: async (input) =>
      await call(
        binding,
        "relationsExplain",
        checked(relationsExplainInputSchema, input)
      ),
  },
});
