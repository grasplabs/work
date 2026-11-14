/**
 * Every way into the Brain, as the leak harness probes it
 * (brain-next-leaks.test.ts). A probe calls one surface every way it can
 * answer as a reader who may not read the marked sources: finding
 * something, finding nothing, refusing. It returns all that came back; the
 * harness looks for the markers in that, in the logs written meanwhile and
 * in what reached a model, and holds each answer to what the reader asked
 * only of hidden sources to the answer to words nothing holds.
 *
 * One registry, `brainSurfaces` at the end of this file, names each way
 * in: a module (or the store's class) and its probes, one per member:
 * `coreProbes` one per export of core's `brain-next.ts`,
 * `instructionProbes` one per export of core's `instruction-files.ts` (the
 * rules over the instruction files brain-next.ts names), `recallProbes`
 * one per export of core's `brain-recall.ts` (code's recall), `storeProbes` one
 * per public method of the Brain's store (its contract, and anything else
 * a holder of its namespace could call), `sourcesProbes` one per method of
 * the Brain's Sources page's RPC (`session.brainSources`, as the signed-in
 * person). A member without a probe fails
 * the type check and the harness; a module of core that imports
 * brain-next.ts fails lint unless brain-next-modules.ts names its surface
 * here. A new member is one more probe in its list; a new module is its
 * list, its entry in the registry and its line in brain-next-modules.ts.
 * A probe:
 *
 * - one that answers about a single item probes it with `hiddenVersions`;
 * - one with no reader (an overview, a step the clock runs) ignores the
 *   reader: what it returns, logs or sends a model must hold no marker in
 *   any pass.
 */
import {
  brainOf,
  currentReadMax,
  handOversMax,
  instructionsMaxLength,
  listPageMax,
  listPrefixesMax,
  modelNameMaxLength,
  personalBrainOf,
  questionMaxLength,
  readableCheckMax,
  readerGroupsMax,
  recallBudgetMax,
  sourceTextMaxBytes,
  vectorModelNameOf,
  vectorSearchLimitMax,
  vectorsPerPutMax,
} from "@grasp-os/brain-next/contract";
import type {
  Access,
  Brain,
  EntitiesRequest,
  NewEntity,
  NewMemory,
  ChunkRef,
  EmbedModel,
  ErasureReason,
  Embedders,
  HandOvers,
  Reader,
  VectorModel,
  VectorsToPut,
} from "@grasp-os/brain-next/contract";
import {
  defineWork,
  enqueueWork,
  workAttemptsMax,
} from "@grasp-os/brain-next/work";
import {
  chatIdSchema,
  permissionIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { runInDurableObject } from "cloudflare:test";
import { DurableObject, env } from "cloudflare:workers";
import { z } from "zod";

import { embedInProcess } from "../../../packages/embed/test/test-models.ts";
import { BrainMemoriesRpc } from "../src/brain-memories-rpc.ts";
import * as brainMemories from "../src/brain-memories.ts";
import * as coreBrain from "../src/brain-next.ts";
import type {
  InstructionFile,
  InstructionFileVersion,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import * as codeRecall from "../src/brain-recall.ts";
import * as brainSkills from "../src/brain-skills.ts";
import { BrainSourcesRpc } from "../src/brain-sources-rpc.ts";
import { producersOf } from "../src/brain-sources.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { BrainStore } from "../src/index.ts";
import * as instructionFiles from "../src/instruction-files.ts";
import { shippedSkills } from "../src/shipped-skills.ts";
import * as skillShares from "../src/skill-shares.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { noProducers } from "./no-producers.ts";

/** The reader a probe calls as, and what they may not see. */
export interface Probing {
  /** The reader, a member of the organization, as core names them. */
  personId: string;
  /**
   * The same reader as the Brain's contract takes them: the person and
   * their teams as core names its groups (`team:<id>`, core's
   * brain-next.ts).
   */
  reader: Reader & { person: string };
  /**
   * Whether core's recall reads the reader's own store too, as their own
   * web chat does, or the shared store alone, as an App's does.
   */
  personal: boolean;
  /** A word in the reader's own source and in every marked one. */
  sharedWord: string;
  /**
   * Words only in sources the reader may not read. Probes ask for them
   * and put them in what they add, so a value echoed anywhere shows.
   */
  markers: readonly string[];
  /**
   * Versions of sources the reader may not read, each of which must
   * answer exactly as a source no one added: every version of someone
   * else's, a team's they aren't in, one nobody may read; and a version
   * whose readers they were never among, or were taken off since.
   */
  hiddenVersions: readonly { source: SourceRef; version: number }[];
  /**
   * Instruction files the reader may not read, each holding every marker
   * (instruction-files.ts): another person's, another agent's, an App's
   * they don't build, or, to someone who isn't a member, the company's.
   * Each must answer exactly as a file never written.
   */
  hiddenInstructionFiles: readonly InstructionFile[];
  /**
   * Two Apps the reader uses and doesn't build (core's own records), one
   * whose file holds every marker and one with none: each asked of must
   * answer exactly as the other. Absent when the reader builds them.
   */
  usedApps?: { withFile: string; withoutFile: string };
  /**
   * The groups the instruction files are written for (the company's, and
   * each App's), which a reader holds only once core let them: a recall
   * holding them must still find no instruction file, as none is indexed.
   */
  instructionGroups: readonly string[];
  /**
   * The teams the App grant of code's recall names (GRA-1842): its recall
   * reads, of these, the reader's alone. None when absent.
   */
  codeTeams?: readonly string[];
  /**
   * Names of skills someone else wrote for themselves, each a marker,
   * in their own store (brain-next.ts): each asked of as the reader's own
   * must answer exactly as its twin, a skill no one wrote.
   */
  hiddenSkills?: readonly string[];
  /**
   * Moments a recall asks as of besides the first and now: when a marked
   * version the reader could read then was its source's current one, so
   * "as of" is held to what they may read now.
   */
  moments?: readonly Date[];
}

/** One call a probe made, and what came back. */
export interface Answer {
  /** What was called, for a failure. */
  call: string;
  /** Its value, or everything its error carried. */
  got: { value: unknown } | { error: unknown };
  /**
   * `hidden`: asked only of what the reader may not read; `nothing`: asked
   * of what nothing holds. Every `hidden` answer of a probe must equal the
   * `nothing` answer of the same `like` exactly.
   */
  about?: "hidden" | "nothing";
  /**
   * Which comparison a `hidden` or `nothing` answer belongs to, when a
   * probe makes several: the probe's default one when absent.
   */
  like?: string;
}

/** Calls one surface every way it can answer; returns what came back each time. */
export type Probe = (probing: Probing) => Promise<Answer[]>;

/**
 * Every key of `value`: its own, named or Symbol, and for an error those
 * its prototypes define as far as `Error.prototype`, so a getter of an
 * error's class is read too.
 */
const keysOf = (value: object): PropertyKey[] => {
  const keys = new Set<PropertyKey>(Reflect.ownKeys(value));
  if (value instanceof Error) {
    for (
      let prototype: unknown = Object.getPrototypeOf(value);
      typeof prototype === "object" && prototype !== null;
      prototype =
        prototype === Error.prototype ? null : Object.getPrototypeOf(prototype)
    ) {
      for (const key of Reflect.ownKeys(prototype)) {
        keys.add(key);
      }
    }
  }
  keys.delete("constructor");
  return [...keys];
};

/** `value[key]`, or what reading it threw. */
const fieldOf = (value: object, key: PropertyKey): unknown => {
  try {
    return Reflect.get(value, key);
  } catch (error) {
    return { "[threw]": error };
  }
};

/** Bytes as text, so words in them show. */
const decoded = (bytes: ArrayBuffer | ArrayBufferView): string =>
  new TextDecoder().decode(bytes);

/**
 * `value` as plain data, every part of it opened up, however deep: an
 * error's name, message and stack, every key of an object (enumerable or
 * not, Symbol keys too) and the getters of an error's class, followed
 * into whatever they hold (`cause` after `cause`, an AggregateError's
 * `errors`); the entries of a Map or Set; bytes as text; a bigint, symbol
 * or function by what it says. An object met again (a `cause` that
 * points back) is written "[cycle]".
 */
const unfolded = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "function") {
    return `[function ${value.name}]`;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return "[cycle]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item: unknown) => unfolded(item, seen));
  }
  if (value instanceof Map) {
    return {
      "[Map]": [...value].map(([key, item]: [unknown, unknown]) => [
        unfolded(key, seen),
        unfolded(item, seen),
      ]),
    };
  }
  if (value instanceof Set) {
    return { "[Set]": [...value].map((item: unknown) => unfolded(item, seen)) };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return { "[bytes]": decoded(value) };
  }
  if (value instanceof Date) {
    return String(value);
  }
  return Object.fromEntries(
    keysOf(value).map((key) => [
      String(key),
      unfolded(fieldOf(value, key), seen),
    ])
  );
};

/**
 * `value` as text, every part of it opened up (`unfolded`): the one way
 * the harness reads anything for a marker, whether an answer, a log line
 * or a request to a model.
 */
export const textOf = (value: unknown): string =>
  JSON.stringify(unfolded(value)) ?? "";

/** Calls `call` and keeps what came back as an answer. */
const answer = async (
  callName: string,
  call: () => Promise<unknown>,
  about?: Answer["about"],
  like?: string
): Promise<Answer> => {
  const compared = like === undefined ? {} : { like };
  try {
    return { call: callName, got: { value: await call() }, about, ...compared };
  } catch (error) {
    return {
      call: callName,
      got: { error: unfolded(error) },
      about,
      ...compared,
    };
  }
};

/**
 * `value` as a type it isn't: what a caller outside TypeScript could hand
 * a surface.
 */
const unchecked = (value: unknown): never =>
  // SAFETY: the surfaces check what they are given; probes hand them what
  // the type rules out, as a call from outside TypeScript could.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** Someone none of the harness's readers is. */
const stranger = (): string => `stranger-${crypto.randomUUID()}`;

/** A source's text holding every marker. */
const markedText = (markers: readonly string[]): string =>
  `Withheld ${markers.join(" ")}`;

/** The same text, past the most bytes a source may have. */
const oversizedText = (markers: readonly string[]): string =>
  markedText(markers).padEnd(sourceTextMaxBytes + 1, " x");

/**
 * A marker's twin: a word of the same length and the same kinds of
 * character (digits for digits, letters for letters), which no source
 * holds. A question asked with the twins in place of the markers is the
 * question as it would be asked of a store where the marked sources don't
 * exist: its pack must be the same, but for the words themselves.
 */
const twinOf = (marker: string): string =>
  `u${Array.from(marker.slice(1), (character: string) =>
    /\d/u.test(character)
      ? String((Number(character) + 5) % 10)
      : String.fromCodePoint((character.codePointAt(0) ?? 0) + 6)
  ).join("")}`;

/** A question built on words: the markers, or their twins. */
interface Asked {
  name: string;
  text: (words: readonly string[]) => string;
  budget?: number;
  asOf?: Date;
}

/** What a pack is asked for in a probe. */
interface PackAsk {
  question: string;
  budget: { tokens: number };
  asOf?: Date;
}

/** The first of `words`. */
const first = (words: readonly string[]): string => words[0] ?? "";

/**
 * Questions on the markers, each asked again of their twins (`twinOf`):
 * the markers alone, as search syntax, a prefix of one, one inside an ID,
 * two quoted as a phrase, beside a date, beside the shared word (which
 * finds the reader's own source) at budgets that cut it short and one that
 * doesn't, and as of each of `moments`.
 */
const askedOf = (
  { sharedWord }: Probing,
  moments: readonly Date[]
): Asked[] => {
  const withShared = (words: readonly string[]): string =>
    `${sharedWord} ${words.join(" ")}`;
  return [
    { name: "the markers", text: (words) => words.join(" ") },
    {
      name: "the markers as search syntax",
      text: (words) =>
        `${first(words)}* OR "${words.join(" ")}" NEAR(${words.join(" ")}) text:${first(words)} ^${first(words)}`,
    },
    { name: "a marker's prefix", text: (words) => first(words).slice(0, -1) },
    { name: "a marker in an ID", text: (words) => `INV-${first(words)}-2026` },
    {
      name: "two markers quoted",
      text: (words) => `"${words.slice(0, 2).join(" ")}"`,
    },
    {
      name: "the markers and a date",
      text: (words) => `${words.join(" ")} 14 maart 2026`,
    },
    { name: "the shared word and the markers", text: withShared },
    ...[1, 40].map((tokens) => ({
      name: `the shared word and the markers in ${tokens} tokens`,
      text: withShared,
      budget: tokens,
    })),
    ...moments.flatMap((asOf) => [
      {
        name: `the markers as of ${asOf.toISOString()}`,
        text: (words: readonly string[]) => words.join(" "),
        asOf,
      },
      {
        name: `the shared word and the markers as of ${asOf.toISOString()}`,
        text: withShared,
        asOf,
      },
    ]),
  ];
};

/**
 * `answered` with every `words` (markers or twins, and their prefixes) in
 * its pack's `notFound` written as its place in the list: the question's
 * own words, echoed back, so a pack asked of the markers compares with
 * one asked of their twins. Nothing else of the answer is touched: a
 * marker anywhere else is still found.
 */
const echoesHidden = (answered: Answer, words: readonly string[]): Answer => {
  const { got } = answered;
  if (
    !("value" in got) ||
    typeof got.value !== "object" ||
    got.value === null
  ) {
    return answered;
  }
  const value: object = got.value;
  const notFound: unknown = Reflect.get(value, "notFound");
  if (!Array.isArray(notFound)) {
    return answered;
  }
  const named = [
    ...words.map((word, index) => [word, `{${index}}`] as const),
    ...words.map((word, index) => [word.slice(0, -1), `{${index}-}`] as const),
  ];
  const echoed = notFound.map((entry: unknown) => {
    if (typeof entry !== "string") {
      return entry;
    }
    let text = entry.toLowerCase();
    for (const [word, name] of named) {
      text = text.replaceAll(word, name);
    }
    return text;
  });
  return { ...answered, got: { value: { ...value, notFound: echoed } } };
};

/**
 * Asks `ask` every question of `askedOf`, of the markers (`hidden`) and of
 * their twins (`nothing`), each pair compared by its name.
 */
const askedOfMarkers = async (
  probing: Probing,
  moments: readonly Date[],
  ask: (asking: PackAsk) => Promise<unknown>
): Promise<Answer[]> => {
  const twins = probing.markers.map(twinOf);
  const asked: Answer[] = [];
  for (const { name, text, budget, asOf } of askedOf(probing, moments)) {
    for (const [about, words] of [
      ["hidden", probing.markers],
      ["nothing", twins],
    ] as const) {
      const asking: PackAsk = {
        question: text(words),
        budget: { tokens: budget ?? recallBudgetMax },
        ...(asOf === undefined ? {} : { asOf }),
      };
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      const answered = await answer(
        `${name}${about === "nothing" ? ", of twins" : ""}`,
        async () => await ask(asking),
        about,
        name
      );
      asked.push(echoesHidden(answered, words));
    }
  }
  return asked;
};

/**
 * The moments a probe asks as of: before anything was added, the
 * reader's own (`Probing.moments`: when a marked version was current and
 * the reader among its readers), and now.
 */
const momentsOf = (probing: Probing): Date[] => [
  new Date(0),
  ...(probing.moments ?? []),
  new Date(),
];

/** The Brain's store, as the harness reaches it: by its contract. */
const store = (): Brain => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A source no one added. */
const missingSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

/** `source`'s key in the store, as core names it (core's brain-next.ts). */
const keyOf = ({ producer, id }: SourceRef): string => `${producer}:${id}`;

/**
 * A change added twice to a source no one else has: the second time with
 * the markers in its text, which the Brain refuses. The refusal says only
 * that the change was added with other text or readers, nothing of them.
 */
const refusedChange = async (markers: readonly string[]): Promise<Answer[]> => {
  const source = missingSource();
  const change = crypto.randomUUID();
  const readers: SourceReaders = { kind: "owner", personId: stranger() };
  return [
    await answer("a change, first", async () => {
      await coreBrain.addSource(env, {
        source,
        change,
        text: "First",
        readers,
      });
    }),
    await answer(
      "the same change again with the markers",
      async () =>
        await coreBrain.addSource(env, {
          source,
          change,
          text: markedText(markers),
          readers,
        })
    ),
  ];
};

/** Adds as `producer` under `id`: the version it answers with. */
const addAs = async (
  producer: SourceRef["producer"],
  id: string
): Promise<number> => {
  const { version } = await coreBrain.addSource(env, {
    source: { producer, id },
    change: crypto.randomUUID(),
    // The same text and readers every pass: a later pass's add is the
    // version the first made, so every pass answers alike.
    text: "Another producer's own",
    readers: { kind: "none" },
  });
  return version;
};

/**
 * Adds as another producer kind, with a hidden source's id and with one no
 * one added: the version each answers with must be the same (a first), so
 * no producer learns what another kind holds under that id. Never as the
 * hidden source's own kind, which would add to the source itself (one an
 * erasure closed refuses that, as it should).
 */
const otherKindOf = async (
  hiddenVersions: Probing["hiddenVersions"]
): Promise<Answer[]> => {
  const hidden = [
    ...new Map(
      hiddenVersions.map(({ source }) => [keyOf(source), source])
    ).values(),
  ];
  return [
    await answer(
      "another kind, an id no one added",
      async () => await addAs("chat", crypto.randomUUID()),
      "nothing"
    ),
    ...(await Promise.all(
      hidden.map(
        async ({ producer, id }, index) =>
          await answer(
            `another kind, hidden source ${index}'s id`,
            async () =>
              await addAs(producer === "chat" ? "upload" : "chat", id),
            "hidden"
          )
      )
    )),
  ];
};

/**
 * Times a tick is asked for, and with it the sweep it starts with: now,
 * far ahead, and long ago. The sweep runs as of `min(at, now)`, and no
 * file is left over past its grace while the harness runs, so these
 * sweeps delete nothing: they hold a sweep with nothing due to answer,
 * log and prompt nothing of a marker. A sweep that deletes is covered by
 * brain-next-sources.test.ts.
 */
const sweepTimes = (): Date[] => [
  new Date(),
  new Date(Date.now() + 365 * 86_400_000),
  new Date(0),
];

/** An instruction file's key in the store, as core names it (core's brain-next.ts). */
const instructionKeyOf = (file: InstructionFile): string => {
  switch (file.scope) {
    case "company": {
      return `instructions:company:${file.name}`;
    }
    case "person": {
      return `instructions:person:${file.personId}`;
    }
    case "app": {
      return `instructions:app:${file.appId}`;
    }
    case "agent": {
      return `instructions:agent:${file.agentId}`;
    }
    default: {
      throw new Error("Unknown instruction file");
    }
  }
};

/** A person's instruction file no one wrote. */
const unwrittenFile = (): InstructionFile => ({
  scope: "person",
  personId: stranger(),
});

/** An agent of the reader's, with a file of its own nobody wrote. */
const readersAgent = (personId: string): Authority =>
  authoritySchema.parse({
    subject: { type: "agent", agentId: `agent-${crypto.randomUUID()}` },
    onBehalfOf: personId,
    mode: "interactive",
  });

/**
 * `call` for each of someone else's own skills (`hidden`, each a marker)
 * and for its twin, a skill no one wrote: each pair compared, so the
 * hidden one must answer exactly as its twin.
 */
const pairedOverSkills = async (
  hidden: readonly string[] | undefined,
  call: (name: string) => Promise<unknown>
): Promise<Answer[]> => {
  const ask = async (like: string, name: string, about: Answer["about"]) =>
    await answer(like, async () => await call(name), about, like);
  const answers: Answer[] = [];
  for (const [index, name] of (hidden ?? []).entries()) {
    const like = `someone else's own skill ${index}`;
    const pair = [
      [name, "hidden"],
      [twinOf(name), "nothing"],
    ] as const;
    // One call site for both, so a stack differs in nothing but what was
    // asked.
    for (const [asked, about] of pair) {
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time
      answers.push(await ask(like, asked, about));
    }
  }
  return answers;
};

/** The code of `error`, as a comparison holds it. */
const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : "an error with no code";

/**
 * What `call` gave, as two answers that must be alike are compared: the
 * files it gave (which, not their text, so the markers are found by the
 * scan instead) and, of them, only those `keep` keeps; or the code it was
 * refused with. A refusal is an answer like any other: it must be the
 * same whether the hidden file exists or not.
 */
const filesOutcome = async (
  call: () => Promise<InstructionFileVersion[]>,
  keep: (file: InstructionFile) => boolean = () => true
): Promise<unknown> => {
  try {
    const files = await call();
    return { files: files.flatMap(({ file }) => (keep(file) ? [file] : [])) };
  } catch (error) {
    return { refused: codeOf(error) };
  }
};

/** The code `call` was refused with, or `null` when it wasn't. */
const refusalOf = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
    return { refused: null };
  } catch (error) {
    return { refused: codeOf(error) };
  }
};

/**
 * The words `call` was refused with, or `null` when it wasn't: for a
 * refusal of the Brain's own, which carries no code, as two answers that
 * must be alike are compared.
 */
const refusedWith = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
    return { refused: null };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : "not an error" };
  }
};

/** `personId`'s session, as the RPC layer builds an `Identity`. */
const sessionOf = (personId: string): Identity => ({
  userId: personId,
  email: "reader@acme.test",
  name: "Reader",
  role: "user",
  teams: [],
  staff: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/**
 * The hidden App files of `probing` the reader has no part in: Apps no one
 * made, which answer as one no one made.
 */
const hiddenAppsOf = ({
  hiddenInstructionFiles,
  usedApps,
}: Probing): string[] =>
  hiddenInstructionFiles.flatMap((file) =>
    file.scope === "app" &&
    file.appId !== usedApps?.withFile &&
    file.appId !== usedApps?.withoutFile
      ? [file.appId]
      : []
  );

/** The hidden files of `probing` of `scope`: their ids. */
const hiddenIdsOf = (
  { hiddenInstructionFiles }: Probing,
  scope: "agent" | "person"
): string[] =>
  hiddenInstructionFiles.flatMap((file) => {
    if (scope === "agent") {
      return file.scope === "agent" ? [file.agentId] : [];
    }
    return file.scope === "person" ? [file.personId] : [];
  });

/** The kinds of conversation a context names. */
const conversations = ["own", "direct", "channel"] as const;
/**
 * Work whose items carry the markers and whose handler fails with them in
 * its error, so the queue's surfaces show whether either gets out: its
 * overview keeps only its own codes, never a payload or a handler's words.
 * It never asks a model, so a marker in a prompt would be the queue's own.
 */
const markedWork = defineWork({
  kind: `probe.marked_${crypto.randomUUID().replaceAll("-", "")}`,
  payload: z.strictObject({ marked: z.string() }),
  timeLimitMs: 1000,
  run: async ({ marked }) => {
    await Promise.resolve();
    throw new Error(`Could not read ${marked}`);
  },
});

/** The queue's own time for the probes: only forward, a day a tick. */
const queueClock = { at: Date.now() };
const nextDay = (): Date => {
  queueClock.at = Math.max(queueClock.at, Date.now()) + 24 * 60 * 60_000;
  return new Date(queueClock.at);
};

/**
 * Adds an item of `markedWork` that carries the markers (its key doesn't:
 * a key is an ID staff see), and works it through `tick` until it is
 * parked, its failure the handler's words.
 */
const workMarked = async (
  markers: readonly string[],
  tick: (at: Date) => Promise<unknown>,
  name: string
): Promise<Answer[]> => {
  await runInDurableObject(
    inJurisdiction(env, env.BRAIN_STORE).getByName("brain"),
    (_store, state) => {
      enqueueWork(state.storage, markedWork, {
        key: `probe-${crypto.randomUUID()}`,
        payload: { marked: markers.join(" ") },
        priority: "asked",
      });
    }
  );
  const ticked: Answer[] = [];
  for (let attempt = 0; attempt < workAttemptsMax; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick after another
    const answered = await answer(
      `${name}, tick ${attempt + 1}`,
      async () => await tick(nextDay())
    );
    ticked.push(answered);
  }
  return ticked;
};

/** The host's model, as a probe hands it: it answers, and holds nothing. */
const quietModel = async () => {
  await Promise.resolve();
  return { kind: "answer" as const, text: "" };
};

/**
 * The host's embedders as a probe hands them when embedding is not what it
 * probes: they run no model, so the store embeds nothing, and embedding's
 * items, its parked ones as they come back too, settle at once. A probe
 * whose subject is the queue or its overview ticks with these: ticking
 * with the failing ones instead (`leakyEmbedders`) would have every tick
 * walk the whole store onto the queue again and fail every passage, for
 * no case of its own.
 */
const noEmbedders: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

/** No hand-overs: these tests hand nothing over. */
const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

/**
 * The host's embedders, as a probe hands them: they run a model, and fail
 * every passage with the passages and the markers in their error, so
 * anything of an error that gets out shows.
 */
const leakyEmbedders = (markers: readonly string[]): Embedders => ({
  model: { name: "probe-model", build: "0" },
  embed: async ({ texts }) => {
    await Promise.resolve();
    throw new Error(`Could not embed ${[...texts, ...markers].join(" ")}`);
  },
});

/**
 * Adds an item of `markedWork` that carries the markers and parks it as
 * its last failure would, without a tick: its id. For the probes of
 * staff's surfaces, which read and put back parked items. Working it to
 * parking instead (`workMarked`) costs the harness a tick an attempt, each
 * of which works the whole store's queue, embedding's backlog with it,
 * and the harness runs every probe in every pass.
 */
const parkMarked = async (markers: readonly string[]): Promise<number> =>
  await runInDurableObject(
    inJurisdiction(env, env.BRAIN_STORE).getByName("brain"),
    (_store, state) => {
      const key = `probe-${crypto.randomUUID()}`;
      enqueueWork(state.storage, markedWork, {
        key,
        payload: { marked: markers.join(" ") },
        priority: "asked",
      });
      return state.storage.sql
        .exec<{ id: number }>(
          `UPDATE work_items SET parked_at = ?, parks = 1, attempts = ?,
            last_error = 'failed'
          WHERE kind = ? AND key = ? RETURNING id`,
          Date.now(),
          workAttemptsMax,
          markedWork.kind,
          key
        )
        .one().id;
    }
  );

/**
 * A marked item parked, then every way to put an item back: that item,
 * twice (the second finds it parked no more), an id nothing has, and ids
 * that aren't one, the markers among them. Only the item it parked:
 * putting back every parked item, embedding's among them, would have
 * each later tick of the harness work them all again.
 */
const requeueMarked = async (
  markers: readonly string[],
  requeue: (id: number) => Promise<unknown>
): Promise<Answer[]> => {
  const id = await parkMarked(markers);
  return [
    await answer("a requeue of the marked item", async () => await requeue(id)),
    await answer(
      "a requeue of the marked item again",
      async () => await requeue(id)
    ),
    await answer(
      "a requeue of an id nothing has",
      async () => await requeue(Number.MAX_SAFE_INTEGER)
    ),
    await answer("a requeue of 0", async () => await requeue(0)),
    await answer(
      "a requeue named by the markers",
      async () => await requeue(unchecked(markers.join(" ")))
    ),
  ];
};

/**
 * The sources of `hiddenVersions` the reader may read no version of: each
 * of whose first three versions is hidden (the harness names every
 * version of such a source, `everyVersionOf`). A source whose current
 * version they may read, with an earlier one hidden, isn't one.
 */
const whollyHidden = (
  hiddenVersions: Probing["hiddenVersions"]
): SourceRef[] => {
  const versionsOf = new Map<string, { source: SourceRef; count: number }>();
  for (const { source } of hiddenVersions) {
    const key = keyOf(source);
    const known = versionsOf.get(key);
    versionsOf.set(key, { source, count: (known?.count ?? 0) + 1 });
  }
  return [...versionsOf.values()]
    .filter(({ count }) => count >= 3)
    .map(({ source }) => source);
};

/** A moment past any a source is added at: a page after it starts at the newest. */
const pastAll = new Date(8.64e15);

/** Each export of core's brain-next.ts. */
type CoreMember = keyof typeof coreBrain;

/** The exports of core's brain-next.ts for a person's memories, probed after the store's memories (`corePersonMemories`). */
type CorePersonMember =
  | "rememberAs"
  | "forgetAs"
  | "memoryChoices"
  | "ownEntityAs"
  | "entitiesAs"
  | "memoriesAs"
  | "contestedAs"
  | "confirmAs"
  | "correctAs";

/** The exports of core's brain-next.ts for code's memories and entities, probed after them (`coreCodeMemories`). */
type CoreCodeMember =
  | "rememberForCompanyAs"
  | "forgetForCompanyAs"
  | "correctForCompanyAs"
  | "companyCardAs"
  | "companyEntitiesAs"
  | "isCodeMemoryRequest";

// Exports (GRA-1755). A company's export holds what the company holds,
// markers among them, by design: it is for an admin, and core's route
// lets no one else ask for it (brain-next-exports.ts), so no probe reads
// its files. Probes ask of it only what answers no content, and a
// person's own store refuses the company's export and every restore call.
//
// A person's own export (GRA-1839) is theirs alone to read: the reader's
// own is written and read whole (it must hold no marker), and someone
// else's, holding every marker, answers the reader exactly as an export
// no one started.

/** A store, as a probe ticks it: the shared one, or a person's own. */
const personalStore = (person: string): Brain =>
  personalBrainOf(inJurisdiction(env, env.BRAIN_STORE), person);

/**
 * Ticks the shared store until its export `id` is no longer being written:
 * at most 5 ticks, then fails.
 */
const exportSettled = async (id: string): Promise<void> => {
  for (let ticks = 0; ticks < 5; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await store().work({
      ask: quietModel,
      at: new Date(),
      embedders: noEmbedders,
      handOvers: noHandOvers,
      contextTokens: null,
    });
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await store().exportStatus({ id });
    if (status?.state !== "writing") {
      return;
    }
  }
  throw new Error("An export was still being written after 5 ticks");
};

/**
 * The company's export, written, holding every marker (someone else's
 * source among it). It is for an admin (core's route checks): no probe
 * reads its files, only asks of it what answers no content.
 */
const companyExport = async ({ markers }: Probing): Promise<string> => {
  await coreBrain.addSource(env, {
    source: missingSource(),
    change: crypto.randomUUID(),
    text: markedText(markers),
    readers: { kind: "team", teamId: crypto.randomUUID() },
  });
  const { id } = await coreBrain.startBrainExport(env);
  await exportSettled(id);
  return id;
};

/**
 * What the memory probes add to the shared store, as `probing`'s reader
 * may not read it, every marker in it: a customer whose names, reference
 * and memories hold them, readable by a group the reader isn't in
 * (`hidden`); another (`drawn`), whose memory the reader's own set holds
 * but which rests on a source of that group, so the reader may not read
 * it either. And one the reader may read (`seen`), with a plain memory of
 * theirs, which hidden memories end (the same writer, later) and contest
 * (another source), and which the hidden group's reader confirmed over
 * them. Each `hidden*` memory id is one the reader may not read.
 */
interface MemoryFixture {
  hidden: string;
  drawn: string;
  seen: string;
  hiddenMemory: string;
  hiddenRef: string;
  seenMemory: string;
}

/** Adds the memory probes' fixture (above), its own for each probe. */
const memoryFixture = async ({
  reader,
  markers,
}: Probing): Promise<MemoryFixture> => {
  const group = stranger();
  const text = markedText(markers);
  const hiddenRef = `ref:${markers[0] ?? ""}`;
  const marked = (key: string): NewEntity => ({
    key,
    kind: "customer",
    names: [text],
    identifiers: [{ type: "ref", value: hiddenRef }],
  });
  const memory = (
    about: string,
    basis: NewMemory["basis"],
    extra: Partial<NewMemory> = {}
  ): NewMemory => ({
    about,
    type: "fact",
    statement: text,
    speaker: { kind: "system" },
    basis,
    ...extra,
  });
  const version = await store().addSource({
    source: keyOf(missingSource()),
    change: crypto.randomUUID(),
    text,
    access: { kind: "audience", group },
  });
  const writer = stranger();
  const hidden = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities: [marked("c")],
    memories: [memory("c", { kind: "writer", writer: stranger() })],
  });
  // A group the reader is in: memories only one person may read are kept
  // in that person's own store, never in the shared one this probes.
  const theirs = reader.groups[0] ?? stranger();
  const drawn = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: theirs },
    entities: [{ key: "c", kind: "customer", names: [text] }],
    memories: [memory("c", { kind: "source", ...version, quote: text })],
  });
  const seen = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: theirs },
    entities: [{ key: "c", kind: "customer", names: ["Plain"] }],
    memories: [
      memory(
        "c",
        { kind: "writer", writer },
        { attribute: "status", value: "Active", statement: "Plain" }
      ),
    ],
  });
  const seenId = seen.entities.c ?? "";
  const ended = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    // Made for someone who sees the reader's entity and is in the group.
    reader: { person: reader.person, groups: [group, theirs] },
    entities: [{ key: "c", id: seenId, kind: "customer", names: [text] }],
    memories: [
      memory(
        "c",
        { kind: "writer", writer },
        { attribute: "status", value: text }
      ),
      memory(
        "c",
        { kind: "source", ...version, quote: text },
        { attribute: "status", value: markers.join("") }
      ),
    ],
  });
  await store().confirmMemory({
    memory: ended.memories[0] ?? "",
    reader: { person: stranger(), groups: [group] },
  });
  return {
    hidden: hidden.entities.c ?? "",
    drawn: drawn.entities.c ?? "",
    seen: seenId,
    hiddenMemory: hidden.memories[0] ?? "",
    hiddenRef,
    seenMemory: seen.memories[0] ?? "",
  };
};

/**
 * A marked memory in someone else's own store (`person:<id>`), readable by
 * them alone: its entity's id and its own. Every probe of a person's
 * memories asks for these and must answer as for ids no one holds.
 */
const othersOwnMemory = async (
  markers: readonly string[]
): Promise<{ entity: string; memory: string }> => {
  const person = stranger();
  const text = markedText(markers);
  const added = await personalBrainOf(
    inJurisdiction(env, env.BRAIN_STORE),
    person
  ).addMemories({
    change: crypto.randomUUID(),
    access: { kind: "owner", person },
    entities: [
      {
        key: "c",
        kind: "customer",
        names: [text],
        identifiers: [{ type: "ref", value: `ref:${first(markers)}` }],
      },
    ],
    memories: [
      {
        about: "c",
        attribute: "status",
        value: text,
        type: "fact",
        statement: text,
        speaker: { kind: "internal", person },
        basis: { kind: "writer", writer: person },
      },
    ],
  });
  return { entity: added.entities.c ?? "", memory: added.memories[0] ?? "" };
};

/** An App's code, as the Brain names its writer. */
const codeWriter = (): string => `app:app-${crypto.randomUUID()}`;

/**
 * A memory of `writer`'s in the shared store, readable by a group the
 * reader isn't in, every marker in it: its id. A write of that writer's
 * as the company must answer as for a memory no one added.
 */
const hiddenWritten = async (
  writer: string,
  markers: readonly string[]
): Promise<string> => {
  const text = markedText(markers);
  const added = await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: stranger() },
    entities: [{ key: "c", kind: "customer", names: [text] }],
    memories: [
      {
        about: "c",
        attribute: "status",
        value: text,
        type: "fact",
        statement: text,
        speaker: { kind: "agent", agent: writer },
        basis: { kind: "writer", writer },
      },
    ],
  });
  return added.memories[0] ?? "";
};

/** An entity of a kind, by its id, as code names what a memory is about. */
const customerById = (id: string) => ({ kind: "customer", id });

/**
 * The memory fixture (above) for a recall: and a relation, hidden from
 * the reader, from their own entity ("Plain") to a person only hidden
 * memories name, so a recall stepping along it, or naming the person,
 * would show a marker. Asking "Plain" must find the reader's own alone.
 * And a marked memory in someone else's own store.
 */
const plantRecallFixture = async (probing: Probing): Promise<MemoryFixture> => {
  const fixture = await memoryFixture(probing);
  const text = markedText(probing.markers);
  const group = stranger();
  const person = {
    key: "p",
    kind: "person" as const,
    names: [text],
    identifiers: [
      {
        type: "email" as const,
        value: `${probing.markers[0] ?? "x"}@hidden.test`,
      },
    ],
  };
  const role = {
    about: "p",
    attribute: "role",
    value: text,
    type: "fact" as const,
    statement: `Plain ${text}`,
    speaker: { kind: "system" as const },
    basis: { kind: "writer" as const, writer: stranger() },
  };
  // The reader's "Plain" is in their first group (the memory fixture's):
  // a reader in none has no entity of theirs to relate a hidden one to.
  const seenBy = probing.reader.groups.length > 0;
  await store().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    ...(seenBy
      ? {
          // Made for someone who sees the reader's entity and is in the group.
          reader: {
            person: probing.reader.person,
            groups: [group, ...probing.reader.groups],
          },
          entities: [
            { key: "c", id: fixture.seen, kind: "customer", names: ["Plain"] },
            person,
          ],
          memories: [
            {
              about: "c",
              attribute: "contact",
              object: "p",
              type: "fact",
              statement: text,
              speaker: { kind: "system" },
              basis: { kind: "writer", writer: stranger() },
            },
            role,
          ],
        }
      : { entities: [person], memories: [role] }),
  });
  // Someone else's own store, every marker in it: a recall that reads
  // the reader's own store (their own source is there) reads theirs alone.
  await othersOwnMemory(probing.markers);
  return fixture;
};

/** The recall fixtures planted, by reader and markers. */
const recallFixtures = new Map<string, Promise<MemoryFixture>>();

/**
 * The recall fixture (`plantRecallFixture`) for `probing`'s reader and
 * markers, planted once in a pass and shared by every probe of it: a
 * probe planting its own would add hidden sources between what the gate
 * counts before and after a pass.
 */
const recallFixture = async (probing: Probing): Promise<MemoryFixture> => {
  const key = JSON.stringify([
    probing.personId,
    probing.reader,
    probing.markers,
  ]);
  const planted = recallFixtures.get(key) ?? plantRecallFixture(probing);
  recallFixtures.set(key, planted);
  return await planted;
};

/**
 * Ticks `person`'s own store until its export `id` is no longer being
 * written: at most 5 ticks, then fails.
 */
const ownExportSettled = async (person: string, id: string): Promise<void> => {
  for (let ticks = 0; ticks < 5; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await personalStore(person).work({
      ask: quietModel,
      at: new Date(),
      embedders: noEmbedders,
      handOvers: noHandOvers,
      contextTokens: null,
    });
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await personalStore(person).ownExport({ person });
    if (status?.id === id && status.state !== "writing") {
      return;
    }
  }
  throw new Error("An own export was still being written after 5 ticks");
};

/** Someone else's own export, written, holding every marker: its id. */
const strangersExport = async ({ markers }: Probing): Promise<string> => {
  const person = stranger();
  await personalStore(person).addSource({
    source: `upload:${crypto.randomUUID()}`,
    change: crypto.randomUUID(),
    text: markedText(markers),
    access: { kind: "owner", person },
  });
  const { id } = await personalStore(person).startOwnExport({
    person,
    deployment: "test",
  });
  await ownExportSettled(person, id);
  return id;
};

/** The reader's own export, written, and every file of it as they download it. */
const readersExport = async (personId: string): Promise<string[]> => {
  const { id } = await coreBrain.startOwnBrainExport(env, personId);
  await ownExportSettled(personId, id);
  const status = await coreBrain.ownBrainExport(env, personId);
  return await Promise.all(
    (status?.files ?? []).map(
      async (file) =>
        (await coreBrain.ownBrainExportFile(env, personId, { id, file })) ?? ""
    )
  );
};

/**
 * The Brain's store binding, refusing every store but the shared one, by
 * name or by an id made from a name: a staff path addresses no person's
 * own store (GRA-1762), so a probe through it that tries fails.
 */
const sharedOnly = (): Env["BRAIN_STORE"] =>
  new Proxy(env.BRAIN_STORE, {
    get: (namespace, member): unknown => {
      if (member === "jurisdiction") {
        return () => sharedOnly();
      }
      const value: unknown = Reflect.get(namespace, member, namespace);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => {
        const named =
          member === "getByName" || member === "idFromName"
            ? String(args[0])
            : null;
        if (member === "get" || (named !== null && named !== "brain")) {
          throw new Error(
            "A staff lookup addressed a store but the shared one"
          );
        }
        return Reflect.apply(value, namespace, args);
      };
    },
  });

/**
 * `personId`, once a first erasure of them settled and its time passed: a
 * person's own store answers that it is still deleting until an add under
 * way could have written its file, so each is compared after that, as if
 * the time had passed.
 */
const erasedBefore = async (personId: string): Promise<string> => {
  await Promise.allSettled([
    coreBrain.erasePerson(env, { personId, reason: "withdrawn" }),
  ]);
  await ageOwnErasure(personId);
  return personId;
};

/**
 * The probe of a recall of core's (`recallAs`, `recallPassagesAs`): the
 * markers, their twins and every way it can refuse, as the reader asks.
 */
const recallProbe =
  (recall: typeof coreBrain.recallAs | typeof coreBrain.recallPassagesAs) =>
  async (probing: Probing): Promise<Answer[]> => {
    await recallFixture(probing);
    const asked = async (asking: PackAsk) =>
      await recall(env, probing.personId, {
        ...asking,
        personal: probing.personal,
      });
    const hidden = probing.markers.join(" ");
    const whole = { tokens: recallBudgetMax };
    return [
      ...(await askedOfMarkers(probing, momentsOf(probing), asked)),
      await answer(
        "the shared word",
        async () => await asked({ question: probing.sharedWord, budget: whole })
      ),
      await answer(
        "the reader's own entity, which hidden relations name",
        async () => await asked({ question: "Plain", budget: whole })
      ),
      await answer(
        "nothing",
        async () => await asked({ question: "", budget: whole })
      ),
      await answer(
        "too long a question",
        async () =>
          await asked({
            question: `${hidden} `
              .repeat(questionMaxLength)
              .slice(0, questionMaxLength + 1),
            budget: whole,
          })
      ),
      await answer(
        "no tokens",
        async () => await asked({ question: hidden, budget: { tokens: 0 } })
      ),
      await answer(
        "a moment named by the markers",
        async () =>
          await asked(
            unchecked({ question: hidden, budget: whole, asOf: hidden })
          )
      ),
      await answer(
        "the markers, as someone who isn't a member",
        async () =>
          await recall(env, stranger(), {
            personal: true,
            question: hidden,
            budget: whole,
          })
      ),
    ];
  };

/**
 * Adds in a group that core refuses, each answered with the markers in
 * its text: for a team, for nobody, of another producer, not over its
 * source, and named by the markers.
 */
const groupedAdds = async (
  markers: readonly string[],
  text: string
): Promise<Answer[]> => {
  const chat = (): SourceRef => ({
    producer: "chat",
    id: `${stranger()}/${crypto.randomUUID()}`,
  });
  const add = async (
    name: string,
    readers: SourceReaders,
    group: SourceRef,
    source?: SourceRef
  ) =>
    await answer(
      name,
      async () =>
        await coreBrain.addSource(env, {
          source: source ?? { ...group, id: `${group.id}/1` },
          change: crypto.randomUUID(),
          text,
          readers,
          group,
        })
    );
  const someoneElse: SourceReaders = { kind: "owner", personId: stranger() };
  return [
    await add(
      "in a group, for a team",
      { kind: "team", teamId: stranger() },
      chat()
    ),
    await add("in a group, for nobody", { kind: "none" }, chat()),
    await add(
      "in a group of another producer",
      someoneElse,
      {
        producer: "upload",
        id: crypto.randomUUID(),
      },
      { producer: "chat", id: `${crypto.randomUUID()}/1` }
    ),
    await add("in a group not over its source", someoneElse, chat(), chat()),
    await add(
      "in a group named by the markers, not over its source",
      someoneElse,
      { producer: "chat", id: markers.join("") },
      chat()
    ),
  ];
};

/** One probe per export of core's brain-next.ts. */
export const coreProbes = {
  addSource: async ({ markers, hiddenVersions }) => {
    const text = markedText(markers);
    const add = async (
      name: string,
      readers: SourceReaders,
      as = text,
      source: SourceRef = missingSource(),
      change = crypto.randomUUID()
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.addSource(env, { source, change, text: as, readers })
      );
    const someoneElse: SourceReaders = { kind: "owner", personId: stranger() };
    return [
      await add("for someone else", { kind: "owner", personId: stranger() }),
      await add("for nobody", { kind: "none" }),
      await add("an unknown kind", unchecked({ kind: "everyone" })),
      await add("no person", unchecked({ kind: "owner", personId: "" })),
      await add(
        "a team named by the markers",
        unchecked({ kind: "team", teamId: markers.join("") })
      ),
      await add("no text", { kind: "owner", personId: stranger() }, ""),
      await add(
        "too much text",
        { kind: "owner", personId: stranger() },
        oversizedText(markers)
      ),
      await add(
        "an unknown producer named by the markers",
        someoneElse,
        text,
        unchecked({ producer: markers.join(""), id: crypto.randomUUID() })
      ),
      await add(
        "an id of the markers and control characters",
        someoneElse,
        text,
        { producer: "upload", id: `${markers.join("\n")}\u0000` }
      ),
      await add(
        "a change of the markers and control characters",
        someoneElse,
        text,
        missingSource(),
        `${markers.join("\n")}\u0000`
      ),
      await add(
        "the markers with half a surrogate pair",
        someoneElse,
        `${text}\uD800`
      ),
      ...(await refusedChange(markers)),
      ...(await otherKindOf(hiddenVersions)),
      // Groups (GRA-1805): a person's own store's alone, over their source.
      ...(await groupedAdds(markers, text)),
    ];
  },
  listSourcesAs: async ({ personId, hiddenVersions, markers }) => {
    const list = async (
      name: string,
      after?: { addedAt: Date; source: SourceRef },
      as = personId,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.listSourcesAs(
            env,
            as,
            after === undefined ? {} : { after }
          ),
        about
      );
    const asked: Answer[] = [
      await list("every source they may read"),
      await list(
        "after a source no one added",
        { addedAt: pastAll, source: missingSource() },
        personId,
        "nothing"
      ),
    ];
    for (const [index, { source }] of hiddenVersions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const answered = await list(
        `after hidden source ${index}`,
        { addedAt: pastAll, source },
        personId,
        "hidden"
      );
      asked.push(answered);
    }
    asked.push(
      await list("as someone who isn't a member", undefined, stranger()),
      await list(
        "after an unknown producer named by the markers",
        unchecked({
          addedAt: pastAll,
          source: { producer: markers.join(""), id: "x" },
        })
      ),
      await list(
        "after a moment named by the markers",
        unchecked({ addedAt: markers.join(" "), source: missingSource() })
      )
    );
    return asked;
  },
  listVersionsAs: async ({ personId, hiddenVersions, markers }) => {
    // Below a hidden version and one past it: what the reader may read
    // of that source up to it, which for these is nothing.
    const list = async (
      name: string,
      source: SourceRef,
      before?: number,
      as = personId,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.listVersionsAs(env, as, {
            source,
            ...(before === undefined ? {} : { before }),
          }),
        about
      );
    const asked: Answer[] = [
      await list(
        "a source no one added",
        missingSource(),
        undefined,
        personId,
        "nothing"
      ),
    ];
    for (const [index, source] of whollyHidden(hiddenVersions).entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const answered = await list(
        `hidden source ${index}`,
        source,
        undefined,
        personId,
        "hidden"
      );
      asked.push(answered);
    }
    for (const [index, { source, version }] of hiddenVersions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const answered = await list(
        `up to hidden version ${index}`,
        source,
        version + 1,
        personId,
        "hidden"
      );
      asked.push(answered);
    }
    const hidden = hiddenVersions[0]?.source ?? missingSource();
    asked.push(
      await list(
        "as someone who isn't a member",
        hidden,
        undefined,
        stranger()
      ),
      await list("below version 0", hidden, 0),
      await list(
        "an unknown producer named by the markers",
        unchecked({ producer: markers.join(""), id: hidden.id })
      )
    );
    return asked;
  },
  readSourceVersionAs: async ({ personId, hiddenVersions, markers }) => {
    const read = async (
      name: string,
      source: SourceRef,
      version: number,
      as = personId,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.readSourceVersionAs(env, as, { source, version }),
        about
      );
    const asked: Answer[] = [
      await read(
        "a source no one added",
        missingSource(),
        1,
        personId,
        "nothing"
      ),
    ];
    for (const [index, { source, version }] of hiddenVersions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time
      const answered = await read(
        `hidden version ${index}`,
        source,
        version,
        personId,
        "hidden"
      );
      asked.push(answered);
    }
    const hidden = hiddenVersions[0]?.source ?? missingSource();
    asked.push(
      await read("as someone who isn't a member", hidden, 1, stranger()),
      await read("version 0", hidden, 0),
      await read(
        "an unknown producer named by the markers",
        unchecked({ producer: markers.join(""), id: hidden.id }),
        1
      ),
      await read(
        "an id of the markers and control characters",
        { producer: "upload", id: `${markers.join("\n")}\u0000` },
        1
      )
    );
    return asked;
  },
  readableVersionsAs: async ({ personId, hiddenVersions, markers }) => {
    const check = async (
      name: string,
      versions: readonly { source: SourceRef; version: number }[],
      as = personId,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await coreBrain.readableVersionsAs(env, as, versions),
        about
      );
    const hidden = hiddenVersions[0]?.source ?? missingSource();
    return [
      await check(
        "sources no one added",
        hiddenVersions.map(({ version }) => ({
          source: missingSource(),
          version,
        })),
        personId,
        "nothing"
      ),
      await check("the hidden versions", hiddenVersions, personId, "hidden"),
      // As a chat's code pinned them: the reader's teams alone.
      await answer(
        "the hidden versions, as the teams",
        async () =>
          await coreBrain.readableVersionsAs(env, personId, hiddenVersions, {
            reach: "teams",
          }),
        "hidden"
      ),
      // As an App's or a run's recall pinned them: the company alone.
      await answer(
        "the hidden versions, as the company",
        async () =>
          await coreBrain.readableVersionsAs(env, personId, hiddenVersions, {
            reach: "company",
          }),
        "hidden"
      ),
      await check(
        "as someone who isn't a member",
        [{ source: hidden, version: 1 }],
        stranger()
      ),
      await check("version 0", [{ source: hidden, version: 0 }]),
      await check("an unknown producer named by the markers", [
        unchecked({
          source: { producer: markers.join(""), id: hidden.id },
          version: 1,
        }),
      ]),
      await check("an id of the markers and control characters", [
        {
          source: { producer: "upload", id: `${markers.join("\n")}\u0000` },
          version: 1,
        },
      ]),
      // A run's pins of skills: one never written, one named by the
      // markers, one of the markers' scope, as the company, as a run's
      // check reads them.
      await answer(
        "skills no one wrote, as the company",
        async () =>
          await coreBrain.readableVersionsAs(
            env,
            personId,
            [
              {
                source: { producer: "skill", id: "company:unwritten" },
                version: 1,
              },
              {
                source: {
                  producer: "skill",
                  id: `company:${markers.join("-")}`,
                },
                version: 1,
              },
              {
                source: { producer: "skill", id: `${markers.join("")}:x` },
                version: 1,
              },
            ],
            { reach: "company" }
          )
      ),
    ];
  },
  mergeRecalled: async ({ personId, personal, markers, sharedWord }) => {
    const whole = { tokens: recallBudgetMax };
    // The markers' pack joined by a pack of what the reader may read must
    // be their twins' pack joined by the same.
    const merged = async (words: readonly string[]) => {
      const asked = await coreBrain.recallPassagesAs(env, personId, {
        question: words.join(" "),
        budget: whole,
        personal,
      });
      const shared = await coreBrain.recallPassagesAs(env, personId, {
        question: sharedWord,
        budget: whole,
        personal,
      });
      return coreBrain.mergeRecalled(asked, shared, whole);
    };
    return [
      await answer("the markers", async () => await merged(markers), "hidden"),
      await answer(
        "their twins",
        async () => await merged(markers.map((marker) => twinOf(marker))),
        "nothing"
      ),
    ];
  },
  recallAs: recallProbe(coreBrain.recallAs),
  recallPassagesAs: recallProbe(coreBrain.recallPassagesAs),
  // Adds without a check of who writes (instruction-files.ts checks
  // first): only to files no reader is, and its refusals.
  addInstructionFile: async ({ markers }) => {
    const text = markedText(markers);
    const add = async (name: string, file: InstructionFile, as = text) =>
      await answer(
        name,
        async () =>
          await coreBrain.addInstructionFile(env, {
            file,
            change: crypto.randomUUID(),
            text: as,
          })
      );
    return [
      await add("someone else's", unwrittenFile()),
      await add(
        "too much text",
        unwrittenFile(),
        text.padEnd(instructionsMaxLength + 1, " x")
      ),
      await add("no text", unwrittenFile(), " "),
      await add("half a surrogate pair", unwrittenFile(), `${text}\uD800`),
      await add("an id of the markers and control characters", {
        scope: "agent",
        agentId: `${markers.join("\n")}\u0000`,
      }),
      await add(
        "an unknown scope named by the markers",
        unchecked({ scope: "team", teamId: markers.join("") })
      ),
      await add(
        "a field the scope hasn't",
        unchecked({ scope: "company", name: "facts", appId: text })
      ),
    ];
  },
  // Pure: a request as code sends it, read; what is refused holds the
  // markers, and is refused alike.
  codeRecallOf: async ({ markers, sharedWord }) => {
    const of = async (name: string, input: unknown) =>
      await answer(name, async () => {
        await Promise.resolve();
        return coreBrain.codeRecallOf(input);
      });
    const hidden = markers.join(" ");
    return [
      await of("a request", {
        question: sharedWord,
        budget: { tokens: 1 },
        asOf: "2026-03-14T23:59:59.999+01:00",
      }),
      await of("a reader of the markers", {
        question: hidden,
        budget: { tokens: 1 },
        reader: hidden,
      }),
      await of("a moment of the markers", {
        question: hidden,
        budget: { tokens: 1 },
        asOf: hidden,
      }),
      await of("no tokens", { question: hidden, budget: { tokens: 0 } }),
    ];
  },
  instructionFileOf: async ({ markers }) => {
    const of = async (name: string, input: unknown) =>
      await answer(name, async () => {
        await Promise.resolve();
        return coreBrain.instructionFileOf(input);
      });
    return [
      await of("someone else's", unwrittenFile()),
      await of("an id of the markers and control characters", {
        scope: "person",
        personId: `${markers.join("\n")}\u0000`,
      }),
      await of("an id of the markers with half a surrogate pair", {
        scope: "app",
        appId: `${markers.join("")}\uD800`,
      }),
      await of("an unknown scope", { scope: markers.join("") }),
      await of("a company file named by the markers", {
        scope: "company",
        name: markers.join(""),
      }),
    ];
  },
  // Reads as the member it is given and with the App it is told they
  // build, both on its caller's word (instruction-files.ts); which agent's
  // file is the caller's to pick too. So it is held here to what that
  // reader may read: never another person's file, nor an App's it wasn't
  // told they build.
  readInstructionFilesAs: async ({ personId, hiddenInstructionFiles }) => {
    const read = async (
      name: string,
      files: InstructionFile[],
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.readInstructionFilesAs(
            env,
            { userId: personId },
            files
          ),
        about
      );
    const hidden = hiddenInstructionFiles.filter(
      ({ scope }) => scope === "person" || scope === "app"
    );
    const asked: Answer[] = [
      await read("a file never written", [unwrittenFile()], "nothing"),
    ];
    for (const [index, file] of hidden.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time
      const answered = await read(`hidden file ${index}`, [file], "hidden");
      asked.push(answered);
    }
    asked.push(
      await read("every hidden file at once", hidden, "hidden"),
      await read(
        "too many files",
        Array.from({ length: currentReadMax + 1 }, unwrittenFile)
      )
    );
    return asked;
  },
  workBrain: async ({ markers }) => {
    const asked = await workMarked(
      markers,
      async (at) => {
        await coreBrain.workBrain(env, at, noProducers);
      },
      "a marked item worked through core's clock"
    );
    for (const at of sweepTimes()) {
      // oxlint-disable-next-line no-await-in-loop -- one tick at a time
      const answered = await answer(
        `a tick as of ${at.toISOString()}`,
        async () => {
          await coreBrain.workBrain(env, at, noProducers);
        }
      );
      asked.push(answered);
    }
    asked.push(
      await answer("a tick at no time", async () => {
        await coreBrain.workBrain(
          env,
          unchecked(markers.join(" ")),
          noProducers
        );
      })
    );
    return asked;
  },
  // Erasure has no reader: what it answers must be alike whether there
  // was anything to erase, and hold no marker. Each probe erases marked
  // content of its own (someone else's), never the planted sources later
  // passes read.
  eraseSource: async ({ markers }) => {
    // Someone else's own, in their own store: a source no one added is
    // asked of in the same store.
    const readers: SourceReaders = { kind: "owner", personId: stranger() };
    const erase = async (
      name: string,
      source: SourceRef,
      reason: ErasureReason = "deleted",
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => {
          await coreBrain.eraseSource(env, { source, readers, reason });
        },
        about
      );
    const marked = missingSource();
    await coreBrain.addSource(env, {
      source: marked,
      change: crypto.randomUUID(),
      text: markedText(markers),
      readers,
    });
    // A chat's turn of theirs, in its chat's group (GRA-1805).
    const markedGroup: SourceRef = {
      producer: "chat",
      id: `${readers.personId}/${crypto.randomUUID()}`,
    };
    await coreBrain.addSource(env, {
      source: { producer: "chat", id: `${markedGroup.id}/1` },
      change: crypto.randomUUID(),
      text: markedText(markers),
      readers,
      group: markedGroup,
    });
    return [
      await erase(
        "a source no one added",
        missingSource(),
        "deleted",
        "nothing"
      ),
      await erase("someone else's marked source", marked, "deleted", "hidden"),
      await erase("the same erasure again", marked, "deleted", "hidden"),
      await erase(
        "the group of someone else's marked source",
        markedGroup,
        "deleted",
        "hidden"
      ),
      await erase(
        "an unknown producer named by the markers",
        unchecked({ producer: markers.join(""), id: crypto.randomUUID() })
      ),
      await erase("an id of the markers and control characters", {
        producer: "upload",
        id: `${markers.join("\n")}\u0000`,
      }),
      await erase(
        "a reason named by the markers",
        missingSource(),
        unchecked(markers.join(" "))
      ),
      await answer("readers named by the markers", async () => {
        await coreBrain.eraseSource(env, {
          source: missingSource(),
          readers: unchecked({ kind: "owner", personId: markers.join("\n") }),
          reason: "deleted",
        });
      }),
    ];
  },
  // A group of one person's own store (GRA-1827: a disconnected
  // connection's captures), erased there alone. Its caller acts for that
  // person, so it answers how many of their sources it erased: a count,
  // never a marker or anything of what they held.
  eraseOwnGroup: async ({ markers }) => {
    const personId = stranger();
    const group: SourceRef = {
      producer: "capture",
      id: `connection-${crypto.randomUUID()}`,
    };
    await coreBrain.addSource(env, {
      source: { producer: "capture", id: `${group.id}/${crypto.randomUUID()}` },
      change: crypto.randomUUID(),
      text: markedText(markers),
      readers: { kind: "owner", personId },
      group,
    });
    const erase = async (
      name: string,
      erased: Parameters<typeof coreBrain.eraseOwnGroup>[1]
    ) =>
      await answer(
        name,
        async () => await coreBrain.eraseOwnGroup(env, erased)
      );
    return [
      await erase("someone's marked group", {
        personId,
        group,
        reason: "deleted",
      }),
      await erase("the same erasure again", {
        personId,
        group,
        reason: "deleted",
      }),
      await erase("a group no one added in", {
        personId,
        group: { producer: "capture", id: `connection-${crypto.randomUUID()}` },
        reason: "deleted",
      }),
      await erase("a group named by the markers", {
        personId,
        group: unchecked({ producer: "capture", id: markers.join("") }),
        reason: "deleted",
      }),
      await erase("a person named by the markers", {
        personId: unchecked(markers.join("\n")),
        group,
        reason: "deleted",
      }),
      await erase("a reason named by the markers", {
        personId,
        group,
        reason: unchecked(markers.join(" ")),
      }),
    ];
  },
  // A rule of time alone: it reads nothing of the Brain.
  stillDeletingTooLong: async () => [
    await answer("an erasure asked for now", async () => {
      await Promise.resolve();
      return coreBrain.stillDeletingTooLong(new Date());
    }),
  ],
  erasePerson: async ({ markers }) => {
    const erase = async (
      name: string,
      personId: string,
      reason: ErasureReason = "person_erased",
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => {
          await coreBrain.erasePerson(env, { personId, reason });
        },
        about
      );
    const holder = stranger();
    await coreBrain.addSource(env, {
      source: missingSource(),
      change: crypto.randomUUID(),
      text: markedText(markers),
      readers: { kind: "owner", personId: holder },
    });
    return [
      await erase(
        "someone with nothing",
        await erasedBefore(stranger()),
        "withdrawn",
        "nothing"
      ),
      await erase(
        "someone with marked sources",
        await erasedBefore(holder),
        "withdrawn",
        "hidden"
      ),
      await erase("the same erasure again", holder, "withdrawn", "hidden"),
      await erase("no person", ""),
      await erase(
        "a person named by the markers, too long",
        markers.join("").repeat(300)
      ),
      await erase(
        "a reason named by the markers",
        stranger(),
        unchecked(markers.join(" "))
      ),
    ];
  },
  // Queuing hand-overs has no reader: whatever it is handed, it answers
  // alike and says nothing of what it queues. What it puts on the queue
  // is worked by the next tick, which reads core's records for it.
  queueHandOvers: async ({ markers }) => {
    const queue = async (
      name: string,
      sources: readonly SourceRef[],
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => {
          await coreBrain.queueHandOvers(env, sources);
        },
        about
      );
    return [
      await queue("a run that never ran", [missingSource()], "nothing"),
      await queue(
        "a run named by the markers",
        [{ producer: "run", id: markers.join("-") }],
        "hidden"
      ),
      await queue("a run named by the markers and a control character", [
        { producer: "run", id: `${markers.join("-")}\u0007` },
      ]),
      await queue("a source of a kind no one produces", [
        unchecked({ producer: markers.join(""), id: "x" }),
      ]),
      await answer("a tick handing them over", async () => {
        await coreBrain.workBrain(env, nextDay(), producersOf(env));
      }),
    ];
  },
  brainWorkOverview: async ({ markers }) => [
    ...(await workMarked(
      markers,
      async (at) => {
        await store().work({
          ask: quietModel,
          at,
          embedders: noEmbedders,
          handOvers: noHandOvers,
          contextTokens: null,
        });
      },
      "a marked item worked to parking"
    )),
    await answer(
      "the overview, the marked item parked",
      async () => await coreBrain.brainWorkOverview(env)
    ),
  ],
  brainStaffReport: async ({ markers }) => [
    await answer("a marked item parked", async () => await parkMarked(markers)),
    await answer(
      "the staff's report, the marked item parked",
      async () => await coreBrain.brainStaffReport(env)
    ),
  ],
  actOnBrainForStaff: async ({ markers }) => [
    ...(await requeueMarked(
      markers,
      async (item) =>
        await coreBrain.actOnBrainForStaff(env, { type: "requeue", item })
    )),
    await answer(
      "a rebuild of the word indexes",
      async () =>
        await coreBrain.actOnBrainForStaff(env, { type: "rebuild_words" })
    ),
    await answer(
      "a rebuild while one is under way",
      async () =>
        await coreBrain.actOnBrainForStaff(env, { type: "rebuild_words" })
    ),
    await answer(
      "an action named by the markers",
      async () =>
        await coreBrain.actOnBrainForStaff(
          env,
          unchecked({ type: markers.join(" ") })
        )
    ),
    await answer(
      "a re-embed",
      async () => await coreBrain.actOnBrainForStaff(env, { type: "reembed" })
    ),
    ...(await workMarked(
      markers,
      async (at) => {
        await coreBrain.actOnBrainForStaff(env, { type: "reembed" });
        await coreBrain.workBrain(env, at, noProducers);
      },
      "a marked item worked through core's clock after a re-embed"
    )),
  ],
  // The company's export is for an admin (core's route checks): its
  // probes ask what answers no content, never its files.
  startBrainExport: async () => [
    await answer("the company's export, started", async () => {
      const { id } = await coreBrain.startBrainExport(env);
      return typeof id;
    }),
  ],
  brainExportStatus: async (probing) => {
    const id = await companyExport(probing);
    return [
      await answer("the company's export, done", async () => {
        const status = await coreBrain.brainExportStatus(env, { id });
        return status?.state;
      }),
      await answer(
        "an export no one started",
        async () =>
          await coreBrain.brainExportStatus(env, { id: crypto.randomUUID() })
      ),
      await answer(
        "an id named by the markers",
        async () =>
          await coreBrain.brainExportStatus(
            env,
            unchecked({ id: probing.markers.join(" ") })
          )
      ),
    ];
  },
  brainExportFile: async (probing) => {
    const id = await companyExport(probing);
    return [
      await answer(
        "a file of an export no one started",
        async () =>
          await coreBrain.brainExportFile(env, {
            id: crypto.randomUUID(),
            file: "manifest.json",
          })
      ),
      await answer(
        "a file named by the markers",
        async () =>
          await coreBrain.brainExportFile(
            env,
            unchecked({ id, file: probing.markers.join(" ") })
          )
      ),
    ];
  },
  // The reader's own export: theirs alone, read whole. (A reader erased
  // whole is refused; someone who never kept anything always answers.)
  startOwnBrainExport: async ({ personId }) => [
    await answer(
      "the reader's own export, written and read whole",
      async () => await readersExport(personId)
    ),
    await answer(
      "the export of someone who never kept anything",
      async () => await readersExport(stranger())
    ),
  ],
  ownBrainExport: async (probing) => {
    await strangersExport(probing);
    return [
      await answer("the reader's own export, as it shows them", async () => {
        await readersExport(probing.personId);
        const status = await coreBrain.ownBrainExport(env, probing.personId);
        return [status?.state, status?.files];
      }),
      await answer(
        "the export of someone who never started one",
        async () => await coreBrain.ownBrainExport(env, stranger())
      ),
    ];
  },
  ownBrainExportFile: async (probing) => {
    const others = await strangersExport(probing);
    return [
      await answer(
        "a file of someone else's marked export",
        async () =>
          await coreBrain.ownBrainExportFile(env, probing.personId, {
            id: others,
            file: "manifest.json",
          }),
        "hidden"
      ),
      await answer(
        "a file of an export no one started",
        async () =>
          await coreBrain.ownBrainExportFile(env, probing.personId, {
            id: crypto.randomUUID(),
            file: "manifest.json",
          }),
        "nothing"
      ),
      await answer(
        "a file named by the markers",
        async () =>
          await coreBrain.ownBrainExportFile(
            env,
            probing.personId,
            unchecked({ id: others, file: probing.markers.join(" ") })
          )
      ),
    ];
  },
  // A restore has no reader: it goes only into a shared store that holds
  // nothing, so here, where it holds the markers, it is refused alike
  // whatever export it names.
  startBrainRestore: async (probing) => {
    const others = await companyExport(probing);
    return [
      await answer(
        "someone else's marked export",
        async () =>
          await refusedWith(
            async () => await coreBrain.startBrainRestore(env, others)
          ),
        "hidden"
      ),
      await answer(
        "an export no one started",
        async () =>
          await refusedWith(
            async () =>
              await coreBrain.startBrainRestore(env, crypto.randomUUID())
          ),
        "nothing"
      ),
      await answer(
        "an export named by the markers",
        async () =>
          await coreBrain.startBrainRestore(env, probing.markers.join(" "))
      ),
    ];
  },
  brainRestoreStatus: async (probing) => {
    const others = await companyExport(probing);
    return [
      await answer(
        "someone else's marked export",
        async () => await coreBrain.brainRestoreStatus(env, others),
        "hidden"
      ),
      await answer(
        "an export no one started",
        async () =>
          await coreBrain.brainRestoreStatus(env, crypto.randomUUID()),
        "nothing"
      ),
      await answer(
        "an export named by the markers",
        async () =>
          await coreBrain.brainRestoreStatus(env, probing.markers.join(" "))
      ),
    ];
  },
  // Adds Grasp's own skills only, by the names the release ships, a
  // skill every member may read: the release's own text, which holds no
  // marker, then refusals each holding the markers. A skill added with
  // them would be the company's to read.
  addShippedSkill: async ({ markers }) => {
    const text = markedText(markers);
    const add = async (name: string, added: unknown) =>
      await answer(
        name,
        async () => await coreBrain.addShippedSkill(env, unchecked(added))
      );
    const drawing = shippedSkills.find(
      ({ name }) => name === "draw-a-workflow"
    );
    const named = (name: string) =>
      `---\nname: ${name}\ndescription: ${text}\n---\n${text}`;
    return [
      await add("the release's own", {
        name: "draw-a-workflow",
        change: crypto.randomUUID(),
        text: drawing?.text,
      }),
      await add("text with no card", {
        name: "draw-a-workflow",
        change: crypto.randomUUID(),
        text,
      }),
      await add("a card of another name", {
        name: "draw-a-workflow",
        change: crypto.randomUUID(),
        text: named("run-a-baseline"),
      }),
      await add("a name the release doesn't ship", {
        name: "unwritten",
        change: crypto.randomUUID(),
        text: named("unwritten"),
      }),
      await add("too much text", {
        name: "draw-a-workflow",
        change: crypto.randomUUID(),
        text: named("draw-a-workflow").padEnd(instructionsMaxLength + 1, " x"),
      }),
      await add("a name of the markers", {
        name: markers.join("\n"),
        change: crypto.randomUUID(),
        text: named("draw-a-workflow"),
      }),
      await add("a scope named by the markers", {
        name: "draw-a-workflow",
        scope: markers.join(""),
        change: crypto.randomUUID(),
        text: named("draw-a-workflow"),
      }),
    ];
  },
  listSkillsAs: async ({ personId, personal }) => [
    await answer(
      "the reader's skills",
      async () =>
        await coreBrain.listSkillsAs(
          env,
          personId,
          new Set(["draw-a-workflow"]),
          { personal }
        )
    ),
    await answer(
      "the reader's skills, without their own",
      async () =>
        await coreBrain.listSkillsAs(
          env,
          personId,
          new Set(["draw-a-workflow"]),
          { personal: false }
        )
    ),
    await answer(
      "as someone who isn't a member",
      async () =>
        await coreBrain.listSkillsAs(env, stranger(), new Set<string>(), {
          personal: true,
        })
    ),
  ],
  // A skill is read by its own key alone: no producer's source is under
  // the skills' kind, so no hidden source can be named as one.
  readSkillAs: async ({ personId, markers, hiddenSkills }) => {
    const read = async (name: string, wanted: unknown) =>
      await answer(
        name,
        async () =>
          await coreBrain.readSkillAs(env, personId, unchecked(wanted))
      );
    return [
      await read("a skill never written", {
        scope: "company",
        name: "unwritten",
        version: 1,
      }),
      await read("a name of the markers", {
        scope: "grasp",
        name: markers.join(" "),
        version: 1,
      }),
      await read("a producer's kind as its scope", {
        scope: "upload",
        name: "unwritten",
        version: 1,
      }),
      await answer(
        "as someone who isn't a member",
        async () =>
          await coreBrain.readSkillAs(env, stranger(), {
            scope: "grasp",
            name: "draw-a-workflow",
            version: 1,
          })
      ),
      ...(await pairedOverSkills(
        hiddenSkills,
        async (name) =>
          await coreBrain.readSkillAs(env, personId, {
            scope: "person",
            name,
            version: 1,
          })
      )),
    ];
  },
  brainErasureForStaff: async ({ markers }) => {
    const look = async (
      name: string,
      lookup: unknown,
      about?: Answer["about"],
      like?: string
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.brainErasureForStaff(
            { ...env, BRAIN_STORE: sharedOnly() },
            unchecked(lookup)
          ),
        about,
        like
      );
    const holder = stranger();
    const kept = missingSource();
    const erased = missingSource();
    for (const source of [kept, erased]) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await coreBrain.addSource(env, {
        source,
        change: crypto.randomUUID(),
        text: markedText(markers),
        readers: { kind: "owner", personId: holder },
      });
    }
    await coreBrain.eraseSource(env, {
      source: erased,
      readers: { kind: "owner", personId: holder },
      reason: "deleted",
    });
    return [
      await look(
        "a source no one added",
        { kind: "source", key: keyOf(missingSource()) },
        "nothing"
      ),
      await look(
        "someone else's marked source, never erased",
        { kind: "source", key: keyOf(kept) },
        "hidden"
      ),
      await look(
        "someone with nothing",
        { kind: "person", id: stranger() },
        "nothing",
        "person"
      ),
      await look(
        "someone with marked sources, never erased",
        { kind: "person", id: holder },
        "hidden",
        "person"
      ),
      await look("an erased marked source", {
        kind: "source",
        key: keyOf(erased),
      }),
      await look("a key of the markers", {
        kind: "source",
        key: `upload:${markers.join(" ")}`,
      }),
      await look("an id of the markers, too long", {
        kind: "person",
        id: markers.join("").repeat(300),
      }),
      await look("a kind named by the markers", {
        kind: markers.join(" "),
        id: stranger(),
      }),
    ];
  },
  // Each of someone else's own skills, asked of as the reader's own,
  // answers as one no one wrote: the reader's own store is the only one
  // asked.
  readCurrentSkillAs: async ({ personId, markers, hiddenSkills }) => [
    await answer(
      "a skill never written",
      async () =>
        await coreBrain.readCurrentSkillAs(env, personId, {
          scope: "person",
          name: "unwritten",
        })
    ),
    await answer(
      "a company skill of the markers",
      async () =>
        await coreBrain.readCurrentSkillAs(env, personId, {
          scope: "company",
          name: markers.join("-"),
        })
    ),
    await answer(
      "as someone who isn't a member",
      async () =>
        await coreBrain.readCurrentSkillAs(env, stranger(), {
          scope: "person",
          name: "unwritten",
        })
    ),
    ...(await pairedOverSkills(
      hiddenSkills,
      async (name) =>
        await coreBrain.readCurrentSkillAs(env, personId, {
          scope: "person",
          name,
        })
    )),
  ],
  // Core's own reads for its reconciler: a version number alone, of what
  // the company may read, whatever change or skill is named. Someone
  // else's own skill's name, or the markers, name none.
  companyChangeVersion: async ({ markers, hiddenSkills }) => [
    await answer(
      "a change never made",
      async () =>
        await coreBrain.companyChangeVersion(env, {
          name: "unwritten",
          change: "decision:unmade",
        })
    ),
    await answer(
      "a change of the markers",
      async () =>
        await coreBrain.companyChangeVersion(env, {
          name: "unwritten",
          change: markers.join(""),
        })
    ),
    ...(await pairedOverSkills(
      hiddenSkills,
      async (name) =>
        await coreBrain.companyChangeVersion(env, {
          name,
          change: "decision:unmade",
        })
    )),
  ],
  companySkillVersion: async ({ markers, hiddenSkills }) => [
    await answer(
      "a skill never written",
      async () => await coreBrain.companySkillVersion(env, "unwritten")
    ),
    await answer(
      "a name of the markers",
      async () => await coreBrain.companySkillVersion(env, markers.join("-"))
    ),
    ...(await pairedOverSkills(
      hiddenSkills,
      async (name) => await coreBrain.companySkillVersion(env, name)
    )),
  ],
  // Writes only what a recorded decision says (skill-shares.ts): text that
  // isn't a skill of the name is refused, so a marked one is never written
  // where anyone reads it; nothing of it is listed after.
  writeCompanySkill: async ({ personId, markers }) => {
    const text = markedText(markers);
    const name = `probe-${crypto.randomUUID()}`;
    return [
      await answer(
        "a marked skill of another name",
        async () =>
          await coreBrain.writeCompanySkill(env, {
            name,
            change: crypto.randomUUID(),
            text: `---\nname: ${name}-other\ndescription: ${text}\n---\n${text}`,
            retired: false,
            after: null,
          })
      ),
      await answer(
        "a name of the markers",
        async () =>
          await coreBrain.writeCompanySkill(env, {
            name: markers.join(" "),
            change: crypto.randomUUID(),
            text,
            retired: true,
            after: null,
          })
      ),
      await answer(
        "the reader's skills after",
        async () =>
          await coreBrain.listSkillsAs(env, personId, new Set<string>(), {
            personal: true,
          })
      ),
    ];
  },
  // Writes the reader's own store only: refusals holding the markers, and
  // one skill of the reader's that holds none.
  addOwnSkill: async ({ personId, markers }) => {
    const text = markedText(markers);
    const add = async (name: string, written: unknown) =>
      await answer(
        name,
        async () =>
          await coreBrain.addOwnSkill(env, personId, {
            change: crypto.randomUUID(),
            text: unchecked(written),
          })
      );
    const plain = `probe-${crypto.randomUUID()}`;
    return [
      await add(
        "a skill of the reader's own",
        `---\nname: ${plain}\ndescription: A probe.\n---\nSteps.`
      ),
      await add("text with no card", text),
      await add(
        "a name of the markers",
        `---\nname: Marked ${markers.join(" ")}\ndescription: ${text}\n---\n${text}`
      ),
      await add(
        "too much text",
        `---\nname: ${plain}\ndescription: x\n---\n${text}`.padEnd(
          instructionsMaxLength + 1,
          " x"
        )
      ),
      await answer(
        "as someone who isn't a member",
        async () =>
          await coreBrain.addOwnSkill(env, stranger(), {
            change: crypto.randomUUID(),
            text: `---\nname: ${plain}\ndescription: A probe.\n---\nSteps.`,
          })
      ),
    ];
  },
  // Erases in the reader's own store alone: someone else's of the same
  // name is untouched, and answers as one no one wrote.
  eraseOwnSkill: async ({ personId, markers, hiddenSkills }) => [
    await answer("a skill never written", async () => {
      await coreBrain.eraseOwnSkill(env, personId, "unwritten");
    }),
    await answer("a name of the markers", async () => {
      await coreBrain.eraseOwnSkill(env, personId, markers.join(" "));
    }),
    await answer("as someone who isn't a member", async () => {
      await coreBrain.eraseOwnSkill(env, stranger(), "unwritten");
    }),
    ...(await pairedOverSkills(hiddenSkills, async (name) => {
      await coreBrain.eraseOwnSkill(env, personId, name);
      return await coreBrain.listSkillsAs(env, personId, new Set<string>(), {
        personal: true,
      });
    })),
  ],
  // A number, the longest question recall takes: the same for everyone.
  recallQuestionMaxLength: async () => [
    await answer(
      "the longest question",
      async () => await Promise.resolve(coreBrain.recallQuestionMaxLength)
    ),
  ],
  // The host of a store's own alarm: refused for any name but a person's
  // own store's; for the reader's own, its report kept and summed into
  // staff's totals, which hold numbers alone.
  alarmHostOf: async ({ personId, markers }) => [
    await answer(
      "the shared store's",
      async () => await coreBrain.alarmHostOf(env, "brain")
    ),
    await answer(
      "a store named by the markers",
      async () => await coreBrain.alarmHostOf(env, markers.join(" "))
    ),
    await answer(
      "a person's store named by the markers",
      async () => await coreBrain.alarmHostOf(env, `person:${markers.join("")}`)
    ),
    await answer("the reader's own store's, its report kept", async () => {
      const host = await coreBrain.alarmHostOf(env, `person:${personId}`);
      await host.report(
        await personalBrainOf(
          inJurisdiction(env, env.BRAIN_STORE),
          personId
        ).workOverview()
      );
      const { ownStores } = await coreBrain.brainStaffReport(env);
      return { model: host.embedders.model, totals: ownStores };
    }),
  ],
  // Pure: a skill's key as a run keeps it, from what the caller names
  // alone (a name it gives comes back as given), so no markers.
  skillVersionRefOf: async () => [
    await answer("a skill", async () => {
      await Promise.resolve();
      return coreBrain.skillVersionRefOf({
        scope: "grasp",
        name: "draw-a-workflow",
        version: 1,
      });
    }),
    await answer("not a skill's scope", async () => {
      await Promise.resolve();
      return coreBrain.skillVersionRefOf(
        unchecked({ scope: "upload", name: "draw-a-workflow", version: 1 })
      );
    }),
  ],
} satisfies Record<
  Exclude<CoreMember, CorePersonMember | CoreCodeMember>,
  Probe
>;

/** Each export of core's instruction-files.ts. */
type InstructionMember = keyof typeof instructionFiles;

/** A load of the files `authority` gets in `context`, to call. */
const loadAs =
  (authority: Authority, context?: instructionFiles.InstructionContext) =>
  async () =>
    await instructionFiles.instructionFilesFor(env, authority, context);

/** One probe per export of core's instruction-files.ts. */
export const instructionProbes = {
  // Every comparison holds what a context gives (or its refusal) when it
  // names a hidden file's real id to what it gives when it names one no
  // one wrote; then the plain calls, scanned for the markers.
  instructionFilesFor: async (probing) => {
    const { personId, markers, usedApps } = probing;
    const agent = readersAgent(personId);
    const raw = async (
      name: string,
      authority: Authority,
      context?: instructionFiles.InstructionContext
    ) => await answer(name, loadAs(authority, context));
    /** One side of the comparison `like`. */
    const side = async (
      like: string,
      about: "hidden" | "nothing",
      context: instructionFiles.InstructionContext,
      keep?: (file: InstructionFile) => boolean
    ) =>
      await answer(
        `${like}, ${about}`,
        async () => await filesOutcome(loadAs(agent, context), keep),
        about,
        like
      );
    const asked: Answer[] = [];
    for (const conversation of conversations) {
      // A context naming another agent, or another person, by a real id:
      // refused alike, whatever their file holds.
      for (const [field, ids, unwritten] of [
        [
          "agentId",
          hiddenIdsOf(probing, "agent"),
          () => `agent-${crypto.randomUUID()}`,
        ],
        ["personId", hiddenIdsOf(probing, "person"), stranger],
      ] as const) {
        for (const id of ids) {
          const like = `${conversation}, naming ${field} ${id}`;
          asked.push(
            // oxlint-disable-next-line no-await-in-loop -- one at a time
            await side(
              like,
              "nothing",
              unchecked({ conversation, [field]: unwritten() })
            ),
            // oxlint-disable-next-line no-await-in-loop -- one at a time
            await side(like, "hidden", unchecked({ conversation, [field]: id }))
          );
        }
      }
    }
    // A shared channel gives what a direct message does, but never a
    // person's file, the reader's own included: others there would read
    // it through the agent.
    asked.push(
      await side(
        "a shared channel",
        "nothing",
        { conversation: "direct" },
        (file) => file.scope !== "person"
      ),
      await side("a shared channel", "hidden", { conversation: "channel" })
    );
    // An App they use but don't build: its file is for its builders.
    if (usedApps !== undefined) {
      const like = "an App they use";
      asked.push(
        await side(like, "nothing", {
          conversation: "own",
          appId: usedApps.withoutFile,
        }),
        await side(like, "hidden", {
          conversation: "own",
          appId: usedApps.withFile,
        })
      );
    }
    // An App no one made, and one no one made with a file planted.
    const noApp = "an App no one made";
    asked.push(
      await side(noApp, "nothing", {
        conversation: "own",
        appId: crypto.randomUUID(),
      })
    );
    for (const appId of hiddenAppsOf(probing)) {
      asked.push(
        // oxlint-disable-next-line no-await-in-loop -- one App at a time
        await side(noApp, "hidden", { conversation: "own", appId })
      );
    }
    const inWorkflow = authoritySchema.parse({ ...agent, mode: "workflow" });
    asked.push(
      await raw("a workflow step", inWorkflow),
      await raw("their own chat", agent, { conversation: "own" }),
      await raw("a direct message", agent, { conversation: "direct" }),
      await raw("a shared channel", agent, { conversation: "channel" }),
      ...(usedApps === undefined
        ? []
        : [
            await raw("an App they use", agent, {
              conversation: "own",
              appId: usedApps.withFile,
            }),
          ]),
      await raw("as someone who isn't a member", readersAgent(stranger()), {
        conversation: "direct",
      }),
      await raw(
        "as an App's code",
        unchecked({
          subject: { type: "app", appId: markers.join("") },
          onBehalfOf: personId,
          mode: "interactive",
          appVersion: 1,
        }),
        { conversation: "own" }
      ),
      await raw("no context", agent),
      await raw(
        "a context naming the markers",
        agent,
        unchecked({ conversation: markers.join("") })
      ),
      await raw(
        "an authority acting for the markers",
        unchecked({ ...agent, onBehalfOf: markers.join("") }),
        { conversation: "direct" }
      )
    );
    return asked;
  },
  // Every comparison holds the refusal a save gets over a hidden file to
  // the one it gets over a file no one wrote; then the plain saves, with
  // the markers, scanned.
  saveInstructionFile: async (probing) => {
    const { personId, markers, usedApps } = probing;
    const text = markedText(markers);
    const session = sessionOf(personId);
    const own: InstructionFile = { scope: "person", personId };
    const save = async (
      name: string,
      by: Identity | Authority,
      file: InstructionFile,
      as = text
    ) =>
      await answer(
        name,
        async () =>
          await instructionFiles.saveInstructionFile(env, by, {
            file,
            change: crypto.randomUUID(),
            text: as,
          })
      );
    /** One side of the comparison `like`: the refusal of a save. */
    const side = async (
      like: string,
      about: "hidden" | "nothing",
      by: Identity | Authority,
      file: InstructionFile
    ) =>
      await answer(
        `${like}, ${about}`,
        async () =>
          await refusalOf(
            async () =>
              await instructionFiles.saveInstructionFile(env, by, {
                file,
                change: crypto.randomUUID(),
                text: "Not the markers",
              })
          ),
        about,
        like
      );
    const asked: Answer[] = [
      // No code writes a file, whatever the text: an agent saving its own
      // person's file, or an App's code saving it, is refused as an App's
      // code saving the company's, which no rule could let it.
      await side(
        "code saving a file",
        "nothing",
        authoritySchema.parse({
          subject: { type: "app", appId: `app-${crypto.randomUUID()}` },
          onBehalfOf: personId,
          mode: "interactive",
          appVersion: 1,
        }),
        { scope: "company", name: "facts" }
      ),
      await side("code saving a file", "hidden", readersAgent(personId), own),
      await side(
        "code saving a file",
        "hidden",
        authoritySchema.parse({
          subject: { type: "app", appId: `app-${crypto.randomUUID()}` },
          onBehalfOf: personId,
          mode: "interactive",
          appVersion: 1,
        }),
        own
      ),
    ];
    for (const id of hiddenIdsOf(probing, "person")) {
      const like = `another person's file ${id}`;
      asked.push(
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await side(like, "nothing", session, unwrittenFile()),
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await side(like, "hidden", session, { scope: "person", personId: id })
      );
    }
    for (const id of hiddenIdsOf(probing, "agent")) {
      const like = `an agent's file ${id}`;
      asked.push(
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await side(like, "nothing", session, {
          scope: "agent",
          agentId: `agent-${crypto.randomUUID()}`,
        }),
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await side(like, "hidden", session, { scope: "agent", agentId: id })
      );
    }
    const noApp = "an App no one made";
    asked.push(
      await side(noApp, "nothing", session, {
        scope: "app",
        appId: crypto.randomUUID(),
      })
    );
    for (const appId of hiddenAppsOf(probing)) {
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      asked.push(await side(noApp, "hidden", session, { scope: "app", appId }));
    }
    if (usedApps !== undefined) {
      const like = "an App they use";
      asked.push(
        await side(like, "nothing", session, {
          scope: "app",
          appId: usedApps.withoutFile,
        }),
        await side(like, "hidden", session, {
          scope: "app",
          appId: usedApps.withFile,
        })
      );
    }
    // Their own, without the markers: they read it back in every pass.
    asked.push(await save("their own", session, own, "Their own notes"));
    for (const [index, file] of probing.hiddenInstructionFiles.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time
      asked.push(await save(`over hidden file ${index}`, session, file));
    }
    asked.push(
      await save("the company's", session, {
        scope: "company",
        name: "instructions",
      }),
      await save("as their agent", readersAgent(personId), own),
      await save(
        "as an identity with an agent's subject",
        unchecked({ ...session, subject: { type: "agent", agentId: "a" } }),
        own
      ),
      await save(
        "as an identity named by the markers",
        unchecked({ ...session, name: text, extra: text }),
        own
      ),
      await save("as someone who isn't a member", sessionOf(stranger()), {
        scope: "person",
        personId: stranger(),
      }),
      await save(
        "too much text",
        session,
        own,
        text.padEnd(instructionsMaxLength + 1, " x")
      ),
      await save("no text", session, own, " ")
    );
    return asked;
  },
} satisfies Record<InstructionMember, Probe>;

/** Each export of core's brain-skills.ts. */
type SkillMember = keyof typeof brainSkills;

/** One probe per export of core's brain-skills.ts. */
export const skillProbes = {
  // The release's own, then skills holding the markers that aren't one:
  // each refused, logged by its place alone.
  installShippedSkills: async ({ markers }) => {
    const text = markedText(markers);
    return [
      await answer(
        "the release's skills",
        async () => await brainSkills.installShippedSkills(env)
      ),
      await answer(
        "marked skills that aren't one",
        async () =>
          await brainSkills.installShippedSkills(env, [
            { name: "unwritten", text },
            { name: markers.join("-"), text },
          ])
      ),
    ];
  },
  skillsFor: async ({ personId, personal }) => [
    await answer(
      "the reader's agent",
      async () =>
        await brainSkills.skillsFor(env, readersAgent(personId), { personal })
    ),
    await answer(
      "the reader's agent in a chat others share",
      async () =>
        await brainSkills.skillsFor(env, readersAgent(personId), {
          personal: false,
        })
    ),
    await answer(
      "an agent of someone who isn't a member",
      async () =>
        await brainSkills.skillsFor(env, readersAgent(stranger()), {
          personal,
        })
    ),
    await answer(
      "no authority",
      async () =>
        await brainSkills.skillsFor(env, unchecked({ onBehalfOf: personId }), {
          personal,
        })
    ),
  ],
  // Pure: what a scope may read of skills, the person's own only when it
  // says it is their own attended turn.
  skillsReachOf: async () => [
    await answer(
      "a scope that says nothing",
      async () => await Promise.resolve(brainSkills.skillsReachOf({}))
    ),
    await answer(
      "their own attended turn",
      async () =>
        await Promise.resolve(brainSkills.skillsReachOf({ ownChat: true }))
    ),
  ],
  // A task of the markers finds what one of their twins does: nothing.
  selectSkillsFor: async ({ personId, personal, markers, sharedWord }) => {
    const select = async (
      name: string,
      task: unknown,
      about?: Answer["about"],
      like?: string
    ) =>
      await answer(
        name,
        async () =>
          await brainSkills.selectSkillsFor(
            env,
            readersAgent(personId),
            { personal },
            task
          ),
        about,
        like
      );
    return [
      await select(
        "the markers",
        { task: markers.join(" ") },
        "hidden",
        "the markers"
      ),
      await select(
        "the markers",
        { task: markers.map(twinOf).join(" ") },
        "nothing",
        "the markers"
      ),
      await select(
        "beside the shared word",
        { task: `${sharedWord} ${markers.join(" ")}` },
        "hidden",
        "beside the shared word"
      ),
      await select(
        "beside the shared word",
        { task: `${sharedWord} ${markers.map(twinOf).join(" ")}` },
        "nothing",
        "beside the shared word"
      ),
      await select("a workflow, beside the markers", {
        task: `draw a workflow ${markers.join(" ")}`,
      }),
      await select("not a task", { task: markers }),
      await answer(
        "as someone who isn't a member",
        async () =>
          await brainSkills.selectSkillsFor(
            env,
            readersAgent(stranger()),
            { personal },
            { task: markers.join(" ") }
          )
      ),
    ];
  },
  readSkillFor: async ({ personId, personal, markers, hiddenSkills }) => {
    const read = async (name: string, skill: unknown) =>
      await answer(
        name,
        async () =>
          await brainSkills.readSkillFor(
            env,
            readersAgent(personId),
            { personal },
            { skill }
          )
      );
    await brainSkills.installShippedSkills(env);
    const usable = await brainSkills.skillsFor(env, readersAgent(personId), {
      personal: false,
    });
    const shipped = usable.find(({ scope }) => scope === "grasp");
    return [
      await read("a skill the release ships", shipped),
      await read("a skill never written", {
        scope: "company",
        name: "unwritten",
        version: 1,
      }),
      await read("a name of the markers", {
        scope: "company",
        name: markers.join("-"),
        version: 1,
      }),
      await read("a Grasp skill this release doesn't ship", {
        scope: "grasp",
        name: "unwritten",
        version: 1,
      }),
      await read("a version past any", {
        scope: "grasp",
        name: "draw-a-workflow",
        version: 1_000_000,
      }),
      await answer(
        "as someone who isn't a member",
        async () =>
          await brainSkills.readSkillFor(
            env,
            readersAgent(stranger()),
            { personal },
            { skill: { scope: "grasp", name: "draw-a-workflow", version: 1 } }
          )
      ),
      ...(await pairedOverSkills(
        hiddenSkills,
        async (name) =>
          await brainSkills.readSkillFor(
            env,
            readersAgent(personId),
            { personal },
            { skill: { scope: "person", name, version: 1 } }
          )
      )),
    ];
  },
} satisfies Record<SkillMember, Probe>;

/** What no caller reaches over RPC: the runtime's own handlers, such as the alarm. */
type Handler = keyof Rpc.DurableObjectBranded | "alarm";

/**
 * Each public method of the Brain's store: what it defines, not the
 * handlers its base class declares, which the runtime alone calls. The
 * store implements `Brain`, so the contract's members are among them.
 */
type StoreMember = {
  [Key in Exclude<keyof BrainStore, Handler>]-?: Key extends string
    ? Record<never, never> extends Pick<BrainStore, Key>
      ? never
      : Key
    : never;
}[Exclude<keyof BrainStore, Handler>];

/** Dimensions of the vectors the vector probes put: few, so they're cheap. */
const vectorDimensions = 64;

/** Codes the store re-scores at most (vectors.ts `rescoreCandidates`). */
const rescoredMost = 256;

/** Codes in a packed block of the store (vectors.ts `blockSize`). */
const vectorBlockSize = 1024;

/** A vector of random numbers from -1 to 1. */
const randomVector = (): number[] =>
  Array.from({ length: vectorDimensions }, () => Math.random() * 2 - 1);

/** A model of its own, with a centre of its own. */
const probeModel = (): VectorModel => ({
  name: `probe-${crypto.randomUUID()}@1`,
  centre: randomVector().map((value) => value / 10),
});

/** A chunk and the vector it is put with. */
type Coded = VectorsToPut["vectors"][number];

/**
 * A put, and whatever it answers: nothing today, as its type says, so an
 * answer a later put gives, for one chunk and not another, shows. Called
 * through `Reflect.apply`, which keeps the answer the type would drop.
 */
const putAnswering = async (request: unknown): Promise<unknown> => {
  const brain = store();
  const answered: unknown = await Reflect.apply(brain.putVectors, brain, [
    request,
  ]);
  return answered;
};

/** Puts `coded` for `model`, as many puts as it takes. */
const putAll = async (
  model: VectorModel,
  coded: readonly Coded[]
): Promise<void> => {
  for (let start = 0; start < coded.length; start += vectorsPerPutMax) {
    // oxlint-disable-next-line no-await-in-loop -- one put at a time
    await store().putVectors({
      model,
      vectors: coded.slice(start, start + vectorsPerPutMax),
    });
  }
};

/**
 * A source of `count` chunks `access` may read, each paragraph a chunk of
 * its own (over half a chunk's target, chunks.ts), every one holding
 * `words`: its chunks, as the contract names them.
 */
const chunkedSource = async (
  access: Access,
  count: number,
  words: string
): Promise<ChunkRef[]> => {
  const source = keyOf(missingSource());
  const { version } = await store().addSource({
    source,
    change: crypto.randomUUID(),
    text: Array.from({ length: count }, (_, index) =>
      `${words} ${index} `.padEnd(650, "x")
    ).join("\n\n"),
    access,
  });
  return Array.from({ length: count }, (_, position) => ({
    source,
    version,
    position,
  }));
};

/**
 * Erases the sources of `chunks` for good, once a vector probe is done
 * with them: someone else's filler, a block's worth of passages or more,
 * there only for the codes the probe put by hand. Left current, every
 * later probe that runs the queue with a model would embed them all
 * (`queuedVectors`), pass after pass, for no case of its own.
 */
const eraseFiller = async (
  ...chunks: readonly (readonly ChunkRef[])[]
): Promise<void> => {
  const sources = new Set(
    chunks.flatMap((each) => each.map(({ source }) => source))
  );
  for (const source of sources) {
    // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
    await store().eraseSource({ source, reason: "deleted" });
  }
};

/** `chunks`, each at `vector`. */
const placedAt = (chunks: readonly ChunkRef[], vector: number[]): Coded[] =>
  chunks.map((chunk) => ({ chunk, vector }));

/**
 * The embedders a probe hands the store to have its queue write vectors:
 * the embed package's int8 test model, run in the test's isolate.
 */
const testModelEmbedders = async (): Promise<Embedders> => {
  const { model } = await embedInProcess([]);
  return {
    model,
    embed: async ({ texts }) => {
      const embedded = await embedInProcess(texts);
      return {
        kind: "vectors",
        model: embedded.model,
        results: embedded.vectors,
      };
    },
  };
};

/**
 * Vectors the queue wrote itself, by the test model, of every source the
 * store holds, the marked ones too, each readable as its version is: the
 * reader searches them by the markers' own text and by a word nothing
 * holds, and what either finds of the hidden versions must be what it
 * finds of a source no one added: nothing.
 */
const queuedVectors = async ({
  reader,
  markers,
  hiddenVersions,
}: Pick<Probing, "reader" | "markers" | "hiddenVersions">): Promise<
  Answer[]
> => {
  const embedders = await testModelEmbedders();
  const ticked: Answer[] = [];
  /** Whether every current chunk has the test model's vectors or was passed over. */
  const allEmbedded = async (): Promise<boolean> => {
    const { embedding } = await store().workOverview();
    return (
      embedding.chunks > 0 &&
      embedding.embedded + embedding.unembeddable === embedding.chunks
    );
  };
  // The rebuild's walk and the queue's batches, until every chunk is in.
  // oxlint-disable-next-line no-await-in-loop -- one tick, then look again
  for (let round = 0; round < 10 && !(await allEmbedded()); round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    const answered = await answer(
      `a tick embedding, ${round + 1}`,
      async () => {
        await store().work({
          ask: quietModel,
          at: nextDay(),
          embedders,
          handOvers: noHandOvers,
          contextTokens: null,
        });
      }
    );
    ticked.push(answered);
  }
  // What the searches below read is the queue's own vectors, all of them.
  if (!(await allEmbedded())) {
    throw new Error("The queue didn't embed every chunk with the test model");
  }
  const model =
    embedders.model === null ? "" : vectorModelNameOf(embedders.model);
  const hidden = new Set(
    hiddenVersions.map(({ source, version }) => `${keyOf(source)}@${version}`)
  );
  const missing = keyOf(missingSource());
  const findOf = async (text: string, of: (chunk: ChunkRef) => boolean) => {
    const { vectors } = await embedInProcess([text]);
    const { chunks } = await store().searchVectors({
      model,
      vector: vectors[0] ?? [],
      reader,
      limit: vectorSearchLimitMax,
    });
    return chunks.filter(of);
  };
  const isHidden = ({ source, version }: ChunkRef) =>
    hidden.has(`${source}@${version}`);
  const isMissing = ({ source }: ChunkRef) => source === missing;
  const asked: Answer[] = [];
  for (const [name, text] of [
    ["the markers' text", markedText(markers)],
    ["a word nothing holds", "unheardofword"],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one search at a time
    const nothing = await answer(
      `vectors the queue wrote, by ${name}: of a source no one added`,
      async () => await findOf(text, isMissing),
      "nothing",
      `queued ${name}`
    );
    // oxlint-disable-next-line no-await-in-loop -- one search at a time
    const found = await answer(
      `vectors the queue wrote, by ${name}: of the hidden versions`,
      async () => await findOf(text, isHidden),
      "hidden",
      `queued ${name}`
    );
    asked.push(nothing, found);
  }
  return [
    ...ticked,
    ...asked,
    await answer(
      "the overview, the queue's vectors written",
      async () => await store().workOverview()
    ),
  ];
};

/** The first chunk of each of `versions`, as the contract names it. */
const firstChunksOf = (versions: Probing["hiddenVersions"]): ChunkRef[] =>
  versions.map(({ source, version }) => ({
    source: keyOf(source),
    version,
    position: 0,
  }));

/**
 * What the vector probes search with: a question, the reader's own chunks
 * at vectors of their own (found every time, so a hidden code that took a
 * place or moved a score would show), and a model holding those alone,
 * whose answer is what the reader gets when nothing hidden is stored.
 */
const vectorScene = async (reader: Reader & { person: string }) => {
  const question = randomVector();
  const own = await chunkedSource(
    { kind: "owner", person: reader.person },
    3,
    "The reader's own"
  );
  const ownCoded = own.map((chunk) => ({ chunk, vector: randomVector() }));
  /** A model with the reader's own codes in it, and `hidden` besides. */
  const modelWith = async (...hidden: Coded[][]): Promise<VectorModel> => {
    const model = probeModel();
    await putAll(model, ownCoded);
    for (const coded of hidden) {
      // oxlint-disable-next-line no-await-in-loop -- one put at a time
      await putAll(model, coded);
    }
    return model;
  };
  const search = async (
    model: VectorModel,
    vector = question,
    as: Reader = reader
  ) =>
    await store().searchVectors({
      model: model.name,
      vector,
      reader: as,
      limit: vectorSearchLimitMax,
    });
  return { question, ownCoded, modelWith, search };
};

/** `model` as the host's embedder names it: its name, and its build after the last `@`. */
const embedModelOf = ({ name }: VectorModel): EmbedModel => {
  const at = name.lastIndexOf("@");
  return { name: name.slice(0, at), build: name.slice(at + 1) };
};

/**
 * Recall by meaning (GRA-1769), with the codes of `vectorScene`: the
 * reader's own, and the hidden versions' at the question itself. Asked of
 * the markers, whole and in a few tokens, each pack must be exactly the
 * pack with nothing hidden stored: no hidden chunk returned, no order,
 * count, cut or word not found moved. Recall's meaning way is the vector
 * scan's (vectors.ts `closestOf`), whose hidden codes in a tail past the
 * candidates and in a packed block the `searchVectors` probe holds to the
 * same. And what the vector way refuses, each with the markers in it.
 */
const meaningProbes = async ({
  reader,
  markers,
  hiddenVersions,
}: Probing): Promise<Answer[]> => {
  const { question, modelWith } = await vectorScene(reader);
  const words = markedText(markers);
  const nothing = await modelWith();
  const hidden = await modelWith(
    placedAt(firstChunksOf(hiddenVersions), question)
  );
  const asked = (
    model: VectorModel,
    more: Partial<PackAsk> = {}
  ): Record<string, unknown> => ({
    question: words,
    reader,
    budget: { tokens: recallBudgetMax },
    meaning: { model: embedModelOf(model), vector: question },
    ...more,
  });
  const recallBy = async (request: Record<string, unknown>) =>
    await store().recall(unchecked(request));
  const compared: Answer[] = [];
  for (const [like, more] of [
    ["by meaning", {}],
    ["by meaning in 40 tokens", { budget: { tokens: 40 } }],
  ] as const) {
    for (const [name, model, about] of [
      ["nothing hidden stored", nothing, "nothing"],
      ["the hidden versions' codes at the question", hidden, "hidden"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one recall at a time
      const answered = await answer(
        `${like}, ${name}`,
        async () => await recallBy(asked(model, more)),
        about,
        like
      );
      compared.push(answered);
    }
  }
  const meaning = { model: embedModelOf(nothing), vector: question };
  // The question's own words, the markers, echoed in what was not found.
  return [
    ...compared,
    await answer(
      "by meaning, a vector of other dimensions",
      async () =>
        await recallBy({
          ...asked(nothing),
          meaning: { ...meaning, vector: question.slice(1) },
        })
    ),
    await answer(
      "by meaning, a model named by the markers",
      async () =>
        await recallBy({
          ...asked(nothing),
          meaning: { ...meaning, model: { ...meaning.model, name: words } },
        })
    ),
    await answer(
      "by meaning, a model named by the markers, too long",
      async () =>
        await recallBy({
          ...asked(nothing),
          meaning: {
            ...meaning,
            model: { ...meaning.model, name: words.repeat(modelNameMaxLength) },
          },
        })
    ),
    await answer(
      "by meaning, a build of the markers",
      async () =>
        await recallBy({
          ...asked(nothing),
          meaning: { ...meaning, model: { ...meaning.model, build: words } },
        })
    ),
    await answer(
      "by meaning, a vector of the markers",
      async () =>
        await recallBy({
          ...asked(nothing),
          meaning: { ...meaning, vector: markers },
        })
    ),
    await answer(
      "by meaning, a vector of zeros",
      async () =>
        await recallBy({
          ...asked(nothing),
          meaning: { ...meaning, vector: question.map(() => 0) },
        })
    ),
    await answer(
      "by meaning, with an unknown field",
      async () =>
        await recallBy({
          ...asked(nothing),
          meaning: { ...meaning, extra: words },
        })
    ),
  ].map((answered) => echoesHidden(answered, markers));
};

/** Each export of core's brain-recall.ts. */
type RecallMember = keyof typeof codeRecall;

/** An App's code acting for `personId`: an App's recall reads as the company. */
const readersApp = (personId: string): Authority =>
  authoritySchema.parse({
    subject: { type: "app", appId: `app-${crypto.randomUUID()}` },
    onBehalfOf: personId,
    mode: "interactive",
    appVersion: 1,
  });

/**
 * An App acting for `personId`, holding an active grant to read the
 * Brain, as an App's recall needs one (brain-recall.ts), naming `teams`
 * when given: its authority, and the grant's ID. Code's recall from an
 * App reads what everyone in the company may and, of the grant's teams,
 * those its person is in; so nothing of another team's or of a person's
 * own may come back, whoever it acts for.
 */
const appWithBrain = async (
  personId: string,
  teams?: readonly string[]
): Promise<{ authority: Authority; permissionId: string }> => {
  const authority = readersApp(personId);
  const permissionId = crypto.randomUUID();
  if (authority.subject.type !== "app") {
    throw new Error("Not an App");
  }
  await env.DB.prepare(
    "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, teams) VALUES (?, 'app', ?, 'platform', 'platform', '[\"brain\"]', 'BRAIN', 'active', ?, ?, ?)"
  )
    .bind(
      permissionId,
      authority.subject.appId,
      personId,
      Date.now(),
      teams === undefined ? null : JSON.stringify(teams)
    )
    .run();
  return { authority, permissionId };
};

/** An App recalling as `as`, in its own context, under `grant`. */
const callerOf = (as: Authority, grant: string): codeRecall.RecallCaller => ({
  authority: as,
  context:
    as.subject.type === "app"
      ? { type: "app", appId: as.subject.appId }
      : {
          type: "chat",
          workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
          chatId: chatIdSchema.parse(crypto.randomUUID()),
        },
  permissionId: permissionIdSchema.parse(grant),
  // An App's as the company; a chat's code as its person's teams, as in
  // their own chat in Grasp.
  ...(as.subject.type === "app" ? {} : { reach: "teams" as const }),
  actor: { type: "system" },
});

/** An App reading skills as `as`, under `grant`, keeping nothing. */
const skillsCallerOf = (
  as: Authority,
  grant: string
): codeRecall.SkillsCaller => {
  const { keep: _keep, ...caller } = callerOf(as, grant);
  return caller;
};

/** An App reading or writing memories as `as`, under `grant`, keeping nothing. */
const memoriesCallerOf = (as: Authority, grant: string) => {
  const { keep: _keep, ...caller } = callerOf(as, grant);
  return caller;
};

/** A recall as code asks for one, from what a probe asks. */
const codeAsk = ({ question, budget, asOf }: PackAsk) => ({
  question,
  budget,
  ...(asOf === undefined ? {} : { asOf: asOf.toISOString() }),
});

/** One probe per export of core's brain-recall.ts. */
export const recallProbes = {
  // Code's recall, as an App or a workflow makes it: under an App's
  // grant, acting for the reader, asked every way the store is, as code
  // sends it, then every way it refuses, the markers in what is refused.
  recallFor: async (probing) => {
    const { authority, permissionId } = await appWithBrain(
      probing.personId,
      probing.codeTeams
    );
    const recall = async (
      input: unknown,
      as = authority,
      grant = permissionId
    ) => await codeRecall.recallFor(env, callerOf(as, grant), input);
    const hidden = probing.markers.join(" ");
    const whole = { tokens: recallBudgetMax };
    return [
      ...(await askedOfMarkers(
        probing,
        momentsOf(probing),
        async (asking) => await recall(codeAsk(asking))
      )),
      await answer(
        "the shared word",
        async () =>
          await recall({ question: probing.sharedWord, budget: whole })
      ),
      await answer(
        "too long a question",
        async () =>
          await recall({
            question: `${hidden} `
              .repeat(questionMaxLength)
              .slice(0, questionMaxLength + 1),
            budget: whole,
          })
      ),
      await answer(
        "no tokens",
        async () => await recall({ question: hidden, budget: { tokens: 0 } })
      ),
      await answer(
        "a moment named by the markers",
        async () =>
          await recall({ question: hidden, budget: whole, asOf: hidden })
      ),
      await answer(
        "a reader named by the markers",
        async () =>
          await recall({ question: hidden, budget: whole, reader: hidden })
      ),
      await answer(
        "the markers, under a grant the App doesn't hold",
        async () =>
          await recall(
            { question: hidden, budget: whole },
            authority,
            crypto.randomUUID()
          )
      ),
      await answer(
        "the markers, for someone who isn't a member",
        async () =>
          await recall(
            { question: hidden, budget: whole },
            readersApp(stranger())
          )
      ),
    ];
  },
  // Code's skills, as an App or a workflow selects and reads them: under
  // an App's grant, acting for the reader, as the company alone; tasks and
  // skills of the markers, then every way it refuses.
  skillsCallFor: async ({ personId, markers, sharedWord }) => {
    const { authority, permissionId } = await appWithBrain(personId);
    await brainSkills.installShippedSkills(env);
    const call = async (
      name: string,
      operation: codeRecall.SkillsOperation,
      input: unknown,
      { as = authority, grant = permissionId } = {},
      about?: Answer["about"],
      like?: string
    ) =>
      await answer(
        name,
        async () =>
          await codeRecall.skillsCallFor(
            env,
            skillsCallerOf(as, grant),
            operation,
            input
          ),
        about,
        like
      );
    const hidden = markers.join(" ");
    const [shipped] = await brainSkills.skillsFor(env, authority, {
      personal: false,
    });
    return [
      await call(
        "the markers",
        "skills.select",
        { task: hidden },
        {},
        "hidden",
        "the markers"
      ),
      await call(
        "the markers",
        "skills.select",
        { task: markers.map(twinOf).join(" ") },
        {},
        "nothing",
        "the markers"
      ),
      await call(
        "beside the shared word",
        "skills.select",
        { task: `${sharedWord} ${hidden}` },
        {},
        "hidden",
        "beside the shared word"
      ),
      await call(
        "beside the shared word",
        "skills.select",
        { task: `${sharedWord} ${markers.map(twinOf).join(" ")}` },
        {},
        "nothing",
        "beside the shared word"
      ),
      await call("a workflow, beside the markers", "skills.select", {
        task: `draw a workflow ${hidden}`,
      }),
      await call("not a task", "skills.select", { task: markers }),
      await call("a skill the release ships", "skills.read", {
        skill: shipped,
      }),
      await call("a name of the markers", "skills.read", {
        skill: { scope: "company", name: markers.join("-"), version: 1 },
      }),
      await call("a scope of the markers", "skills.read", {
        skill: { scope: hidden, name: "draw-a-workflow", version: 1 },
      }),
      // A person's own skill, named by the markers or their twins: code
      // may name none (each pair from one call site, as the answers are
      // compared whole). That code never reaches the reader's own store,
      // where their skills are, the pass's store watch holds.
      ...(await Promise.all(
        [markers.join("-"), markers.map(twinOf).join("-")].map(
          async (name, at) =>
            await call(
              "a person's own skill",
              "skills.read",
              { skill: { scope: "person", name, version: 1 } },
              {},
              at === 0 ? "hidden" : "nothing",
              "own read"
            )
        )
      )),
      await call(
        "the markers, under a grant the App doesn't hold",
        "skills.select",
        { task: hidden },
        { grant: crypto.randomUUID() }
      ),
      await call(
        "the markers, for someone who isn't a member",
        "skills.select",
        { task: hidden },
        { as: readersApp(stranger()) }
      ),
      await call(
        "a skill, for someone who isn't a member",
        "skills.read",
        { skill: shipped },
        { as: readersApp(stranger()) }
      ),
    ];
  },
  // Code's memories and entities, as an App reads and writes them: under
  // its grants to read and to write the Brain, acting for the reader, as
  // the company alone; every way they answer what the company may not
  // read, then every way they refuse.
  memoriesCallFor: async (probing) => {
    const { personId, markers } = probing;
    const { authority, permissionId } = await appWithBrain(personId);
    if (authority.subject.type !== "app") {
      throw new Error("Not an App");
    }
    await env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at) VALUES (?, 'app', ?, 'platform', 'platform', '[\"brain.write\"]', 'BRAIN_WRITE', 'active', ?, ?)"
    )
      .bind(crypto.randomUUID(), authority.subject.appId, personId, Date.now())
      .run();
    const fixture = await recallFixture(probing);
    const writer = `app:${authority.subject.appId}`;
    const hidden = await hiddenWritten(writer, markers);
    const call = async (
      name: string,
      operation: codeRecall.MemoriesOperation,
      input: unknown,
      about?: Answer["about"],
      { as = authority, grant = permissionId } = {},
      like?: string
    ) =>
      await answer(
        name,
        async () =>
          await codeRecall.memoriesCallFor(
            env,
            {
              ...memoriesCallerOf(as, grant),
              writer,
              change: crypto.randomUUID(),
              mayWrite: async () => {
                await Promise.resolve();
              },
            },
            operation,
            input
          ),
        about,
        like
      );
    const text = markedText(markers);
    const fix = { value: "Fixed", statement: "Fixed" };
    const plain = "A plain fact";
    // One call site for every case: a refusal's stack is then the same,
    // hidden or not.
    const cases: [
      string,
      codeRecall.MemoriesOperation,
      unknown,
      Answer["about"],
      { as?: Authority; grant?: string },
      string | undefined,
    ][] = [
      [
        "a card no one has",
        "entities.get",
        { entity: crypto.randomUUID() },
        "nothing",
        {},
        "card",
      ],
      [
        "a hidden card",
        "entities.get",
        { entity: fixture.hidden },
        "hidden",
        {},
        "card",
      ],
      [
        "the reader's team's card",
        "entities.get",
        { entity: fixture.seen },
        "hidden",
        {},
        "card",
      ],
      [
        "a name no one gave",
        "entities.find",
        { name: markers.map(twinOf).join(" ") },
        "nothing",
        {},
        "find",
      ],
      ["a hidden name", "entities.find", { name: text }, "hidden", {}, "find"],
      [
        "forget one no one wrote",
        "forget",
        { memory: crypto.randomUUID() },
        "nothing",
        {},
        "forget",
      ],
      [
        "forget its own, hidden",
        "forget",
        { memory: hidden },
        "hidden",
        {},
        "forget",
      ],
      [
        "correct one no one wrote",
        "correct",
        { memory: crypto.randomUUID(), ...fix },
        "nothing",
        {},
        "correct",
      ],
      [
        "correct a hidden one",
        "correct",
        { memory: fixture.hiddenMemory, ...fix },
        "hidden",
        {},
        "correct",
      ],
      [
        "about no one",
        "remember",
        {
          about: { kind: "customer", id: crypto.randomUUID() },
          statement: plain,
        },
        "nothing",
        {},
        "remember",
      ],
      [
        "about a hidden one",
        "remember",
        { about: { kind: "customer", id: fixture.hidden }, statement: plain },
        "hidden",
        {},
        "remember",
      ],
      [
        "a request naming readers of the markers",
        "remember",
        {
          about: { kind: "customer", names: [text] },
          statement: text,
          readers: text,
        },
        undefined,
        {},
        undefined,
      ],
      [
        "the markers, under a grant the App doesn't hold",
        "entities.get",
        { entity: fixture.hidden },
        undefined,
        { grant: crypto.randomUUID() },
        undefined,
      ],
      [
        "the markers, for someone who isn't a member",
        "entities.find",
        { name: text },
        undefined,
        { as: readersApp(stranger()) },
        undefined,
      ],
    ];
    const answers: Answer[] = [];
    for (const [name, operation, input, about, as, like] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one call site, one at a time
      answers.push(await call(name, operation, input, about, as, like));
    }
    return answers;
  },
  // Pure: what a request is, never what it holds.
  isMemoriesRequest: async ({ markers }) => {
    const is = async (name: string, operation: string, input: unknown) =>
      await answer(name, async () => {
        await Promise.resolve();
        return codeRecall.isMemoriesRequest(unchecked(operation), input);
      });
    const hidden = markers.join(" ");
    return [
      await is("a find", "entities.find", { kind: "customer" }),
      await is("one naming a reader of the markers", "entities.find", {
        name: hidden,
        reader: hidden,
      }),
      await is("an operation of the markers", hidden, { name: hidden }),
    ];
  },
  // Pure: what a request is, never what it holds.
  isBrainRecall: async ({ markers, sharedWord }) => {
    const is = async (name: string, input: unknown) =>
      await answer(name, async () => {
        await Promise.resolve();
        return codeRecall.isBrainRecall(input);
      });
    const hidden = markers.join(" ");
    return [
      await is("a request", { question: sharedWord, budget: { tokens: 1 } }),
      await is("one naming a reader of the markers", {
        question: hidden,
        budget: { tokens: 1 },
        reader: hidden,
      }),
      await is("a moment of the markers", {
        question: hidden,
        budget: { tokens: 1 },
        asOf: hidden,
      }),
    ];
  },
} satisfies Record<RecallMember, Probe>;

/** The probes of the store's memories and entities. */
const memoryProbes = {
  addMemories: async ({ markers }) => {
    const text = markedText(markers);
    const add = async (name: string, adding: unknown) =>
      await answer(
        name,
        async () => await store().addMemories(unchecked(adding))
      );
    const entities = [{ key: "c", kind: "customer", names: [text] }];
    const memory = {
      about: "c",
      type: "fact",
      statement: text,
      speaker: { kind: "system" },
      basis: { kind: "writer", writer: stranger() },
    };
    const adding = {
      change: crypto.randomUUID(),
      access: { kind: "audience", group: stranger() },
      entities,
      memories: [memory],
    };
    return [
      await add("for a group the reader isn't in", adding),
      await add("for someone else alone, which the shared store refuses", {
        ...adding,
        change: crypto.randomUUID(),
        access: { kind: "owner", person: stranger() },
      }),
      await add("the same change again", adding),
      await add("the same change with other memories", {
        ...adding,
        memories: [{ ...memory, statement: `${text} again` }],
      }),
      await add("an outside party's instruction", {
        ...adding,
        change: crypto.randomUUID(),
        memories: [
          { ...memory, type: "instruction", speaker: { kind: "outside" } },
        ],
      }),
      await add("an attribute the kind hasn't", {
        ...adding,
        change: crypto.randomUUID(),
        memories: [{ ...memory, attribute: text, value: text }],
      }),
      await add("a version the store doesn't hold", {
        ...adding,
        change: crypto.randomUUID(),
        memories: [
          {
            ...memory,
            basis: { kind: "source", source: text, version: 1, quote: text },
          },
        ],
      }),
      await add("an unknown field", {
        ...adding,
        change: crypto.randomUUID(),
        extra: text,
      }),
    ];
  },
  readMemories: async (probing) => {
    const { reader } = probing;
    const fixture = await memoryFixture(probing);
    const read = async (
      name: string,
      entity: string,
      about: Answer["about"],
      extra: { history?: boolean; asOf?: Date } = {}
    ) =>
      await answer(
        name,
        async () => await store().readMemories({ entity, reader, ...extra }),
        about,
        extra.history === true ? "history" : undefined
      );
    return [
      await read("an entity no one added", crypto.randomUUID(), "nothing"),
      await read(
        "an entity only hidden memories name",
        fixture.hidden,
        "hidden"
      ),
      await read(
        "an entity drawn from a hidden source",
        fixture.drawn,
        "hidden"
      ),
      await read("no one's, with history", crypto.randomUUID(), "nothing", {
        history: true,
      }),
      await read("hidden, with history", fixture.hidden, "hidden", {
        history: true,
      }),
      await read(
        "the reader's own, which hidden ones end and contest",
        fixture.seen,
        undefined,
        {
          history: true,
        }
      ),
      await read("the reader's own, as of now", fixture.seen, undefined, {
        asOf: new Date(),
      }),
    ];
  },
  listContested: async (probing) => {
    const { reader } = probing;
    const fixture = await memoryFixture(probing);
    const list = async (
      name: string,
      entity: string | null,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        // The moment each page was read at (its `at`, and its cursor's)
        // differs between calls: it moves with every write, a hidden one
        // too, which tells a reader that some write happened and nothing
        // of what or for whom (threat model, GRA-1739). Compared without it.
        async () => {
          const { facts, more, next } = await store().listContested({
            reader,
            ...(entity === null ? {} : { entity }),
          });
          return {
            facts,
            more,
            ...(next === undefined
              ? {}
              : {
                  next: {
                    learnedAt: next.learnedAt,
                    entity: next.entity,
                    attribute: next.attribute,
                  },
                }),
          };
        },
        about
      );
    return [
      await list("an entity no one added", crypto.randomUUID(), "nothing"),
      await list("one only hidden memories contest", fixture.seen, "hidden"),
      await list(
        "an entity only hidden memories name",
        fixture.hidden,
        "hidden"
      ),
      await list("any", null),
    ];
  },
  retireMemory: async (probing) => {
    const fixture = await memoryFixture(probing);
    const retire = async (
      name: string,
      memory: string,
      writer: string,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () =>
          await store().retireMemory({
            memory,
            reader: { ...probing.reader, person: writer },
          }),
        about
      );
    return [
      await retire(
        "a memory no one added",
        crypto.randomUUID(),
        probing.personId,
        "nothing"
      ),
      await retire(
        "a hidden memory",
        fixture.hiddenMemory,
        probing.personId,
        "hidden"
      ),
      await retire(
        "a hidden memory, as the reader",
        fixture.hiddenMemory,
        probing.reader.person,
        "hidden"
      ),
      await retire(
        "a memory named by the markers",
        probing.markers.join(""),
        probing.personId
      ),
    ];
  },
  confirmMemory: async (probing) => {
    const { reader } = probing;
    const fixture = await memoryFixture(probing);
    const confirm = async (
      name: string,
      memory: string,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await store().confirmMemory({ memory, reader }),
        about
      );
    return [
      await confirm("a memory no one added", crypto.randomUUID(), "nothing"),
      await confirm("a hidden memory", fixture.hiddenMemory, "hidden"),
      await confirm(
        "the reader's own, which hidden ones contest",
        fixture.seenMemory
      ),
      await answer(
        "the reader's own, once confirmed",
        async () =>
          await store().readMemories({
            entity: fixture.seen,
            reader,
            history: true,
          })
      ),
    ];
  },
  correctMemory: async (probing) => {
    const { reader, markers } = probing;
    const fixture = await memoryFixture(probing);
    const writer = codeWriter();
    const correct = async (
      name: string,
      memory: string,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () =>
          await store().correctMemory({
            change: crypto.randomUUID(),
            memory,
            reader,
            writer,
            speaker: { kind: "agent", agent: writer },
            value: "Fixed",
            statement: "Fixed",
          }),
        about
      );
    return [
      await correct("a memory no one added", crypto.randomUUID(), "nothing"),
      await correct("a hidden memory", fixture.hiddenMemory, "hidden"),
      await correct("an id of the markers", markers.join("")),
      // The reader's own, which hidden memories contest: its fix is read
      // by the reader's group alone, as the memory it corrects.
      await answer("the reader's own, once corrected", async () => {
        await store().correctMemory({
          change: crypto.randomUUID(),
          memory: fixture.seenMemory,
          reader,
          writer,
          speaker: { kind: "agent", agent: writer },
          value: "Fixed",
          statement: "Fixed",
        });
        return await store().readMemories({
          entity: fixture.seen,
          reader,
          history: true,
        });
      }),
    ];
  },
  findEntities: async (probing) => {
    const { reader, markers } = probing;
    const fixture = await memoryFixture(probing);
    const find = async (
      name: string,
      asked: Omit<EntitiesRequest, "reader">,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await store().findEntities({ reader, ...asked }),
        about
      );
    const twin = `ref:${crypto.randomUUID()}`;
    return [
      await find(
        "a name nothing holds",
        { name: crypto.randomUUID() },
        "nothing"
      ),
      await find(
        "a name only hidden memories give",
        { name: markedText(markers) },
        "hidden"
      ),
      await find(
        "a reference nothing holds",
        { identifier: { type: "ref", value: twin } },
        "nothing"
      ),
      await find(
        "a reference only hidden memories give",
        {
          identifier: { type: "ref", value: fixture.hiddenRef },
        },
        "hidden"
      ),
      await find("customers", { kind: "customer" }),
      await find("the reader's own by its name", {
        name: "Plain",
        kind: "customer",
      }),
    ];
  },
  readEntityNames: async (probing) => {
    const { reader } = probing;
    const fixture = await memoryFixture(probing);
    const read = async (
      name: string,
      entity: string,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await store().readEntityNames({ entity, reader }),
        about
      );
    return [
      await read("an entity no one added", crypto.randomUUID(), "nothing"),
      await read(
        "an entity only hidden memories name",
        fixture.hidden,
        "hidden"
      ),
      await read(
        "an entity drawn from a hidden source",
        fixture.drawn,
        "hidden"
      ),
      await read(
        "the reader's own, which hidden memories also name",
        fixture.seen
      ),
    ];
  },
  readEntity: async (probing) => {
    const { reader } = probing;
    const fixture = await memoryFixture(probing);
    const read = async (
      name: string,
      entity: string,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await store().readEntity({ entity, reader }),
        about
      );
    return [
      await read("an entity no one added", crypto.randomUUID(), "nothing"),
      await read(
        "an entity only hidden memories name",
        fixture.hidden,
        "hidden"
      ),
      await read(
        "an entity drawn from a hidden source",
        fixture.drawn,
        "hidden"
      ),
      await read(
        "the reader's own, which hidden memories also name",
        fixture.seen
      ),
    ];
  },
} satisfies Record<string, Probe>;

/**
 * A person's memories, as a surface reaches them for `personId`: core's
 * functions (brain-next.ts) or the callers' (brain-memories.ts). Each
 * saves in the person's own word, in their own store.
 */
interface PersonMemoryCalls {
  remember: (
    personId: string,
    remembered: Readonly<Record<string, unknown>>
  ) => Promise<unknown>;
  forget: (personId: string, memory: string) => Promise<unknown>;
}

/**
 * The probes of a person's memories over `calls`. What a probe saves for
 * the reader holds no marker: it is theirs to read, and later probes may
 * find it. Markers go only in what is refused, and in others' memories,
 * the hidden ones of `memoryFixture` and of someone else's own store.
 */
const personMemoryProbes = (calls: PersonMemoryCalls) => {
  const plain = {
    type: "fact",
    statement: "Plain note",
    quote: "Plain note",
    attribute: "status",
    value: "Active",
  };
  return {
    remember: async (probing: Probing): Promise<Answer[]> => {
      const { personId, markers } = probing;
      const [fixture, others] = await Promise.all([
        memoryFixture(probing),
        othersOwnMemory(markers),
      ]);
      const about = (id: string) => ({
        change: crypto.randomUUID(),
        about: { id, kind: "customer" },
        ...plain,
      });
      // Each hidden id against the one no one holds, by what it answers
      // or the words it is refused with: a stack names where it was asked.
      const rememberAbout = async (
        name: string,
        id: string,
        compared: Answer["about"]
      ) =>
        await answer(
          name,
          async () => {
            try {
              return { saved: await calls.remember(personId, about(id)) };
            } catch (error) {
              return {
                refused: error instanceof Error ? error.message : error,
              };
            }
          },
          compared
        );
      return [
        await answer(
          "a plain memory of their own",
          async () =>
            await calls.remember(personId, {
              change: crypto.randomUUID(),
              about: { kind: "customer", names: ["Plain"] },
              ...plain,
            })
        ),
        ...(await Promise.all(
          (
            [
              ["about an entity no one added", crypto.randomUUID(), "nothing"],
              [
                "about an entity only hidden memories name",
                fixture.hidden,
                "hidden",
              ],
              [
                "about an entity drawn from a hidden source",
                fixture.drawn,
                "hidden",
              ],
              [
                "about an entity in someone else's own store",
                others.entity,
                "hidden",
              ],
            ] as const
          ).map(
            async ([name, id, compared]) =>
              await rememberAbout(name, id, compared)
          )
        )),
        await answer(
          "for someone who isn't a member",
          async () =>
            await calls.remember(stranger(), {
              change: crypto.randomUUID(),
              about: { kind: "customer", names: ["Plain"] },
              ...plain,
            })
        ),
        await answer(
          "an attribute named by the markers",
          async () =>
            await calls.remember(personId, {
              change: crypto.randomUUID(),
              about: { kind: "customer", names: ["Plain"] },
              ...plain,
              attribute: markers.join("_").slice(0, 64),
            })
        ),
        await answer(
          "a statement past its limit, of the markers",
          async () =>
            await calls.remember(personId, {
              change: crypto.randomUUID(),
              about: { kind: "customer", names: ["Plain"] },
              ...plain,
              statement: markedText(markers).padEnd(2000, " x"),
            })
        ),
        await answer(
          "an unknown field holding the markers",
          async () =>
            await calls.remember(personId, {
              change: crypto.randomUUID(),
              about: { kind: "customer", names: ["Plain"] },
              ...plain,
              readers: markers,
            })
        ),
      ];
    },
    forget: async (probing: Probing): Promise<Answer[]> => {
      const { personId, markers } = probing;
      const [fixture, others] = await Promise.all([
        memoryFixture(probing),
        othersOwnMemory(markers),
      ]);
      const forget = async (
        name: string,
        memory: string,
        about?: Answer["about"]
      ) =>
        await answer(
          name,
          async () => await calls.forget(personId, memory),
          about
        );
      return [
        await forget("a memory no one saved", crypto.randomUUID(), "nothing"),
        await forget("a hidden memory", fixture.hiddenMemory, "hidden"),
        await forget(
          "a memory in someone else's own store",
          others.memory,
          "hidden"
        ),
        await forget(
          "the reader's memory of another writer",
          fixture.seenMemory,
          "hidden"
        ),
        await answer(
          "as someone who isn't a member",
          async () => await calls.forget(stranger(), others.memory)
        ),
        await answer(
          "an id of the markers",
          async () => await calls.forget(personId, markers.join(""))
        ),
      ];
    },
  } satisfies Record<keyof PersonMemoryCalls, Probe>;
};

/**
 * The Brain's Memories page (GRA-1746) for `personId`, as a surface
 * reaches it: core's functions (brain-next.ts), the callers' that audit
 * (brain-memories.ts) or the page's RPC (brain-memories-rpc.ts). Places
 * and cursors are as core's functions take them, their moments dates; a
 * surface that carries them as text converts them itself.
 */
interface MemoryPageCalls {
  entities: (
    personId: string,
    kind: unknown,
    from?: Readonly<Record<string, unknown>>
  ) => Promise<unknown>;
  memories: (
    personId: string,
    entity: Readonly<Record<string, unknown>>,
    after?: Readonly<Record<string, unknown>>
  ) => Promise<unknown>;
  contested: (
    personId: string,
    from?: Readonly<Record<string, unknown>>
  ) => Promise<unknown>;
  confirm: (
    personId: string,
    memory: Readonly<Record<string, unknown>>
  ) => Promise<unknown>;
  correct: (
    personId: string,
    correction: Readonly<Record<string, unknown>>
  ) => Promise<unknown>;
}

/**
 * The entities a probe of the page asks of: one no one added (`nothing`),
 * and as hidden: one only hidden memories name, one drawn from a hidden
 * source, and one in someone else's own store, asked of in the reader's.
 */
const pageEntities = (
  fixture: MemoryFixture,
  others: { entity: string }
): [string, Readonly<Record<string, unknown>>, Answer["about"]][] => [
  [
    "an entity no one added",
    { store: "shared", id: crypto.randomUUID() },
    "nothing",
  ],
  [
    "one only hidden memories name",
    { store: "shared", id: fixture.hidden },
    "hidden",
  ],
  [
    "one drawn from a hidden source",
    { store: "shared", id: fixture.drawn },
    "hidden",
  ],
  [
    "one in someone else's own store",
    { store: "own", id: others.entity },
    "hidden",
  ],
];

/**
 * The memories a probe of the page asks of: one no one saved (`nothing`),
 * and as hidden: a hidden one, and one in someone else's own store, asked
 * of in the reader's.
 */
const pageMemories = (
  fixture: MemoryFixture,
  others: { entity: string; memory: string }
): [string, Readonly<Record<string, unknown>>, Answer["about"]][] => [
  [
    "a memory no one saved",
    { store: "shared", entity: fixture.hidden, memory: crypto.randomUUID() },
    "nothing",
  ],
  [
    "a hidden memory",
    { store: "shared", entity: fixture.hidden, memory: fixture.hiddenMemory },
    "hidden",
  ],
  [
    "a memory in someone else's own store",
    { store: "own", entity: others.entity, memory: others.memory },
    "hidden",
  ],
];

/** A plain correction of `wrong`, holding no marker. */
const plainCorrection = (wrong: Readonly<Record<string, unknown>>) => ({
  wrong,
  right: "Plain correction",
  change: crypto.randomUUID(),
});

/** A store's place in a listing past every item: a page after it is empty. */
const placePast = (entity: string) => ({
  at: new Date(),
  learnedAt: pastAll,
  entity,
});

/** The probes of the Memories page over `calls`, one per call. */
const memoryPageProbes = (calls: MemoryPageCalls) => {
  /** The fixture of hidden memories, and someone else's own memory. */
  const scene = async (probing: Probing) =>
    await Promise.all([
      memoryFixture(probing),
      othersOwnMemory(probing.markers),
    ]);
  return {
    entities: async (probing: Probing): Promise<Answer[]> => {
      const { personId, markers } = probing;
      const [fixture] = await scene(probing);
      const list = async (
        name: string,
        from?: Readonly<Record<string, unknown>>,
        about?: Answer["about"],
        as = personId
      ) =>
        await answer(
          name,
          async () => await calls.entities(as, "customer", from),
          about
        );
      return [
        await list("every customer they may see"),
        await list("their own store's first page", { store: "own" }),
        await list("the shared store's first page", { store: "shared" }),
        await list(
          "after an entity no one added",
          { store: "shared", after: placePast(crypto.randomUUID()) },
          "nothing"
        ),
        await list(
          "after a hidden entity",
          { store: "shared", after: placePast(fixture.hidden) },
          "hidden"
        ),
        await list(
          "as someone who isn't a member",
          undefined,
          undefined,
          stranger()
        ),
        await answer(
          "a kind named by the markers",
          async () => await calls.entities(personId, markers.join(""))
        ),
        await list("a store named by the markers", { store: markers.join("") }),
        await list("after a place named by the markers", {
          store: "shared",
          after: {
            ...placePast(markers.join("")),
            learnedAt: markers.join(" "),
          },
        }),
      ];
    },
    memories: async (probing: Probing): Promise<Answer[]> => {
      const { personId, markers } = probing;
      const [fixture, others] = await scene(probing);
      return [
        ...(await Promise.all(
          pageEntities(fixture, others).map(
            async ([name, entity, about]) =>
              await answer(
                name,
                async () => await calls.memories(personId, entity),
                about
              )
          )
        )),
        // The reader's entity, which hidden memories end and contest.
        await answer(
          "an entity they may see",
          async () =>
            await calls.memories(personId, {
              store: "shared",
              id: fixture.seen,
            })
        ),
        await answer(
          "as someone who isn't a member",
          async () =>
            await calls.memories(stranger(), {
              store: "own",
              id: others.entity,
            })
        ),
        await answer(
          "after a place named by the markers",
          async () =>
            await calls.memories(
              personId,
              { store: "shared", id: fixture.seen },
              {
                at: new Date(),
                learned: new Date(),
                attribute: markers.join(""),
                confirmed: false,
                learnedAt: new Date(),
                memory: markers.join(""),
              }
            )
        ),
      ];
    },
    contested: async (probing: Probing): Promise<Answer[]> => {
      const { personId, markers } = probing;
      await scene(probing);
      return [
        // Hidden memories contest the reader's: none of it shows.
        await answer(
          "every fact they may read",
          async () => await calls.contested(personId)
        ),
        await answer(
          "the shared store's first page",
          async () => await calls.contested(personId, { store: "shared" })
        ),
        await answer(
          "as someone who isn't a member",
          async () => await calls.contested(stranger())
        ),
        await answer(
          "after a place named by the markers",
          async () =>
            await calls.contested(personId, {
              store: "shared",
              after: {
                at: new Date(),
                learnedAt: new Date(),
                entity: markers.join(""),
                attribute: markers.join(" "),
              },
            })
        ),
      ];
    },
    confirm: async (probing: Probing): Promise<Answer[]> => {
      const { personId, markers } = probing;
      const [fixture, others] = await scene(probing);
      const asked: Answer[] = [];
      for (const [name, memory, about] of pageMemories(fixture, others)) {
        // oxlint-disable-next-line no-await-in-loop -- one write at a time
        const answered = await answer(
          name,
          // A confirmation names the memory by its store and id alone.
          async () =>
            await calls.confirm(personId, {
              store: memory.store,
              memory: memory.memory,
            }),
          about
        );
        asked.push(answered);
      }
      asked.push(
        await answer(
          "as someone who isn't a member",
          async () =>
            await calls.confirm(stranger(), {
              store: "own",
              memory: others.memory,
            })
        ),
        await answer(
          "an id of the markers",
          async () =>
            await calls.confirm(personId, {
              store: "shared",
              memory: markers.join(""),
            })
        )
      );
      return asked;
    },
    correct: async (probing: Probing): Promise<Answer[]> => {
      const { personId, markers } = probing;
      const [fixture, others] = await scene(probing);
      const asked: Answer[] = [];
      for (const [name, memory, about] of pageMemories(fixture, others)) {
        // oxlint-disable-next-line no-await-in-loop -- one write at a time
        const answered = await answer(
          name,
          async () => await calls.correct(personId, plainCorrection(memory)),
          about
        );
        asked.push(answered);
      }
      const hidden = {
        store: "shared",
        entity: fixture.hidden,
        memory: fixture.hiddenMemory,
      };
      asked.push(
        await answer(
          "as someone who isn't a member",
          async () => await calls.correct(stranger(), plainCorrection(hidden))
        ),
        await answer(
          "a change named by the markers",
          async () =>
            await calls.correct(personId, {
              ...plainCorrection(hidden),
              change: markers.join(""),
            })
        ),
        await answer(
          "too long a correction of the markers",
          async () =>
            await calls.correct(personId, {
              ...plainCorrection(hidden),
              right: oversizedText(markers),
            })
        )
      );
      return asked;
    },
  } satisfies Record<keyof MemoryPageCalls, Probe>;
};

/** The page's calls through core's own functions (brain-next.ts). */
const corePageCalls: MemoryPageCalls = {
  entities: async (personId, kind, from) =>
    await coreBrain.entitiesAs(env, personId, {
      kind,
      ...(from === undefined ? {} : { from }),
    }),
  memories: async (personId, entity, after) =>
    await coreBrain.memoriesAs(env, personId, {
      entity,
      ...(after === undefined ? {} : { after }),
    }),
  contested: async (personId, from) =>
    await coreBrain.contestedAs(
      env,
      personId,
      from === undefined ? {} : { from }
    ),
  confirm: async (personId, memory) =>
    await coreBrain.confirmAs(env, personId, memory),
  correct: async (personId, correction) =>
    await coreBrain.correctAs(env, personId, correction),
};

/** The page through core's own functions. */
const corePageProbes = memoryPageProbes(corePageCalls);

/** A person's memories through core's own functions (brain-next.ts). */
const corePersonProbes = personMemoryProbes({
  remember: async (personId, remembered) =>
    await coreBrain.rememberAs(env, personId, remembered),
  forget: async (personId, memory) =>
    await coreBrain.forgetAs(env, personId, memory),
});

/** One probe per export of core's brain-next.ts for a person's memories. */
const corePersonMemories = {
  rememberAs: corePersonProbes.remember,
  forgetAs: corePersonProbes.forget,
  entitiesAs: corePageProbes.entities,
  memoriesAs: corePageProbes.memories,
  contestedAs: corePageProbes.contested,
  confirmAs: corePageProbes.confirm,
  correctAs: corePageProbes.correct,
  // An entity of the reader's own store: one in the shared store, one in
  // someone else's own store and one no one added answer alike.
  ownEntityAs: async (probing) => {
    const { personId, markers } = probing;
    const [fixture, others] = await Promise.all([
      memoryFixture(probing),
      othersOwnMemory(markers),
    ]);
    const read = async (
      name: string,
      entity: string,
      about?: Answer["about"],
      as = personId
    ) =>
      await answer(
        name,
        async () => await coreBrain.ownEntityAs(env, as, entity),
        about
      );
    return [
      await read("an entity no one added", crypto.randomUUID(), "nothing"),
      await read("one only hidden memories name", fixture.hidden, "hidden"),
      await read("one drawn from a hidden source", fixture.drawn, "hidden"),
      await read("one in someone else's own store", others.entity, "hidden"),
      await read(
        "as someone who isn't a member",
        others.entity,
        undefined,
        stranger()
      ),
      await read("an id of the markers", markers.join("")),
    ];
  },
  // The Brain's own lists and bounds, the same for every reader: no reader
  // asks, and no marker can be in them.
  memoryChoices: async () => [
    await answer(
      "the lists",
      async () => await Promise.resolve(coreBrain.memoryChoices)
    ),
  ],
} satisfies Record<CorePersonMember, Probe>;

// Code's memories and entities (GRA-1837): read and written as the
// company alone, so everything a team or a person may read is hidden from
// them, the reader's own team's among it (the fixture's `seen`).
const coreCodeMemories = {
  rememberForCompanyAs: async (probing) => {
    const { personId, markers } = probing;
    const fixture = await recallFixture(probing);
    const writer = codeWriter();
    const remember = async (
      name: string,
      entity: Record<string, unknown>,
      about?: Answer["about"],
      { as = personId, change = crypto.randomUUID() } = {}
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.rememberForCompanyAs(
            env,
            as,
            { writer, change },
            { about: entity, statement: "A plain fact" }
          ),
        about
      );
    // One call site for every entity asked about: a refusal's stack is
    // then the same, hidden or not.
    const answers: Answer[] = [];
    for (const [name, id, about] of [
      ["about an entity no one added", crypto.randomUUID(), "nothing"],
      ["about one only hidden memories name", fixture.hidden, "hidden"],
      ["about one drawn from a hidden source", fixture.drawn, "hidden"],
      ["about one the reader's team alone reads", fixture.seen, "hidden"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one call site, one at a time
      answers.push(await remember(name, customerById(id), about));
    }
    return [
      ...answers,
      await remember(
        "as someone who isn't a member",
        { kind: "customer", names: ["Plain"] },
        undefined,
        { as: stranger() }
      ),
      await remember(
        "under a change named by the markers",
        { kind: "customer", names: ["Plain"] },
        undefined,
        // A change is at most 256 characters: one marker fits.
        { change: `${writer}/${first(markers)}` }
      ),
    ];
  },
  forgetForCompanyAs: async (probing) => {
    const { personId, markers } = probing;
    const fixture = await recallFixture(probing);
    const writer = codeWriter();
    const hidden = await hiddenWritten(writer, markers);
    const forget = async (
      name: string,
      memory: string,
      about?: Answer["about"],
      as = personId
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.forgetForCompanyAs(env, as, writer, { memory }),
        about
      );
    return [
      await forget("a memory no one added", crypto.randomUUID(), "nothing"),
      await forget("its own, hidden from the company", hidden, "hidden"),
      await forget("a hidden memory", fixture.hiddenMemory, "hidden"),
      await forget(
        "one the reader's team alone reads",
        fixture.seenMemory,
        "hidden"
      ),
      await forget(
        "as someone who isn't a member",
        hidden,
        undefined,
        stranger()
      ),
      await forget("an id of the markers", markers.join("")),
    ];
  },
  correctForCompanyAs: async (probing) => {
    const { personId, markers } = probing;
    const fixture = await recallFixture(probing);
    const writer = codeWriter();
    const correct = async (
      name: string,
      memory: string,
      about?: Answer["about"],
      as = personId
    ) =>
      await answer(
        name,
        async () =>
          await coreBrain.correctForCompanyAs(
            env,
            as,
            { writer, change: crypto.randomUUID() },
            { memory, value: "Fixed", statement: "Fixed" }
          ),
        about
      );
    return [
      await correct("a memory no one added", crypto.randomUUID(), "nothing"),
      await correct("a hidden memory", fixture.hiddenMemory, "hidden"),
      await correct(
        "one the reader's team alone reads",
        fixture.seenMemory,
        "hidden"
      ),

      await correct(
        "as someone who isn't a member",
        fixture.seenMemory,
        undefined,
        stranger()
      ),
      await correct("an id of the markers", markers.join("")),
    ];
  },
  companyCardAs: async (probing) => {
    const { personId, markers } = probing;
    // Someone else's own store too: code never reads one.
    const [fixture, others] = await Promise.all([
      recallFixture(probing),
      othersOwnMemory(markers),
    ]);
    const read = async (
      name: string,
      request: Record<string, unknown>,
      about?: Answer["about"],
      as = personId
    ) =>
      await answer(
        name,
        async () => await coreBrain.companyCardAs(env, as, request),
        about
      );
    return [
      await read(
        "an entity no one added",
        { entity: crypto.randomUUID() },
        "nothing"
      ),
      await read(
        "one only hidden memories name",
        { entity: fixture.hidden },
        "hidden"
      ),
      await read(
        "one drawn from a hidden source",
        { entity: fixture.drawn },
        "hidden"
      ),
      await read(
        "one the reader's team alone reads",
        { entity: fixture.seen },
        "hidden"
      ),
      await read(
        "one in someone else's own store",
        { entity: others.entity },
        "hidden"
      ),
      await read("as of the markers", {
        entity: fixture.seen,
        asOf: markers.join(""),
      }),
      await read("after a cursor of the markers", {
        entity: fixture.seen,
        after: btoa(JSON.stringify({ at: markers.join("") })),
      }),
      await read(
        "as someone who isn't a member",
        { entity: fixture.seen },
        undefined,
        stranger()
      ),
    ];
  },
  companyEntitiesAs: async (probing) => {
    const { personId, markers } = probing;
    const fixture = await recallFixture(probing);
    const text = markedText(markers);
    const find = async (
      name: string,
      request: Record<string, unknown>,
      about?: Answer["about"],
      like?: string
    ) =>
      await answer(
        name,
        async () => await coreBrain.companyEntitiesAs(env, personId, request),
        about,
        like
      );
    return [
      await find(
        "a name only hidden memories give",
        { name: text },
        "hidden",
        "name"
      ),
      await find(
        "a name no one gave",
        { name: markers.map(twinOf).join(" ") },
        "nothing",
        "name"
      ),
      await find(
        "an identifier only hidden memories give",
        { identifier: { type: "ref", value: fixture.hiddenRef } },
        "hidden",
        "identifier"
      ),
      await find(
        "an identifier no one gave",
        { identifier: { type: "ref", value: `ref:${crypto.randomUUID()}` } },
        "nothing",
        "identifier"
      ),
      await find("a kind", { kind: "customer" }),
      await find("nothing to find by", { after: markers.join("") }),
    ];
  },
  // Pure: what a request is, never what it holds.
  isCodeMemoryRequest: async ({ markers }) => {
    const is = async (name: string, operation: string, input: unknown) =>
      await answer(name, async () => {
        await Promise.resolve();
        return coreBrain.isCodeMemoryRequest(unchecked(operation), input);
      });
    const hidden = markers.join(" ");
    return [
      await is("a memory", "remember", {
        about: { kind: "customer", names: ["Plain"] },
        statement: "A plain fact",
      }),
      await is("one naming its readers", "remember", {
        about: { kind: "customer", names: [hidden] },
        statement: hidden,
        readers: hidden,
      }),
      await is("an operation of the markers", hidden, { memory: hidden }),
    ];
  },
} satisfies Record<CoreCodeMember, Probe>;

/** The person themselves, as brain-memories.ts takes a caller. */
const personCaller = (personId: string): brainMemories.MemoryCaller => ({
  person: personId,
  actor: { type: "person", userId: personId },
});

/** One probe per export of core's brain-memories.ts, as the person. */
export const memoriesProbes = (() => {
  const probes = personMemoryProbes({
    remember: async (personId, remembered) =>
      await brainMemories.rememberFor(env, personCaller(personId), remembered),
    forget: async (personId, memory) =>
      await brainMemories.forgetFor(env, personCaller(personId), memory),
  });
  // The callers' confirmation and correction, audited: what core's
  // functions answer, as the page's probes ask them.
  const page = memoryPageProbes({
    ...corePageCalls,
    confirm: async (personId, memory) =>
      await brainMemories.confirmFor(env, personCaller(personId), memory),
    correct: async (personId, correction) =>
      await brainMemories.correctFor(env, personCaller(personId), correction),
  });
  return {
    rememberFor: probes.remember,
    forgetFor: probes.forget,
    confirmFor: page.confirm,
    correctFor: page.correct,
  };
})() satisfies Record<keyof typeof brainMemories, Probe>;

/** The probes of cards. */
const linkingProbes = {
  readCard: async (probing) => {
    const { reader } = probing;
    const fixture = await recallFixture(probing);
    const read = async (
      name: string,
      entity: string,
      about?: Answer["about"],
      asOf?: Date
    ) =>
      await answer(
        name,
        async () =>
          await store().readCard({
            entity,
            reader,
            ...(asOf === undefined ? {} : { asOf }),
          }),
        about
      );
    // An add of the reader's names an entity as one of theirs and a hidden
    // one are named: it links to theirs, never the hidden one, so its card
    // holds no marker.
    const linkedBeside = async (): Promise<Answer[]> => {
      const [group] = reader.groups;
      if (group === undefined) {
        return [];
      }
      const name = `Twin ${crypto.randomUUID().slice(0, 8)}`;
      const named = (
        access: Access,
        statement: string,
        extra: { attribute?: string; value?: string } = {}
      ) => ({
        change: crypto.randomUUID(),
        access,
        entities: [{ key: "c", kind: "customer" as const, names: [name] }],
        memories: [
          {
            about: "c",
            type: "fact" as const,
            statement,
            speaker: { kind: "system" as const },
            basis: { kind: "writer" as const, writer: stranger() },
            ...extra,
          },
        ],
      });
      const text = markedText(probing.markers);
      await store().addMemories(
        named({ kind: "audience", group }, `${name} is a customer`)
      );
      await store().addMemories(
        named({ kind: "audience", group: stranger() }, text, {
          attribute: "status",
          value: text,
        })
      );
      const linked = await store().addMemories(
        named({ kind: "audience", group }, `${name} renews in March`)
      );
      return [
        await read(
          "the reader's own, linked by a name a hidden entity holds too",
          linked.entities.c ?? ""
        ),
      ];
    };
    return [
      ...(await linkedBeside()),
      await read("an entity no one added", crypto.randomUUID(), "nothing"),
      await read(
        "an entity only hidden memories name",
        fixture.hidden,
        "hidden"
      ),
      await read(
        "an entity drawn from a hidden source",
        fixture.drawn,
        "hidden"
      ),
      await read(
        "the reader's own, which hidden memories end, contest and relate",
        fixture.seen
      ),
      await read(
        "the reader's own, as of now",
        fixture.seen,
        undefined,
        new Date()
      ),
      await read(
        "the reader's own, before anything",
        fixture.seen,
        undefined,
        new Date(0)
      ),
      await answer(
        "the reader's own, a page of one at a time",
        async () =>
          await store().readCard({ entity: fixture.seen, reader, limit: 1 })
      ),
      await answer(
        "the reader's own, after a cursor of markers",
        async () =>
          await store().readCard({
            entity: fixture.seen,
            reader,
            after: unchecked({ memory: probing.markers.join("") }),
          })
      ),
    ];
  },
} satisfies Record<string, Probe>;

/** One probe per public method of the Brain's store. */
export const storeProbes = {
  addSource: async ({ markers }) => {
    const text = markedText(markers);
    const add = async (
      name: string,
      access: Access,
      as = text,
      source = keyOf(missingSource()),
      change = crypto.randomUUID()
    ) =>
      await answer(
        name,
        async () =>
          await store().addSource({ source, change, text: as, access })
      );
    return [
      await add("for someone else", { kind: "owner", person: stranger() }),
      await add("for a group", { kind: "audience", group: stranger() }),
      await add("for nobody", { kind: "none" }),
      await add("an unknown kind", unchecked({ kind: "everyone" })),
      await add("no group", unchecked({ kind: "audience", group: "" })),
      await add(
        "too long a person",
        unchecked({ kind: "owner", person: text.repeat(300) })
      ),
      await add(
        "a field the kind hasn't",
        unchecked({ kind: "none", person: markers.join("") })
      ),
      await add(
        "too much text",
        { kind: "owner", person: stranger() },
        oversizedText(markers)
      ),
      await answer(
        "an unknown field",
        async () =>
          await store().addSource(
            unchecked({
              source: keyOf(missingSource()),
              change: crypto.randomUUID(),
              text,
              access: { kind: "none" },
              extra: text,
            })
          )
      ),
      await add(
        "a source named by the markers, too long",
        { kind: "owner", person: stranger() },
        text,
        text.repeat(300)
      ),
      await add(
        "no change",
        { kind: "owner", person: stranger() },
        text,
        keyOf(missingSource()),
        ""
      ),
    ];
  },
  // A number, never text: a change the reader may not read answers as
  // one no one made.
  changeVersion: async ({ reader, hiddenVersions, markers }) => {
    const look = async (
      name: string,
      source: string,
      change: string,
      as: Reader = reader,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await store().changeVersion({ source, change, reader: as }),
        about
      );
    const asked: Answer[] = [
      await look(
        "a source no one added",
        keyOf(missingSource()),
        "unmade",
        reader,
        "nothing"
      ),
    ];
    for (const [index, { source }] of hiddenVersions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one look at a time
      const answered = await look(
        `hidden source ${index}`,
        keyOf(source),
        "unmade",
        reader,
        "hidden"
      );
      asked.push(answered);
    }
    const hidden = keyOf(hiddenVersions[0]?.source ?? missingSource());
    asked.push(
      await look("a change of the markers", hidden, markers.join("")),
      await look("too many groups", hidden, "unmade", {
        ...reader,
        groups: Array.from({ length: readerGroupsMax + 1 }, () =>
          markers.join("")
        ),
      })
    );
    return asked;
  },
  readVersion: async ({ reader, hiddenVersions, markers }) => {
    const read = async (
      name: string,
      source: string,
      version: number,
      as: Reader = reader,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await store().readVersion({ source, version, reader: as }),
        about
      );
    const asked: Answer[] = [
      await read(
        "a source no one added",
        keyOf(missingSource()),
        1,
        reader,
        "nothing"
      ),
    ];
    for (const [index, { source, version }] of hiddenVersions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time
      const answered = await read(
        `hidden version ${index}`,
        keyOf(source),
        version,
        reader,
        "hidden"
      );
      asked.push(answered);
    }
    const hidden = keyOf(hiddenVersions[0]?.source ?? missingSource());
    asked.push(
      await read("version 0", hidden, 0),
      await read("too many groups", hidden, 1, {
        ...reader,
        groups: Array.from({ length: readerGroupsMax + 1 }, () =>
          markers.join("")
        ),
      }),
      await read(
        "a source named by the markers, too long",
        hidden.repeat(300),
        1
      ),
      await answer(
        "a request with an unknown field",
        async () =>
          await store().readVersion(
            unchecked({
              source: hidden,
              version: 1,
              reader,
              extra: markers.join(" "),
            })
          )
      )
    );
    return asked;
  },
  readableVersions: async ({ reader, hiddenVersions, markers }) => {
    const check = async (
      name: string,
      versions: readonly { source: string; version: number }[],
      as: Reader = reader,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () =>
          await store().readableVersions({
            versions: [...versions],
            reader: as,
          }),
        about
      );
    const hidden = keyOf(hiddenVersions[0]?.source ?? missingSource());
    return [
      await check(
        "sources no one added",
        hiddenVersions.map(({ version }) => ({
          source: keyOf(missingSource()),
          version,
        })),
        reader,
        "nothing"
      ),
      await check(
        "the hidden versions",
        hiddenVersions.map(({ source, version }) => ({
          source: keyOf(source),
          version,
        })),
        reader,
        "hidden"
      ),
      await check("version 0", [{ source: hidden, version: 0 }]),
      await check(
        "too many versions",
        Array.from({ length: readableCheckMax + 1 }, () => ({
          source: hidden,
          version: 1,
        }))
      ),
      await check("a source named by the markers, too long", [
        { source: hidden.repeat(300), version: 1 },
      ]),
      await answer(
        "a request with an unknown field",
        async () =>
          await store().readableVersions(
            unchecked({ versions: [], reader, extra: markers.join(" ") })
          )
      ),
    ];
  },
  // What recall finds of passages alone: no memory, the same questions.
  findPassages: async (probing) => {
    await recallFixture(probing);
    const find = async (asking: PackAsk) =>
      await store().findPassages({ ...asking, reader: probing.reader });
    const whole = { tokens: recallBudgetMax };
    return [
      await answer(
        "the reader's own entity, which hidden relations name",
        async () => await find({ question: "Plain", budget: whole })
      ),
      ...(await askedOfMarkers(probing, momentsOf(probing), find)),
      await answer(
        "the shared word",
        async () => await find({ question: probing.sharedWord, budget: whole })
      ),
    ];
  },
  // What recall finds before it is packed: the same questions, answered
  // as lists with their order keys, must hold no marker either.
  find: async (probing) => {
    const fixture = await recallFixture(probing);
    const find = async (asking: PackAsk) =>
      await store().find({ ...asking, reader: probing.reader });
    const whole = { tokens: recallBudgetMax };
    // A readable entity reached from the reader's "Plain" only through a
    // hidden relation: finding "Plain" must be what it was before the
    // relation was added.
    const reachedThroughHidden = async (): Promise<Answer[]> => {
      const [group] = probing.reader.groups;
      if (group === undefined) {
        return [];
      }
      const like = "a readable entity behind a hidden relation";
      const keeper = `Keeper ${crypto.randomUUID().slice(0, 8)}`;
      const readable = await store().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group },
        entities: [{ key: "q", kind: "person", names: [keeper] }],
        memories: [
          {
            about: "q",
            type: "fact",
            statement: `${keeper} keeps the keys`,
            speaker: { kind: "system" },
            basis: { kind: "writer", writer: stranger() },
          },
        ],
      });
      const before = await answer(
        `${like}, before the relation`,
        async () => await find({ question: "Plain", budget: whole }),
        "nothing"
      );
      const hidden = stranger();
      await store().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: hidden },
        // Made for someone who sees both entities and is in the group.
        reader: {
          person: probing.reader.person,
          groups: [hidden, ...probing.reader.groups],
        },
        entities: [
          { key: "c", id: fixture.seen, kind: "customer", names: [] },
          {
            key: "q",
            id: readable.entities.q ?? "",
            kind: "person",
            names: [],
          },
        ],
        memories: [
          {
            about: "c",
            attribute: "contact",
            object: "q",
            type: "fact",
            statement: markedText(probing.markers),
            speaker: { kind: "system" },
            basis: { kind: "writer", writer: stranger() },
          },
        ],
      });
      const after = await answer(
        `${like}, after it`,
        async () => await find({ question: "Plain", budget: whole }),
        "hidden"
      );
      return [before, after].map((answered) => ({ ...answered, like }));
    };
    // A reader who names no person (a chat's code, an App's: `teams` or
    // `company`), of the same groups: the shared store holds nothing one
    // person alone may read, so every memory and entity read answers them
    // byte for byte as it answers the person, and none throws on null.
    const asNoPerson = async (): Promise<Answer[]> => {
      const noPerson: Reader = { person: null, groups: probing.reader.groups };
      const reads: [string, (reader: Reader) => Promise<unknown>][] = [
        [
          "finding Plain",
          async (reader) =>
            await store().find({ question: "Plain", budget: whole, reader }),
        ],
        [
          "finding the markers",
          async (reader) =>
            await store().find({
              question: probing.markers.join(" "),
              budget: whole,
              reader,
            }),
        ],
        [
          "the card of their own",
          async (reader) =>
            await store().readCard({ entity: fixture.seen, reader }),
        ],
        [
          "the card of a hidden entity",
          async (reader) =>
            await store().readCard({ entity: fixture.hidden, reader }),
        ],
        [
          "the memories of their own",
          async (reader) =>
            await store().readMemories({ entity: fixture.seen, reader }),
        ],
        [
          "their own entity",
          async (reader) =>
            await store().readEntity({ entity: fixture.seen, reader }),
        ],
        [
          "entities named Plain",
          async (reader) =>
            await store().findEntities({ name: "Plain", reader }),
        ],
        [
          "entities by the hidden reference",
          async (reader) =>
            await store().findEntities({
              identifier: { type: "ref", value: fixture.hiddenRef },
              reader,
            }),
        ],
      ];
      const answers: Answer[] = [];
      for (const [name, read] of reads) {
        const like = `as no person: ${name}`;
        // oxlint-disable-next-line no-await-in-loop -- one read at a time
        const asPerson = await answer(
          `${name}, as the person`,
          async () => await read(probing.reader),
          "nothing"
        );
        // oxlint-disable-next-line no-await-in-loop -- one read at a time
        const asNone = await answer(
          `${name}, as no person`,
          async () => await read(noPerson),
          "hidden"
        );
        answers.push({ ...asPerson, like }, { ...asNone, like });
      }
      return answers;
    };
    return [
      ...(await asNoPerson()),
      ...(await reachedThroughHidden()),
      await answer(
        "the reader's own entity, which hidden relations name",
        async () => await find({ question: "Plain", budget: whole })
      ),
      ...(await askedOfMarkers(probing, momentsOf(probing), find)),
      await answer(
        "the shared word",
        async () => await find({ question: probing.sharedWord, budget: whole })
      ),
      await answer(
        "nothing",
        async () => await find({ question: "", budget: whole })
      ),
    ];
  },
  recall: async (probing) => {
    const { reader, markers } = probing;
    await recallFixture(probing);
    const recall = async (asking: PackAsk, as: Reader = reader) =>
      await store().recall({ ...asking, reader: as });
    const hidden = markers.join(" ");
    const whole = { tokens: recallBudgetMax };
    // As a reader holding the groups instruction files are written for:
    // their markers must find what their twins find, as no instruction file
    // is indexed.
    const withInstructionGroups: Reader = {
      ...reader,
      groups: [...reader.groups, ...probing.instructionGroups],
    };
    const like = "with the instruction files' groups";
    const withGroups = await askedOfMarkers(
      probing,
      [],
      async (asking) => await recall(asking, withInstructionGroups)
    );
    // As the host asks when its model gave no vector: counted for staff,
    // and answered as any recall by words and exact parts.
    const without = "without meaning, as the host says why";
    const withoutMeaning = await askedOfMarkers(
      probing,
      [],
      async (asking) =>
        await store().recall({ ...asking, reader, withoutMeaning: "timed_out" })
    );
    return [
      ...(await askedOfMarkers(probing, momentsOf(probing), recall)),
      ...withGroups.map((answered) => ({
        ...answered,
        call: `${like}: ${answered.call}`,
        like: `${like}: ${answered.like ?? ""}`,
      })),
      ...withoutMeaning.map((answered) => ({
        ...answered,
        call: `${without}: ${answered.call}`,
        like: `${without}: ${answered.like ?? ""}`,
      })),
      await answer(
        "a reason without meaning named by the markers",
        async () =>
          await recall(
            unchecked({
              question: hidden,
              budget: whole,
              withoutMeaning: hidden,
            })
          )
      ),
      await answer(
        "a vector and a reason without meaning",
        async () =>
          await store().recall({
            question: hidden,
            reader,
            budget: whole,
            meaning: {
              model: { name: "probe-model", build: "0" },
              vector: [1, 0, 0, 0],
            },
            withoutMeaning: "failed",
          })
      ),
      await answer(
        "the shared word",
        async () =>
          await recall({ question: probing.sharedWord, budget: whole })
      ),
      await answer(
        "the reader's own entity, which hidden relations name",
        async () => await recall({ question: "Plain", budget: whole })
      ),
      await answer(
        "nothing",
        async () => await recall({ question: "", budget: whole })
      ),
      await answer(
        "too long a question",
        async () =>
          await recall({
            question: `${hidden} `
              .repeat(questionMaxLength)
              .slice(0, questionMaxLength + 1),
            budget: whole,
          })
      ),
      await answer(
        "too many groups",
        async () =>
          await recall(
            { question: hidden, budget: whole },
            {
              ...reader,
              groups: Array.from({ length: readerGroupsMax + 1 }, () =>
                markers.join("")
              ),
            }
          )
      ),
      await answer(
        "too long a person",
        async () =>
          await recall(
            { question: hidden, budget: whole },
            { ...reader, person: hidden.repeat(300) }
          )
      ),
      await answer(
        "a reader with an unknown field",
        async () =>
          await recall(
            { question: hidden, budget: whole },
            unchecked({ ...reader, extra: hidden })
          )
      ),
      await answer(
        "a request with an unknown field",
        async () =>
          await store().recall(
            unchecked({
              question: hidden,
              reader,
              budget: whole,
              extra: hidden,
            })
          )
      ),
      await answer(
        "a budget past the most",
        async () =>
          await recall({
            question: hidden,
            budget: { tokens: recallBudgetMax + 1 },
          })
      ),
      await answer(
        "a budget of the markers",
        async () =>
          await recall(
            unchecked({ question: hidden, budget: { tokens: hidden } })
          )
      ),
      await answer(
        "a moment named by the markers",
        async () =>
          await recall(
            unchecked({ question: hidden, budget: whole, asOf: hidden })
          )
      ),
      ...(await meaningProbes(probing)),
    ];
  },
  // A put has no reader: what it may never do is widen who reads a chunk.
  // Codes put for every hidden version's chunk, at the question itself,
  // must leave the reader's search exactly as a put for a chunk no one
  // added does.
  putVectors: async ({ reader, markers, hiddenVersions }) => {
    const { question, ownCoded, search } = await vectorScene(reader);
    const words = markedText(markers);
    const put = async (name: string, model: unknown, vectors: unknown) =>
      await answer(name, async () => await putAnswering({ model, vectors }));
    /**
     * A put of `chunks` at the question, to a model of its own holding the
     * reader's own codes: what the put answered, and what the reader then
     * finds. Two calls shaped alike, so any difference is the chunks'.
     */
    const putThenSearch = async (
      name: string,
      chunks: ChunkRef[],
      about: Answer["about"]
    ) => {
      const model = probeModel();
      await putAll(model, ownCoded);
      return await answer(
        name,
        async () => ({
          put: await putAnswering({
            model,
            vectors: placedAt(chunks, question),
          }),
          found: await search(model),
        }),
        about
      );
    };
    const hidden = probeModel();
    await putAll(hidden, ownCoded);
    const missingChunk = {
      source: keyOf(missingSource()),
      version: 1,
      position: 0,
    };
    const chunk = firstChunksOf(hiddenVersions)[0] ?? missingChunk;
    const one = [{ chunk, vector: question }];
    return [
      await putThenSearch("a chunk no one added", [missingChunk], "nothing"),
      await putThenSearch(
        "every hidden version's first chunk",
        firstChunksOf(hiddenVersions),
        "hidden"
      ),
      await put(
        "a model named by the markers, too long",
        { ...hidden, name: words.repeat(modelNameMaxLength) },
        one
      ),
      await put(
        "a model named by the markers, with half a surrogate pair",
        { ...hidden, name: `${words}\uD800` },
        one
      ),
      await put("a centre of the markers", { ...hidden, centre: markers }, one),
      await put(
        "a centre holding no number",
        { ...hidden, centre: hidden.centre.map(() => Number.NaN) },
        one
      ),
      await put(
        "a known model with another centre",
        { ...hidden, centre: hidden.centre.map((value) => value + 1) },
        one
      ),
      await put("a vector of the markers", hidden, [
        { chunk, vector: markers },
      ]),
      await put("a vector shorter than the centre", hidden, [
        { chunk, vector: question.slice(1) },
      ]),
      await put("a vector of zeros", hidden, [
        { chunk, vector: question.map(() => 0) },
      ]),
      await put("a chunk of a source named by the markers, too long", hidden, [
        { chunk: { ...chunk, source: words.repeat(300) }, vector: question },
      ]),
      await put(
        "too many vectors",
        hidden,
        Array.from({ length: vectorsPerPutMax + 1 }, () => one[0])
      ),
      await answer("a request with an unknown field", async () => {
        await store().putVectors(
          unchecked({ model: hidden, vectors: one, extra: words })
        );
      }),
    ];
  },
  // Hidden codes at the question itself, in a tail only (the marked
  // versions' chunks, and more of someone else's than the store
  // re-scores, so they would crowd out the reader's own if the scan read
  // them) and in a packed block only (exactly a block's worth of someone
  // else's): the reader's search must find exactly what it finds with
  // nothing hidden stored.
  searchVectors: async ({ reader, markers, hiddenVersions }) => {
    const { question, modelWith, search } = await vectorScene(reader);
    const words = markedText(markers);
    const nothing = await modelWith();
    const tailFiller = await chunkedSource(
      { kind: "owner", person: stranger() },
      rescoredMost + 44,
      words
    );
    const inTail = await modelWith(
      placedAt(firstChunksOf(hiddenVersions), question),
      placedAt(tailFiller, question)
    );
    const blockFiller = await chunkedSource(
      { kind: "owner", person: stranger() },
      vectorBlockSize,
      words
    );
    const inBlock = await modelWith(placedAt(blockFiller, question));
    const refused = async (name: string, request: unknown) =>
      await answer(
        name,
        async () => await store().searchVectors(unchecked(request))
      );
    const request = {
      model: nothing.name,
      vector: question,
      reader,
      limit: vectorSearchLimitMax,
    };
    return [
      await answer(
        "with nothing hidden stored",
        async () => await search(nothing),
        "nothing"
      ),
      await answer(
        "with hidden codes in a tail only",
        async () => await search(inTail),
        "hidden"
      ),
      await answer(
        "with hidden codes in a packed block only",
        async () => await search(inBlock),
        "hidden"
      ),
      await answer(
        "a model with no codes",
        async () => await search(probeModel())
      ),
      await refused("a model named by the markers, too long", {
        ...request,
        model: words.repeat(modelNameMaxLength),
      }),
      await refused(
        "a model named by the markers, with half a surrogate pair",
        {
          ...request,
          model: `${words}\uD800`,
        }
      ),
      await refused("a vector of the markers", {
        ...request,
        vector: markers,
      }),
      await refused("a vector of other dimensions", {
        ...request,
        vector: question.slice(1),
      }),
      await refused("a vector of zeros", {
        ...request,
        vector: question.map(() => 0),
      }),
      await refused("no result", { ...request, limit: 0 }),
      await refused("too many results", {
        ...request,
        limit: vectorSearchLimitMax + 1,
      }),
      await refused("too many groups", {
        ...request,
        reader: {
          ...reader,
          groups: Array.from({ length: readerGroupsMax + 1 }, () => words),
        },
      }),
      await refused("a request with an unknown field", {
        ...request,
        extra: words,
      }),
      await answer("the filler erased", async () => {
        await eraseFiller(tailFiller, blockFiller);
      }),
      ...(await queuedVectors({ reader, markers, hiddenVersions })),
    ];
  },
  // A step with no reader, for the work queue and erasure: one that has
  // removed codes to drop (a marked source's, replaced by a new version)
  // and ones with nothing left, none answering, logging or prompting a
  // marker.
  repackVectors: async ({ markers }) => {
    const words = markedText(markers);
    const access: Access = { kind: "owner", person: stranger() };
    // One block, of two sources: the first replaced leaves half of it
    // removed.
    const replaced = await chunkedSource(access, 600, words);
    const kept = await chunkedSource(access, vectorBlockSize - 600, words);
    await putAll(
      probeModel(),
      placedAt([...replaced, ...kept], randomVector())
    );
    await store().addSource({
      source: replaced[0]?.source ?? keyOf(missingSource()),
      change: crypto.randomUUID(),
      text: words,
      access,
    });
    const asked: Answer[] = [];
    for (let repack = 1; repack <= 3; repack += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one repack at a time
      const answered = await answer(
        `repack ${repack}`,
        async () => await store().repackVectors()
      );
      asked.push(answered);
    }
    await eraseFiller(replaced, kept);
    return asked;
  },
  addInstructions: async (probing) => {
    const { markers } = probing;
    const text = markedText(markers);
    const add = async (
      name: string,
      access: Access,
      as = text,
      source = instructionKeyOf(unwrittenFile())
    ) =>
      await answer(
        name,
        async () =>
          await store().addInstructions({
            source,
            change: crypto.randomUUID(),
            text: as,
            access,
          })
      );
    // A person's own file, kept in their own store alone: the shared store
    // refuses it alike whether that person wrote one or not.
    const ownFiles: Answer[] = [];
    for (const id of hiddenIdsOf(probing, "person")) {
      const like = `a person's own file in the shared store, ${id}`;
      const written = async (about: "hidden" | "nothing", personId: string) =>
        await answer(
          `${like}, ${about}`,
          async () =>
            await refusedWith(
              async () =>
                await store().addInstructions({
                  source: instructionKeyOf({ scope: "person", personId }),
                  change: crypto.randomUUID(),
                  text: "Not the markers",
                  access: { kind: "owner", person: personId },
                })
            ),
          about,
          like
        );
      ownFiles.push(
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await written("nothing", stranger()),
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await written("hidden", id)
      );
    }
    return [
      ...ownFiles,
      await add("for someone else", { kind: "owner", person: stranger() }),
      await add("for a group", { kind: "audience", group: stranger() }),
      await add(
        "too much text",
        { kind: "owner", person: stranger() },
        text.padEnd(instructionsMaxLength + 1, " x")
      ),
      await add("no text", { kind: "owner", person: stranger() }, " "),
      await add(
        "half a surrogate pair",
        { kind: "owner", person: stranger() },
        `${text}\uD800`
      ),
      await add("an unknown kind", unchecked({ kind: "everyone" })),
      await add(
        "a source named by the markers, too long",
        { kind: "owner", person: stranger() },
        text,
        text.repeat(300)
      ),
      await answer(
        "an unknown field",
        async () =>
          await store().addInstructions(
            unchecked({
              source: instructionKeyOf(unwrittenFile()),
              change: crypto.randomUUID(),
              text,
              access: { kind: "none" },
              extra: text,
            })
          )
      ),
    ];
  },
  // Whether the store holds a key, for core alone, whoever reads it: yes
  // or no, and nothing of the key or what it holds.
  keyState: async ({ markers, hiddenVersions }) => {
    const holds = async (name: string, source: unknown) =>
      await answer(name, async () => await store().keyState(unchecked(source)));
    return [
      await holds("a source no one added", keyOf(missingSource())),
      await holds(
        "a hidden source",
        keyOf(hiddenVersions[0]?.source ?? missingSource())
      ),
      await holds("a key named by the markers", `upload:${markers.join(" ")}`),
      await holds(
        "a key of the markers and control characters",
        `${markers.join("\n")}\u0000`
      ),
      await holds("no key", ""),
    ];
  },
  listSources: async ({ reader, hiddenVersions, markers }) => {
    const list = async (
      name: string,
      prefixes: string[],
      about?: Answer["about"],
      more: Partial<{
        after: { addedAt: Date; source: string };
        limit: number;
      }> = {},
      as: Reader = reader
    ) =>
      await answer(
        name,
        async () =>
          await store().listSources({ reader: as, prefixes, ...more }),
        about
      );
    const hidden = whollyHidden(hiddenVersions).map(keyOf);
    const asked: Answer[] = [
      await list("every upload they may read", ["upload:"]),
      await list("every instruction file they may read", ["instructions:"]),
      await list("a source no one added", [keyOf(missingSource())], "nothing"),
    ];
    for (const [index, source] of hidden.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const answered = await list(`hidden source ${index}`, [source], "hidden");
      asked.push(answered);
    }
    // Every hidden source at once, in one page and one a page, where the
    // pass has any.
    const atOnce = hidden.slice(0, listPrefixesMax);
    if (atOnce.length > 0) {
      asked.push(
        await list("every hidden source at once", atOnce, "hidden"),
        await list("every hidden source, one a page", atOnce, "hidden", {
          limit: 1,
        }),
        // As a reader with no person, as code's recall reads: their
        // groups alone, so nothing of theirs alone either.
        await list(
          "every hidden source at once, as no person",
          atOnce,
          "hidden",
          {},
          { ...reader, person: null }
        )
      );
    }
    asked.push(
      await list(
        "too many prefixes",
        Array.from({ length: listPrefixesMax + 1 }, () => markers.join(""))
      ),
      await list("too long a page", ["upload:"], undefined, {
        limit: listPageMax + 1,
      }),
      await list("no prefix", []),
      await list(
        "after a moment named by the markers",
        ["upload:"],
        undefined,
        {
          after: unchecked({ addedAt: markers.join(" "), source: "upload:x" }),
        }
      ),
      await answer(
        "too many groups",
        async () =>
          await store().listSources({
            reader: {
              ...reader,
              groups: Array.from({ length: readerGroupsMax + 1 }, () =>
                markers.join("")
              ),
            },
            prefixes: ["upload:"],
          })
      ),
      await answer(
        "a request with an unknown field",
        async () =>
          await store().listSources(
            unchecked({
              reader,
              prefixes: ["upload:"],
              extra: markers.join(" "),
            })
          )
      )
    );
    return asked;
  },
  listVersions: async ({ reader, hiddenVersions, markers }) => {
    const list = async (
      name: string,
      source: string,
      before?: number,
      about?: Answer["about"],
      as: Reader = reader
    ) =>
      await answer(
        name,
        async () =>
          await store().listVersions({
            source,
            reader: as,
            ...(before === undefined ? {} : { before }),
          }),
        about
      );
    const asked: Answer[] = [
      await list(
        "a source no one added",
        keyOf(missingSource()),
        undefined,
        "nothing"
      ),
    ];
    for (const [index, source] of whollyHidden(hiddenVersions).entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const answered = await list(
        `hidden source ${index}`,
        keyOf(source),
        undefined,
        "hidden"
      );
      // As a reader with no person, as code's recall reads.
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const asNoPerson = await list(
        `hidden source ${index}, as no person`,
        keyOf(source),
        undefined,
        "hidden",
        { ...reader, person: null }
      );
      asked.push(answered, asNoPerson);
    }
    for (const [index, { source, version }] of hiddenVersions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const answered = await list(
        `up to hidden version ${index}`,
        keyOf(source),
        version + 1,
        "hidden"
      );
      asked.push(answered);
    }
    const hidden = keyOf(hiddenVersions[0]?.source ?? missingSource());
    asked.push(
      await list("below version 0", hidden, 0),
      await list("a source named by the markers, too long", hidden.repeat(300)),
      await answer(
        "a request with an unknown field",
        async () =>
          await store().listVersions(
            unchecked({ source: hidden, reader, extra: markers.join(" ") })
          )
      )
    );
    return asked;
  },
  readCurrent: async ({ reader, markers, hiddenInstructionFiles }) => {
    const read = async (
      name: string,
      sources: string[],
      as: Reader = reader,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await store().readCurrent({ sources, reader: as }),
        about
      );
    const hidden = hiddenInstructionFiles.map(instructionKeyOf);
    const asked: Answer[] = [
      await read(
        "a file never written",
        [instructionKeyOf(unwrittenFile())],
        reader,
        "nothing"
      ),
    ];
    for (const [index, source] of hidden.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time
      const answered = await read(
        `hidden file ${index}`,
        [source],
        reader,
        "hidden"
      );
      asked.push(answered);
    }
    asked.push(
      await read("every hidden file at once", hidden, reader, "hidden"),
      await read("too many sources", [
        ...hidden,
        ...Array.from({ length: currentReadMax + 1 }, () =>
          instructionKeyOf(unwrittenFile())
        ),
      ]),
      await read("too many groups", hidden, {
        ...reader,
        groups: Array.from({ length: readerGroupsMax + 1 }, () =>
          markers.join("")
        ),
      }),
      await read("a source named by the markers, too long", [
        markers.join("").repeat(300),
      ]),
      await answer(
        "a request with an unknown field",
        async () =>
          await store().readCurrent(
            unchecked({ sources: hidden, reader, extra: markers.join(" ") })
          )
      )
    );
    return asked;
  },
  work: async ({ markers }) => [
    ...(await workMarked(
      markers,
      async (at) => {
        await store().work({
          ask: quietModel,
          at,
          embedders: noEmbedders,
          handOvers: noHandOvers,
          contextTokens: null,
        });
      },
      "a marked item worked by the store"
    )),
    ...(await Promise.all(
      sweepTimes().map(
        async (at) =>
          await answer(`a tick as of ${at.toISOString()}`, async () => {
            await store().work({
              ask: quietModel,
              at,
              embedders: noEmbedders,
              handOvers: noHandOvers,
              contextTokens: null,
            });
          })
      )
    )),
    // One tick with embedders that fail with the passages and the markers
    // in their error: what embedding's items do with a failure.
    await answer("a tick whose embedders fail", async () => {
      await store().work({
        ask: quietModel,
        at: nextDay(),
        embedders: leakyEmbedders(markers),
        handOvers: noHandOvers,
        contextTokens: null,
      });
    }),
    await answer("a tick at no time", async () => {
      await store().work({
        ask: quietModel,
        at: unchecked(markers.join(" ")),
        embedders: leakyEmbedders(markers),
        handOvers: noHandOvers,
        contextTokens: null,
      });
    }),
  ],
  // As core's (above), through the contract itself.
  eraseSource: async ({ markers }) => {
    const erase = async (
      name: string,
      request: unknown,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => {
          await store().eraseSource(unchecked(request));
        },
        about
      );
    const marked = keyOf(missingSource());
    await store().addSource({
      source: marked,
      change: crypto.randomUUID(),
      text: markedText(markers),
      access: { kind: "owner", person: stranger() },
    });
    return [
      await erase(
        "a source no one added",
        { source: keyOf(missingSource()), reason: "deleted" },
        "nothing"
      ),
      await erase(
        "someone else's marked source",
        { source: marked, reason: "deleted" },
        "hidden"
      ),
      await erase(
        "the same erasure again",
        { source: marked, reason: "deleted" },
        "hidden"
      ),
      await erase("a source named by the markers, too long", {
        source: markers.join("").repeat(300),
        reason: "deleted",
      }),
      await erase("a reason named by the markers", {
        source: keyOf(missingSource()),
        reason: markers.join(" "),
      }),
      await erase("an unknown field", {
        source: keyOf(missingSource()),
        reason: "deleted",
        extra: markers.join(" "),
      }),
    ];
  },
  // Putting sources on the queue has no reader either: it answers alike
  // whatever was added, and a tick asks the host for each.
  handOver: async ({ markers }) => {
    const over = async (
      name: string,
      request: unknown,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => {
          await store().handOver(unchecked(request));
        },
        about
      );
    const marked = keyOf(missingSource());
    await store().addSource({
      source: marked,
      change: crypto.randomUUID(),
      text: markedText(markers),
      access: { kind: "owner", person: stranger() },
    });
    return [
      await over(
        "a source no one added",
        {
          items: [{ source: keyOf(missingSource()), priority: "conversation" }],
        },
        "nothing"
      ),
      await over(
        "someone else's marked source",
        { items: [{ source: marked, priority: "conversation" }] },
        "hidden"
      ),
      await over("a source named by the markers, too long", {
        items: [
          { source: markers.join("").repeat(300), priority: "conversation" },
        ],
      }),
      await over("a class named by the markers", {
        items: [
          { source: keyOf(missingSource()), priority: markers.join(" ") },
        ],
      }),
      await over("more sources than one call takes", {
        items: Array.from({ length: handOversMax + 1 }, () => ({
          source: keyOf(missingSource()),
          priority: "conversation",
        })),
      }),
      await answer("a tick whose host fails with the markers", async () => {
        await store().work({
          ask: quietModel,
          at: nextDay(),
          embedders: noEmbedders,
          handOvers: {
            handOver: async () => {
              await Promise.resolve();
              throw new Error(`Could not hand over ${markers.join(" ")}`);
            },
          },
          contextTokens: null,
        });
      }),
    ];
  },
  erasePerson: async ({ markers }) => {
    const erase = async (
      name: string,
      request: unknown,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => {
          await store().erasePerson(unchecked(request));
        },
        about
      );
    const holder = stranger();
    await store().addSource({
      source: keyOf(missingSource()),
      change: crypto.randomUUID(),
      text: markedText(markers),
      access: { kind: "owner", person: holder },
    });
    return [
      await erase(
        "someone with nothing",
        { person: stranger(), reason: "withdrawn" },
        "nothing"
      ),
      await erase(
        "someone with marked sources",
        { person: holder, reason: "withdrawn" },
        "hidden"
      ),
      await erase(
        "the same erasure again",
        { person: holder, reason: "withdrawn" },
        "hidden"
      ),
      await erase("a person named by the markers, too long", {
        person: markers.join("").repeat(300),
        reason: "withdrawn",
      }),
      await erase("a reason named by the markers", {
        person: stranger(),
        reason: markers.join(" "),
      }),
      await erase("an unknown field", {
        person: stranger(),
        reason: "withdrawn",
        extra: markers.join(" "),
      }),
    ];
  },
  reembed: async ({ markers }) => [
    await answer("a re-embed", async () => await store().reembed()),
    // What a re-embed puts back, worked by embedders that fail with the
    // passages and the markers in their error.
    await answer("a tick after a re-embed", async () => {
      await store().work({
        ask: quietModel,
        at: nextDay(),
        embedders: leakyEmbedders(markers),
        handOvers: noHandOvers,
        contextTokens: null,
      });
    }),
    ...(await workMarked(
      markers,
      async (at) => {
        await store().reembed();
        await store().work({
          ask: quietModel,
          at,
          embedders: noEmbedders,
          handOvers: noHandOvers,
          contextTokens: null,
        });
      },
      "a marked item worked after a re-embed"
    )),
  ],
  workOverview: async ({ markers }) => [
    ...(await workMarked(
      markers,
      async (at) => {
        await store().work({
          ask: quietModel,
          at,
          embedders: noEmbedders,
          handOvers: noHandOvers,
          contextTokens: null,
        });
      },
      "a marked item worked to parking"
    )),
    await answer(
      "the store's overview, the marked item parked",
      async () => await store().workOverview()
    ),
    // Recall's counts, after a recall of the markers that went without
    // meaning: numbers alone.
    await answer(
      "the store's overview after the markers were asked",
      async () => {
        await store().recall({
          question: markers.join(" "),
          reader: { person: stranger(), groups: [] },
          budget: { tokens: recallBudgetMax },
          withoutMeaning: "refused",
        });
        return await store().workOverview();
      }
    ),
  ],
  requeueWork: async ({ markers }) =>
    await requeueMarked(markers, async (id) => await store().requeueWork(id)),
  rebuildWords: async () => [
    await answer(
      "a rebuild of the word indexes",
      async () => await store().rebuildWords()
    ),
    await answer(
      "a rebuild while one is under way",
      async () => await store().rebuildWords()
    ),
  ],
  erasureStatus: async ({ markers }) => {
    const look = async (
      name: string,
      request: unknown,
      about?: Answer["about"],
      like?: string
    ) =>
      await answer(
        name,
        async () => await store().erasureStatus(unchecked(request)),
        about,
        like
      );
    const holder = stranger();
    const kept = keyOf(missingSource());
    const erased = keyOf(missingSource());
    for (const source of [kept, erased]) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await store().addSource({
        source,
        change: crypto.randomUUID(),
        text: markedText(markers),
        access: { kind: "owner", person: holder },
      });
    }
    await store().eraseSource({ source: erased, reason: "deleted" });
    // A person's own store refuses it, whatever it holds and whoever it
    // names: each answer is scanned for the markers, as every probe's is.
    // (Two stores' refusals differ only in the store's id, which its name,
    // given by the caller, already decides.)
    const owner = stranger();
    const ownErased = keyOf(missingSource());
    for (const source of [keyOf(missingSource()), ownErased]) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await personalStore(owner).addSource({
        source,
        change: crypto.randomUUID(),
        text: markedText(markers),
        access: { kind: "owner", person: owner },
      });
    }
    await personalStore(owner).eraseSource({
      source: ownErased,
      reason: "deleted",
    });
    const askOwn = async (name: string, request: unknown) =>
      await answer(
        name,
        async () => await personalStore(owner).erasureStatus(unchecked(request))
      );
    return [
      await askOwn(
        "a person's own store holding marked sources, of its person",
        {
          kind: "person",
          person: owner,
        }
      ),
      await askOwn("a person's own store, of its erased marked source", {
        kind: "source",
        source: ownErased,
      }),
      await askOwn("a person's own store, of a key of the markers", {
        kind: "source",
        source: `upload:${markers.join(" ")}`,
      }),
      await look(
        "a source no one added",
        { kind: "source", source: keyOf(missingSource()) },
        "nothing"
      ),
      await look(
        "someone else's marked source, never erased",
        { kind: "source", source: kept },
        "hidden"
      ),
      await look(
        "someone with nothing",
        { kind: "person", person: stranger() },
        "nothing",
        "person"
      ),
      await look(
        "someone with marked sources, never erased",
        { kind: "person", person: holder },
        "hidden",
        "person"
      ),
      await look("an erased marked source", {
        kind: "source",
        source: erased,
      }),
      await look("a key of the markers", {
        kind: "source",
        source: `upload:${markers.join(" ")}`,
      }),
      await look("an unknown field", {
        kind: "person",
        person: stranger(),
        extra: markers.join(" "),
      }),
    ];
  },
  // As core's (above), through the contract itself.
  startExport: async ({ reader, markers }) => [
    await answer("the company's export, started", async () => {
      const { id } = await store().startExport("test");
      return typeof id;
    }),
    await answer("a deployment named by the markers, too long", async () => {
      await store().startExport(markers.join("").repeat(300));
    }),
    await answer("a person's own store", async () => {
      await personalStore(reader.person).startExport("test");
    }),
  ],
  exportStatus: async (probing) => {
    const id = await companyExport(probing);
    return [
      await answer("the company's export, done", async () => {
        const status = await store().exportStatus({ id });
        return status?.state;
      }),
      await answer(
        "an export no one started",
        async () => await store().exportStatus({ id: crypto.randomUUID() })
      ),
      await answer(
        "a person's own store",
        async () =>
          await personalStore(probing.reader.person).exportStatus({ id })
      ),
      await answer(
        "a request named by the markers",
        async () =>
          await store().exportStatus(
            unchecked({ id, extra: probing.markers.join(" ") })
          )
      ),
    ];
  },
  exportFile: async (probing) => {
    const id = await companyExport(probing);
    return [
      await answer(
        "a file of an export no one started",
        async () =>
          await store().exportFile({
            id: crypto.randomUUID(),
            file: "part-0000.jsonl",
          })
      ),
      await answer(
        "a person's own store",
        async () =>
          await personalStore(probing.reader.person).exportFile({
            id,
            file: "manifest.json",
          })
      ),
      await answer(
        "a file named by the markers",
        async () =>
          await store().exportFile(
            unchecked({ id, file: probing.markers.join(" ") })
          )
      ),
    ];
  },
  // A person's own export, through the contract: only their own store,
  // only for them.
  startOwnExport: async ({ reader, markers }) => [
    await answer("the reader's own export, started", async () => {
      const { id } = await personalStore(reader.person).startOwnExport({
        person: reader.person,
        deployment: "test",
      });
      return typeof id;
    }),
    await answer("someone who never kept anything", async () => {
      const person = stranger();
      const { id } = await personalStore(person).startOwnExport({
        person,
        deployment: "test",
      });
      return typeof id;
    }),
    await answer("the shared store", async () => {
      await store().startOwnExport({
        person: reader.person,
        deployment: "test",
      });
    }),
    await answer("someone else's own store, as the reader", async () => {
      await personalStore(stranger()).startOwnExport({
        person: reader.person,
        deployment: "test",
      });
    }),
    await answer("a deployment named by the markers, too long", async () => {
      await personalStore(reader.person).startOwnExport({
        person: reader.person,
        deployment: markers.join("").repeat(300),
      });
    }),
  ],
  ownExport: async (probing) => {
    await strangersExport(probing);
    const { person } = probing.reader;
    return [
      await answer("the reader's own export", async () => {
        const status = await personalStore(person).ownExport({ person });
        return status?.state ?? null;
      }),
      await answer(
        "the shared store",
        async () => await store().ownExport({ person })
      ),
      await answer(
        "someone else's own store, as the reader",
        async () => await personalStore(stranger()).ownExport({ person })
      ),
    ];
  },
  ownExportFile: async (probing) => {
    const others = await strangersExport(probing);
    const { person } = probing.reader;
    return [
      await answer(
        "a file of someone else's marked export",
        async () =>
          await personalStore(person).ownExportFile({
            person,
            id: others,
            file: "manifest.json",
          }),
        "hidden"
      ),
      await answer(
        "a file of an export no one started",
        async () =>
          await personalStore(person).ownExportFile({
            person,
            id: crypto.randomUUID(),
            file: "manifest.json",
          }),
        "nothing"
      ),
      await answer(
        "the shared store",
        async () =>
          await store().ownExportFile({
            person,
            id: others,
            file: "manifest.json",
          })
      ),
      await answer(
        "a file named by the markers",
        async () =>
          await personalStore(person).ownExportFile(
            unchecked({ person, id: others, file: probing.markers.join(" ") })
          )
      ),
    ];
  },
  startRestore: async (probing) => {
    const others = await companyExport(probing);
    return [
      await answer(
        "someone else's marked export",
        async () =>
          await refusedWith(
            async () => await store().startRestore(others, "test")
          ),
        "hidden"
      ),
      await answer(
        "an export no one started",
        async () =>
          await refusedWith(
            async () => await store().startRestore(crypto.randomUUID(), "test")
          ),
        "nothing"
      ),
      await answer(
        "a person's own store",
        async () =>
          await personalStore(probing.reader.person).startRestore(
            others,
            "test"
          )
      ),
      await answer(
        "an export named by the markers",
        async () =>
          await store().startRestore(probing.markers.join(" "), "test")
      ),
    ];
  },
  checkRestore: async (probing) => {
    const others = await companyExport(probing);
    return [
      await answer(
        "someone else's marked export",
        async () =>
          await refusedWith(async () => {
            await store().checkRestore(others, "test");
          }),
        "hidden"
      ),
      await answer(
        "an export no one started",
        async () =>
          await refusedWith(async () => {
            await store().checkRestore(crypto.randomUUID(), "test");
          }),
        "nothing"
      ),
      await answer("a person's own store", async () => {
        await personalStore(probing.reader.person).checkRestore(others, "test");
      }),
      await answer("an export named by the markers", async () => {
        await store().checkRestore(probing.markers.join(" "), "test");
      }),
    ];
  },
  restoreStatus: async (probing) => {
    const others = await companyExport(probing);
    return [
      await answer(
        "someone else's marked export",
        async () => await store().restoreStatus(others),
        "hidden"
      ),
      await answer(
        "an export no one started",
        async () => await store().restoreStatus(crypto.randomUUID()),
        "nothing"
      ),
      await answer(
        "an export named by the markers",
        async () => await store().restoreStatus(probing.markers.join(" "))
      ),
    ];
  },
  ...memoryProbes,
  ...linkingProbes,
} satisfies Record<StoreMember, Probe>;

/** A `SKILL.md` named `name`, holding no marker. */
const plainSkillText = (name: string): string =>
  `---\nname: ${name}\ndescription: A probe.\n---\nSteps.`;

/** `personId` signed in as one of the organization's admins. */
const adminSessionOf = (personId: string): Identity => ({
  ...sessionOf(personId),
  role: "admin",
});

/** A new skill of `personId`'s own, holding no marker: its name. */
const plainOwnSkill = async (personId: string): Promise<string> => {
  const { name } = await skillShares.saveOwnSkill(
    env,
    sessionOf(personId),
    plainSkillText(`probe-${crypto.randomUUID()}`)
  );
  return name;
};

/** A share of a new skill of `personId`'s own, holding no marker: its ID. */
const plainShare = async (personId: string): Promise<string> => {
  const { id } = await skillShares.shareOwnSkill(
    env,
    sessionOf(personId),
    await plainOwnSkill(personId),
    1
  );
  return id;
};

/** Each export of core's skill-shares.ts. */
type ShareMember = keyof typeof skillShares;

/**
 * Writing and sharing skills (skill-shares.ts), as the signed-in reader,
 * who is no admin: someone else's own skills answer as ones no one wrote,
 * shares wait on admins alone, and what is written lands in the reader's
 * own store only. Nothing here writes a marker anywhere the reader reads.
 */
export const shareProbes = {
  skillsOverview: async ({ personId }) => [
    await answer(
      "the reader's skills and shares",
      async () => await skillShares.skillsOverview(env, sessionOf(personId))
    ),
    await answer(
      "as someone who isn't a member",
      async () => await skillShares.skillsOverview(env, sessionOf(stranger()))
    ),
  ],
  readSkill: async ({ personId, markers, hiddenSkills }) => [
    await answer(
      "the reader's own",
      async () =>
        await skillShares.readSkill(
          env,
          sessionOf(personId),
          "own",
          await plainOwnSkill(personId)
        )
    ),
    await answer(
      "a company skill of the markers",
      async () =>
        await skillShares.readSkill(
          env,
          sessionOf(personId),
          "company",
          markers.join("-")
        )
    ),
    await answer(
      "a scope of the markers",
      async () =>
        await skillShares.readSkill(
          env,
          sessionOf(personId),
          markers.join(""),
          "unwritten"
        )
    ),
    ...(await pairedOverSkills(
      hiddenSkills,
      async (name) =>
        await skillShares.readSkill(env, sessionOf(personId), "own", name)
    )),
  ],
  saveOwnSkill: async ({ personId, markers }) => {
    const text = markedText(markers);
    return [
      await answer(
        "a skill of the reader's own",
        async () =>
          await skillShares.saveOwnSkill(
            env,
            sessionOf(personId),
            plainSkillText(`probe-${crypto.randomUUID()}`)
          )
      ),
      await answer(
        "text with no card",
        async () =>
          await skillShares.saveOwnSkill(env, sessionOf(personId), text)
      ),
      await answer(
        "not text",
        async () =>
          await skillShares.saveOwnSkill(env, sessionOf(personId), markers)
      ),
      await answer(
        "as someone who isn't a member",
        async () =>
          await skillShares.saveOwnSkill(
            env,
            sessionOf(stranger()),
            plainSkillText("unwritten")
          )
      ),
    ];
  },
  removeOwnSkill: async ({ personId, markers, hiddenSkills }) => [
    await answer("a skill never written", async () => {
      await skillShares.removeOwnSkill(env, sessionOf(personId), "unwritten");
    }),
    await answer("a name of the markers", async () => {
      await skillShares.removeOwnSkill(
        env,
        sessionOf(personId),
        markers.join(" ")
      );
    }),
    ...(await pairedOverSkills(hiddenSkills, async (name) => {
      await skillShares.removeOwnSkill(env, sessionOf(personId), name);
      return await skillShares.skillsOverview(env, sessionOf(personId));
    })),
  ],
  shareOwnSkill: async ({ personId, markers, hiddenSkills }) => [
    await answer(
      "the reader's own",
      async () =>
        await skillShares.shareOwnSkill(
          env,
          sessionOf(personId),
          await plainOwnSkill(personId),
          1
        )
    ),
    await answer(
      "a name of the markers",
      async () =>
        await skillShares.shareOwnSkill(
          env,
          sessionOf(personId),
          markers.join(" "),
          1
        )
    ),
    ...(await pairedOverSkills(
      hiddenSkills,
      async (name) =>
        await skillShares.shareOwnSkill(env, sessionOf(personId), name, 1)
    )),
  ],
  // Deciding is an admin's: the reader is refused, for a share there is
  // and one there isn't alike; as an admin, the reader's own share holding
  // no marker is approved.
  approveShare: async ({ personId, markers }) => [
    await answer(
      "the reader's page after",
      async () => await skillShares.skillsOverview(env, sessionOf(personId))
    ),
    await answer(
      "the reader's share",
      async () =>
        await skillShares.approveShare(
          env,
          sessionOf(personId),
          await plainShare(personId)
        )
    ),
    await answer(
      "a share of the markers",
      async () =>
        await skillShares.approveShare(
          env,
          adminSessionOf(personId),
          markers.join("")
        )
    ),
    await answer(
      "the reader's share, as an admin",
      async () =>
        await skillShares.approveShare(
          env,
          adminSessionOf(personId),
          await plainShare(personId)
        )
    ),
  ],
  // Only one of the organization's admins decides, checked in the
  // decision's own statement: the readers here aren't, so each decline is
  // refused, and their page after says so.
  declineShare: async ({ personId, markers }) => [
    await answer(
      "the reader's page after",
      async () => await skillShares.skillsOverview(env, sessionOf(personId))
    ),
    await answer(
      "a share of the markers",
      async () =>
        await skillShares.declineShare(
          env,
          adminSessionOf(personId),
          markers.join("")
        )
    ),
    await answer(
      "the reader's share, as an admin",
      async () =>
        await skillShares.declineShare(
          env,
          adminSessionOf(personId),
          await plainShare(personId)
        )
    ),
  ],
  retireSkill: async ({ personId, markers, hiddenSkills }) => [
    await answer(
      "the reader's page after",
      async () => await skillShares.skillsOverview(env, sessionOf(personId))
    ),
    await answer("a company skill holding no marker, as an admin", async () => {
      const approved = await skillShares.approveShare(
        env,
        adminSessionOf(personId),
        await plainShare(personId)
      );
      await skillShares.retireSkill(
        env,
        adminSessionOf(personId),
        approved.name
      );
      return approved;
    }),
    await answer("a name of the markers", async () => {
      await skillShares.retireSkill(
        env,
        adminSessionOf(personId),
        markers.join("-")
      );
    }),
    ...(await pairedOverSkills(hiddenSkills, async (name) => {
      await skillShares.retireSkill(env, adminSessionOf(personId), name);
    })),
  ],
  // It answers statements for a batch, never run here: what it answers
  // is how many, and what it records first is the store's version alone.
  // The reconciler writes only what a recorded decision says: a name with
  // none, the markers' or someone's own skill's, is left as it is, and
  // answers nothing.
  reconcileSkill: async ({ personId, markers, hiddenSkills }) => [
    await answer("a name with no decision", async () => {
      await skillShares.reconcileSkill(env, "undecided");
    }),
    await answer("a name of the markers", async () => {
      await skillShares.reconcileSkill(env, markers.join("-"));
    }),
    ...(await pairedOverSkills(hiddenSkills, async (name) => {
      await skillShares.reconcileSkill(env, name);
      return await coreBrain.listSkillsAs(env, personId, new Set<string>(), {
        personal: true,
      });
    })),
  ],
  reconcileSkills: async ({ personId }) => [
    await answer("every name with a decision on its way", async () => {
      await skillShares.reconcileSkills(env);
      return await coreBrain.listSkillsAs(env, personId, new Set<string>(), {
        personal: true,
      });
    }),
  ],
  waitingShares: async ({ personId }) => [
    await answer(
      "what waits on the reader",
      async () => await skillShares.waitingShares(env, sessionOf(personId))
    ),
  ],
} satisfies Record<ShareMember, Probe>;

/** The Sources page's RPC for `personId`, signed in as a member. */
const sourcesAs = (personId: string): BrainSourcesRpc =>
  new BrainSourcesRpc(
    env,
    async () => await Promise.resolve(sessionOf(personId))
  );

/** A source as the page names it after a list: its time as ISO 8601. */
const pageAfter = (source: SourceRef) => ({
  addedAt: pastAll.toISOString(),
  source,
});

/**
 * The Brain's Sources page (brain-sources-rpc.ts): each method as the
 * signed-in person, over what core's members answer, with what a page
 * sends back (a page's place, a version) and what a client outside
 * TypeScript could send instead.
 */
export const sourcesProbes = {
  list: async ({ personId, hiddenVersions, markers }) => {
    const asked: Answer[] = [
      await answer(
        "every source they may read",
        async () => await sourcesAs(personId).list()
      ),
      await answer(
        "a null page start",
        async () => await sourcesAs(personId).list(unchecked(null))
      ),
      await answer(
        "after a source no one added",
        async () => await sourcesAs(personId).list(pageAfter(missingSource())),
        "nothing"
      ),
    ];
    for (const [index, { source }] of hiddenVersions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const answered = await answer(
        `after hidden source ${index}`,
        async () => await sourcesAs(personId).list(pageAfter(source)),
        "hidden"
      );
      asked.push(answered);
    }
    asked.push(
      await answer(
        "as someone who isn't a member",
        async () => await sourcesAs(stranger()).list()
      ),
      await answer(
        "after a moment named by the markers",
        async () =>
          await sourcesAs(personId).list({
            addedAt: markers.join(" "),
            source: missingSource(),
          })
      ),
      await answer(
        "after an unknown producer named by the markers",
        async () =>
          await sourcesAs(personId).list(
            pageAfter(unchecked({ producer: markers.join(""), id: "x" }))
          )
      )
    );
    return asked;
  },
  versions: async ({ personId, hiddenVersions, markers }) => {
    const asked: Answer[] = [
      await answer(
        "a source no one added",
        async () => await sourcesAs(personId).versions(missingSource()),
        "nothing"
      ),
    ];
    for (const [index, source] of whollyHidden(hiddenVersions).entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one listing at a time
      const answered = await answer(
        `hidden source ${index}`,
        async () => await sourcesAs(personId).versions(source),
        "hidden"
      );
      asked.push(answered);
    }
    const hidden = hiddenVersions[0]?.source ?? missingSource();
    asked.push(
      await answer(
        "as someone who isn't a member",
        async () => await sourcesAs(stranger()).versions(hidden)
      ),
      await answer(
        "an unknown producer named by the markers",
        async () =>
          await sourcesAs(personId).versions(
            unchecked({ producer: markers.join(""), id: hidden.id })
          )
      )
    );
    return asked;
  },
  read: async ({ personId, hiddenVersions, markers }) => {
    const asked: Answer[] = [
      await answer(
        "a source no one added",
        async () => await sourcesAs(personId).read(missingSource(), 1),
        "nothing"
      ),
    ];
    for (const [index, { source, version }] of hiddenVersions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time
      const answered = await answer(
        `hidden version ${index}`,
        async () => await sourcesAs(personId).read(source, version),
        "hidden"
      );
      asked.push(answered);
    }
    const hidden = hiddenVersions[0]?.source ?? missingSource();
    asked.push(
      await answer(
        "as someone who isn't a member",
        async () => await sourcesAs(stranger()).read(hidden, 1)
      ),
      await answer(
        "an unknown producer named by the markers",
        async () =>
          await sourcesAs(personId).read(
            unchecked({ producer: markers.join(""), id: hidden.id }),
            1
          )
      )
    );
    return asked;
  },
  // The page's search is recall with its own budget, never as of a
  // moment: every question of the markers and of their twins, as is.
  search: async (probing) => [
    ...(await askedOfMarkers(
      probing,
      [],
      async ({ question }) => await sourcesAs(probing.personId).search(question)
    )),
    await answer(
      "too long a question",
      async () =>
        await sourcesAs(probing.personId).search(
          `${probing.markers.join(" ")} `
            .repeat(questionMaxLength)
            .slice(0, questionMaxLength + 1)
        )
    ),
    await answer(
      "as someone who isn't a member",
      async () => await sourcesAs(stranger()).search(probing.markers.join(" "))
    ),
  ],
} satisfies Record<"list" | "versions" | "read" | "search", Probe>;

/** The memories' RPC for `personId`, signed in as a member. */
const memoriesAs = (personId: string): BrainMemoriesRpc =>
  new BrainMemoriesRpc(
    env,
    async () => await Promise.resolve(sessionOf(personId))
  );

/** `value` as the page sends it over RPC: every date as ISO 8601, at any depth. */
const onTheWire = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]: [string, unknown]) => [
        key,
        onTheWire(each),
      ])
    );
  }
  return value;
};

/**
 * The chat's undo of a saved memory and the Brain's Memories page
 * (brain-memories-rpc.ts, as `session.brainMemories`), as the signed-in
 * person, with what a page could send instead.
 */
export const memoriesRpcProbes = {
  forget: async (probing) => {
    const { personId, markers } = probing;
    const [fixture, others] = await Promise.all([
      memoryFixture(probing),
      othersOwnMemory(markers),
    ]);
    const forget = async (
      name: string,
      memory: unknown,
      about?: Answer["about"],
      as = personId
    ) =>
      await answer(
        name,
        async () => await memoriesAs(as).forget(unchecked(memory)),
        about
      );
    return [
      await forget("a memory no one saved", crypto.randomUUID(), "nothing"),
      await forget("a hidden memory", fixture.hiddenMemory, "hidden"),
      await forget(
        "a memory in someone else's own store",
        others.memory,
        "hidden"
      ),
      await forget(
        "the reader's memory of another writer",
        fixture.seenMemory,
        "hidden"
      ),
      await forget(
        "as someone who isn't a member",
        others.memory,
        undefined,
        stranger()
      ),
      await forget("an id of the markers", markers.join("")),
      await forget("not an id", { memory: markers }),
    ];
  },
  ...memoryPageProbes({
    entities: async (personId, kind, from) =>
      await memoriesAs(personId).entities(
        unchecked(kind),
        unchecked(from === undefined ? undefined : onTheWire(from))
      ),
    memories: async (personId, entity, after) =>
      await memoriesAs(personId).memories(
        unchecked(entity),
        unchecked(after === undefined ? undefined : onTheWire(after))
      ),
    contested: async (personId, from) =>
      await memoriesAs(personId).contested(
        unchecked(from === undefined ? undefined : onTheWire(from))
      ),
    confirm: async (personId, memory) =>
      await memoriesAs(personId).confirm(unchecked(memory)),
    correct: async (personId, correction) =>
      await memoriesAs(personId).correct(unchecked(correction)),
  }),
} satisfies Record<
  "forget" | "entities" | "memories" | "contested" | "confirm" | "correct",
  Probe
>;

/** One way into the Brain: a module, or the store's class, and its probes. */
interface Surface {
  name: string;
  module: object;
  probes: Readonly<Record<string, Probe>>;
}

/**
 * Every way into the Brain the harness probes, each member of each by its
 * probe. Its names are the ones brain-next-modules.ts gives the modules
 * of core that import brain-next.ts.
 */
export const brainSurfaces = [
  {
    name: "core",
    module: coreBrain,
    probes: { ...coreProbes, ...corePersonMemories, ...coreCodeMemories },
  },
  { name: "instructions", module: instructionFiles, probes: instructionProbes },
  { name: "skills", module: brainSkills, probes: skillProbes },
  { name: "recall", module: codeRecall, probes: recallProbes },
  { name: "store", module: BrainStore, probes: storeProbes },
  { name: "sources", module: BrainSourcesRpc, probes: sourcesProbes },
  { name: "shares", module: skillShares, probes: shareProbes },
  { name: "memories", module: brainMemories, probes: memoriesProbes },
  { name: "memoriesRpc", module: BrainMemoriesRpc, probes: memoriesRpcProbes },
] as const satisfies readonly Surface[];

/**
 * A surface's members: a module's exports, or a class's public methods,
 * its own and any it inherits, up to the Durable Object base class.
 */
export const membersOf = (module: object): string[] => {
  if (typeof module !== "function") {
    return Object.keys(module);
  }
  const names = new Set<string>();
  for (
    let prototype: unknown = module.prototype;
    prototype !== DurableObject.prototype &&
    prototype !== Object.prototype &&
    typeof prototype === "object" &&
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      names.add(name);
    }
  }
  names.delete("constructor");
  // The runtime's own handler, which no caller reaches over RPC.
  names.delete("alarm");
  return [...names];
};
