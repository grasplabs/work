import {
  brainErrors,
  changeOptionsSchema,
  commandOptionsSchema,
  memoriesGetInputSchema,
  memoriesListInputSchema,
  memoriesProposeChangeInputSchema,
  receiptsGetInputSchema,
  recallInputSchema,
  rememberInputSchema,
  skillsReadInputSchema,
  skillsSelectInputSchema,
} from "@grasp-os/brain/contract";
import type {
  ChangeOptions,
  CommandOptions,
  CommandReceipt,
  MemoriesGetInput,
  MemoriesListInput,
  MemoriesProposeChangeInput,
  MemoryPack,
  MemoryPage,
  MemoryRecord,
  ReceiptsGetInput,
  RecallInput,
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
  MemoryItem,
  MemoryPack,
  MemoryPage,
  MemoryRecord,
  RecallInput,
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
});
