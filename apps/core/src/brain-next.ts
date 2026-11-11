import {
  brainOf,
  currentReadMax,
  instructionsMaxLength,
  instructionsTextSchema,
  isOverInstructionsLimit,
  principalMaxLength,
  sourceIdMaxLength,
  wellFormedString,
  modelWaitMaxSeconds,
} from "@grasp-os/brain-next/contract";
import type {
  Access,
  AskModel,
  Brain,
  ModelReply,
  Reader,
  SourceId,
  WorkOverview,
} from "@grasp-os/brain-next/contract";
import { isExpectedError } from "@grasp-os/shared/errors";
import { instructionFileErrors } from "@grasp-os/shared/instruction-files";
import { modelErrors } from "@grasp-os/shared/models";
import type { ModelErrorCode } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { z } from "zod";

import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { modelForRole, modelSettings, models } from "./models.ts";

// The Brain, as core reaches it (@grasp-os/brain-next). The Brain knows no
// people or teams: core names them as principals, a person by their user
// ID and a team as a group (`teamGroup`). Core's other code adds, recalls
// and reads history through the functions here, naming people and teams;
// the Brain's reader is made only here, from core's own records read at
// each recall, never from what a caller claims or hands in ready-made.
//
// A source is named by the producer that adds it (one of `producerKinds`)
// and that producer's own id for it; the Brain's key for it is made only
// here (`sourceKeyOf`), so one producer can never name another's sources.
// `addSource` and `readSourceVersionAs` are server-side functions for
// producers: never reached by people, Apps or the SDK directly.
//
// Every argument is checked here, strictly, before anything is named for
// the Brain: an empty or missing ID would otherwise become a principal
// ("team:", "team:undefined") the Brain can't tell from a real one, and
// a source nobody can reach would be added without a word. Every string is
// well-formed (the Brain's own rule, `wellFormedString`), so no two become
// one once encoded.

/** A team's group name starts with this; the rest is the team's ID. */
const teamPrefix = "team:";

/** A person's or a team's ID, as core passes it: never empty. */
const idSchema = wellFormedString()
  .min(1)
  .max(principalMaxLength - teamPrefix.length);

const sourceReadersSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner"), personId: idSchema }),
  z.strictObject({ kind: z.literal("team"), teamId: idSchema }),
  z.strictObject({ kind: z.literal("none") }),
]);

/** Who may read a source, as core names them. */
export type SourceReaders = z.infer<typeof sourceReadersSchema>;

/** `input` as `schema` reads it, or an error naming what was wrong. */
const checked = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Refused: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

/** The kind instruction files' keys are under (`instructionKeyOf`). */
const instructionsKind = "instructions";

/**
 * `kinds`, which must hold no ":", and never `instructionsKind`: a
 * source's key is its kind, ":", and its id, so a kind with ":" could name
 * a key under another kind, and a kind `instructions` would name the
 * instruction files' keys (read through `readSourceVersionAs`). A list
 * where one does doesn't compile.
 */
const kindsWithoutColon = <const K extends string>(
  kinds: readonly K[] &
    ([Extract<K, `${string}:${string}` | typeof instructionsKind>] extends [
      never,
    ]
      ? unknown
      : never)
): readonly K[] => kinds;

/**
 * Everything that adds sources to the Brain, one kind each. Each producer
 * issue adds its own (GRA-1727: meetings, workflow runs, interviews;
 * GRA-1730: what agents fetch). A kind is never `instructions`, the
 * instruction files' own (`instructionKeyOf`).
 *
 * A kind is only ever added, never removed or renamed: the Brain keeps
 * every key it was given, and recall reads each key's kind back
 * (`sourceRefOf`), so a kind gone from this list would fail every recall
 * whose results hold one of its sources.
 */
const producerKinds = kindsWithoutColon(["upload", "chat"]);

/** Who adds a source: one of `producerKinds`. */
export type ProducerKind = (typeof producerKinds)[number];

/** The longest a kind's prefix of a source key can be. */
const longestPrefix = Math.max(...producerKinds.map((kind) => kind.length)) + 1;

/** Control characters: never part of an id or a change's key. */
const controlCharacters = /\p{Cc}/u;

/** An id or key from a producer: some characters, none of them control. */
const producerIdSchema = (most: number) =>
  wellFormedString()
    .min(1)
    .max(most)
    .refine((id) => !controlCharacters.test(id), {
      message: "Holds a control character",
    });

/**
 * A source, as its producer names it: its kind, and its own id for it.
 * The id is generated by the server (an upload's or a chat's id), never
 * taken from what a person typed.
 */
const sourceRefSchema = z.strictObject({
  producer: z.enum(producerKinds),
  id: producerIdSchema(sourceIdMaxLength - longestPrefix),
});

/** A source, as its producer names it. */
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * The Brain's key for `source`: its producer's kind first, so no producer
 * names a key under another's kind, whatever its id holds.
 */
const sourceKeyOf = ({ producer, id }: SourceRef): SourceId =>
  `${producer}:${id}`;

/** `key` as the source its producer named: the reverse of `sourceKeyOf`. */
const sourceRefOf = (key: SourceId): SourceRef => {
  const colon = key.indexOf(":");
  return checked(sourceRefSchema, {
    producer: key.slice(0, colon),
    id: key.slice(colon + 1),
  });
};

/** A change's key, from its producer: see `addSource`. */
const changeSchema = producerIdSchema(sourceIdMaxLength);

const newSourceSchema = z.strictObject({
  source: sourceRefSchema,
  change: changeSchema,
  text: wellFormedString(),
  readers: sourceReadersSchema,
});

const versionRefSchema = z.strictObject({
  source: sourceRefSchema,
  version: z.int().positive(),
});

/** A version of a source, as an add answers. */
export interface SourceVersionRef {
  source: SourceRef;
  version: number;
}

/** A passage of a source's current version, as recall finds it. */
export interface RecalledChunk extends SourceVersionRef {
  text: string;
}

/** A version of a source, whole. */
export interface SourceVersion extends SourceVersionRef {
  text: string;
  addedAt: Date;
}

type BrainEnv = Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">;

/** The Brain, in its store in core's jurisdiction. */
const brain = (env: BrainEnv): Brain =>
  brainOf(inJurisdiction(env, env.BRAIN_STORE));

/**
 * A team, as the Brain's group: named by kind, so no other kind of group
 * core names later can take its name. Its ID is checked first, whether a
 * caller passed it or core's own records hold it.
 */
const teamGroup = (teamId: string): string =>
  `${teamPrefix}${checked(idSchema, teamId)}`;

const accessOf = (readers: SourceReaders): Access => {
  switch (readers.kind) {
    case "owner": {
      return { kind: "owner", person: readers.personId };
    }
    case "team": {
      return { kind: "audience", group: teamGroup(readers.teamId) };
    }
    case "none": {
      return { kind: "none" };
    }
    default: {
      throw new Error("Unknown readers");
    }
  }
};

/**
 * `personId` as the Brain's reader: the person, and the teams core counts
 * them in now. Refused once they have no current membership.
 */
const readerOf = async (
  env: Pick<Env, "DB">,
  personId: string
): Promise<Reader> => {
  const member = await memberOf(env.DB, checked(idSchema, personId));
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return {
    person: member.userId,
    groups: member.teams.map(({ id }) => teamGroup(id)),
  };
};

/**
 * Adds `text` to the Brain as a version of `source` that `readers` may
 * read; it replaces the version before in recall, which stays as history.
 *
 * `change` names this one change, unique per source: an upstream
 * revision, a message id, or an id minted before the first try. Repeat an
 * add with the same `change` (after a lost reply, at once or much later)
 * and it answers with the version it first made, whatever came since; the
 * same `change` with other text or readers is refused (which tells the
 * producer the text or readers differ from that change's: producers are
 * the server's own code). A new `change` with the same text and readers
 * as the current version is that version.
 *
 * For producers on the server only: `source.id` and `change` come from
 * the server, never from a person's input. An id is not a secret within
 * its kind (an upload's id is seen by those who can see the upload), so
 * a producer checks that whoever asks for the change may change that
 * source before it calls this; the Brain can't tell.
 */
export const addSource = async (
  env: BrainEnv,
  added: {
    source: SourceRef;
    change: string;
    text: string;
    readers: SourceReaders;
  }
): Promise<SourceVersionRef> => {
  const { source, change, text, readers } = checked(newSourceSchema, added);
  const { version } = await brain(env).addSource({
    source: sourceKeyOf(source),
    change,
    text,
    access: accessOf(readers),
  });
  return { source, version };
};

/**
 * What the member `personId` may read of the current versions' passages
 * holding `question`'s words, best first, as core counts them now.
 * Refused once they are no longer a member, or when `personId` isn't an
 * ID.
 */
export const recallAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  question: string
): Promise<{ chunks: RecalledChunk[] }> => {
  const { chunks } = await brain(env).recall({
    question,
    reader: await readerOf(env, personId),
  });
  return {
    chunks: chunks.map(({ source, version, text }) => ({
      source: sourceRefOf(source),
      version,
      text,
    })),
  };
};

/**
 * Version `version` of `source`, current or history, whole, for the
 * member `personId`: only if they are among that version's readers and
 * the current version's, so narrowing a source's readers hides its
 * history from those taken off. Both are read with the teams core counts
 * them in now: someone who joins a team reads the history that team
 * could read from before they joined. `null` when there is none or they
 * may not, alike. Refused once they are no longer a member. For the
 * server only, as `addSource`.
 */
export const readSourceVersionAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: { source: SourceRef; version: number }
): Promise<SourceVersion | null> => {
  const { source, version } = checked(versionRefSchema, wanted);
  const read = await brain(env).readVersion({
    source: sourceKeyOf(source),
    version,
    reader: await readerOf(env, personId),
  });
  return read === null
    ? null
    : { source, version, text: read.text, addedAt: read.addedAt };
};

// Instruction files: what people write for every chat to start with (the
// company's instructions and lasting facts, a person's own file, an App's
// and an agent's), each a source of its own under `instructions:`, kept
// whole and versioned, never indexed, so recall never returns one. Who
// may read each in the Brain: a person's file, that person; an App's, the
// App's group, which core puts in a reader only once they passed the
// builder check; the company's and agents', the company. Which of them
// reaches which chat or run, and who may write each, is
// instruction-files.ts's rule; the functions here only name them for the
// Brain.

/** Every current member is in this group, and in no other way. */
const companyGroup = "company";

/** An App's group: only for a reader who builds the App. */
const appGroup = (appId: string): string => `app:${appId}`;

/** The longest prefix of an instruction file's key. */
const instructionKeyPrefixMax = `${instructionsKind}:person:`.length;

/**
 * The ID in an instruction file's key: never empty, no control
 * characters, the key in bounds.
 */
const instructionIdSchema = producerIdSchema(
  sourceIdMaxLength - instructionKeyPrefixMax
);

/**
 * An instruction file, by its scope: one of the company's two (its
 * instructions, and its lasting facts), one person's, one App's or one
 * agent's.
 */
const instructionFileSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("company"),
    name: z.enum(["instructions", "facts"]),
  }),
  z.strictObject({
    scope: z.literal("person"),
    personId: idSchema.pipe(instructionIdSchema),
  }),
  z.strictObject({ scope: z.literal("app"), appId: instructionIdSchema }),
  z.strictObject({ scope: z.literal("agent"), agentId: instructionIdSchema }),
]);

/** An instruction file, by its scope. */
export type InstructionFile = z.infer<typeof instructionFileSchema>;

/**
 * `input` as an instruction file, checked whole: refused with
 * `permission.invalid` when it isn't one. For instruction-files.ts, which
 * checks who may write a file before it is added.
 */
export const instructionFileOf = (input: unknown): InstructionFile =>
  permissionErrors.parse("permission.invalid", instructionFileSchema, input);

/** The Brain's key for `file`: its scope is part of it. */
const instructionKeyOf = (file: InstructionFile): SourceId => {
  switch (file.scope) {
    case "company": {
      return `${instructionsKind}:company:${file.name}`;
    }
    case "person": {
      return `${instructionsKind}:person:${file.personId}`;
    }
    case "app": {
      return `${instructionsKind}:app:${file.appId}`;
    }
    case "agent": {
      return `${instructionsKind}:agent:${file.agentId}`;
    }
    default: {
      throw new Error("Unknown instruction file");
    }
  }
};

/** Who may read `file` in the Brain (above). */
const instructionAccessOf = (file: InstructionFile): Access => {
  switch (file.scope) {
    case "person": {
      return { kind: "owner", person: file.personId };
    }
    case "app": {
      return { kind: "audience", group: appGroup(file.appId) };
    }
    case "company":
    case "agent": {
      return { kind: "audience", group: companyGroup };
    }
    default: {
      throw new Error("Unknown instruction file");
    }
  }
};

const newInstructionsSchema = z.strictObject({
  file: instructionFileSchema,
  change: changeSchema,
  text: instructionsTextSchema,
});

/** A version of an instruction file, whole. */
export interface InstructionFileVersion {
  file: InstructionFile;
  version: number;
  text: string;
  addedAt: Date;
}

/**
 * Adds `text` as the next version of the instruction file `file`; the one
 * before stays as history. Refused over `instructionsMaxLength` UTF-16
 * units with `instructions.too_large`, and with no text. `change` is as
 * `addSource`'s.
 *
 * For instruction-files.ts only, which checks who may write `file` first:
 * nothing here does.
 */
export const addInstructionFile = async (
  env: BrainEnv,
  added: { file: InstructionFile; change: string; text: string }
): Promise<{ file: InstructionFile; version: number }> => {
  if (typeof added.text === "string" && isOverInstructionsLimit(added.text)) {
    throw instructionFileErrors.create("instructions.too_large", {
      maxLength: instructionsMaxLength,
    });
  }
  const { file, change } = checked(newInstructionsSchema, added);
  const { version } = await brain(env).addInstructions({
    source: instructionKeyOf(file),
    change,
    text: added.text,
    access: instructionAccessOf(file),
  });
  return { file, version };
};

const instructionFilesSchema = z
  .array(instructionFileSchema)
  .max(currentReadMax);

/**
 * The current version of each of `wanted` that `member` may read, whole,
 * in the order given: their own file, the company's and agents', and the
 * App `builtApp`'s, never another person's or another App's. A file never
 * written is left out.
 *
 * For instruction-files.ts only, which picks the files a context gets,
 * reads `member` from core's records, and passes `builtApp` only once
 * they passed its builder check: both are taken here on the caller's
 * word, so no other code may call it. (Exported only because core's
 * Brain contract is reachable from this file alone.)
 */
export const readInstructionFilesAs = async (
  env: BrainEnv,
  member: Pick<Member, "userId">,
  wanted: InstructionFile[],
  builtApp?: string
): Promise<InstructionFileVersion[]> => {
  const files = checked(instructionFilesSchema, wanted);
  // An instruction file is never a team's, so its reader is the person,
  // the company and the App they build, if any.
  const groups =
    builtApp === undefined
      ? [companyGroup]
      : [companyGroup, appGroup(checked(instructionIdSchema, builtApp))];
  const byKey = new Map(files.map((file) => [instructionKeyOf(file), file]));
  const read = await brain(env).readCurrent({
    sources: [...byKey.keys()],
    reader: { person: checked(idSchema, member.userId), groups },
  });
  return read.flatMap(({ source, version, text, addedAt }) => {
    const file = byKey.get(source);
    return file === undefined ? [] : [{ file, version, text, addedAt }];
  });
};

/**
 * The gateway's refusals of a call as it is: the item's own failure. Every
 * other failure is of the way to a model, which the whole queue waits out.
 * `model.request_refused` is a provider refusing the request itself (a
 * 4xx other than its key, credit or rate: a bad request, a prompt too
 * long, a content policy), on any key. `model.failed` is not the item's:
 * on Grasp's key it is any failure of the provider, and it is connect
 * out of reach.
 */
const itemRefusals: ReadonlySet<string> = new Set<ModelErrorCode>([
  "model.invalid_call",
  "model.answer_too_long",
  "model.invalid_output",
  "model.request_refused",
]);

/**
 * The gateway's failures that need someone at the AI account: no model
 * set up or allowed, a key refused or revoked. Out of credit comes as a
 * rate limit with no wait to keep (`waitOf`).
 */
const accountTroubles: ReadonlySet<string> = new Set<ModelErrorCode>([
  "model.no_provider",
  "model.unconfigured",
  "model.not_allowed",
  "model.provider_key_failed",
  // Grasp's AI used up for the month: until the next month, or the
  // organization's own key.
  "model.grasp_limit_reached",
]);

/**
 * Room past the call's own time for the gateway's deadline: the call's
 * signal ends it first, so a call cut off is never taken for anything
 * else.
 */
const gatewayGraceMs = 5000;

/** What `error` of the gateway asks the queue to wait for, and why. */
const waitOf = (error: unknown): ModelReply => {
  const code = modelErrors.codeOf(error);
  if (code !== undefined && accountTroubles.has(code)) {
    return { kind: "busy", reason: "account" };
  }
  if (code !== "model.rate_limited") {
    return { kind: "busy", reason: "unavailable" };
  }
  const wait = isExpectedError(error)
    ? error.details?.retryAfterSeconds
    : undefined;
  // A rate limit names its wait; an account out of credit names none.
  return typeof wait === "number" && wait > 0
    ? {
        kind: "busy",
        reason: "rate_limited",
        retryAfterSeconds: Math.min(wait, modelWaitMaxSeconds),
      }
    : { kind: "busy", reason: "account" };
};

/**
 * The Brain's background work asking a model, through core's gateway like
 * every model call: the organization's model and key, judged as core's own
 * upkeep of the Brain (`brain_upkeep`), metered and audited, and cancelled
 * once the time the queue gave it is up (`timed_out`). One call is one
 * request: when the provider limits calls or the way to a model fails, the
 * gateway doesn't wait and retry; the whole queue pauses instead (`busy`).
 * The gateway's refusal of the call as it is fails the item (`refused`):
 * no provider's or gateway's words reach the Brain.
 */
const askModel =
  (env: Env): AskModel =>
  async ({ purpose, system, input, timeoutMs }) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const { text } = await models(env).call({
        model: modelForRole(await modelSettings(env), "careful"),
        system,
        input,
        purpose,
        trigger: { type: "system" },
        work: { platform: "brain_upkeep" },
        providerRetries: false,
        timeoutMs: timeoutMs + gatewayGraceMs,
        signal,
      });
      return { kind: "answer", text };
    } catch (error) {
      if (signal.aborted) {
        // No answer within the call's time, which is the item's: its own.
        return { kind: "timed_out" };
      }
      const code = modelErrors.codeOf(error);
      if (code !== undefined && itemRefusals.has(code)) {
        return { kind: "refused" };
      }
      return waitOf(error);
    }
  };

/**
 * One tick of the Brain's background work at `at`, the time core's clock
 * runs it: the store sweeps what adds that never finished left, repacks a
 * few blocks of vector codes, then runs what is due in its queue, its
 * model calls through core's gateway. Harmless late or twice.
 */
export const workBrain = async (env: Env, at: Date): Promise<void> => {
  await brain(env).work(askModel(env), at);
};

/** The Brain's work queue, as staff will see it (GRA-1733). */
export const brainWorkOverview = async (env: BrainEnv): Promise<WorkOverview> =>
  await brain(env).workOverview();
