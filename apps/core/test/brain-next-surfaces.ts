/**
 * Every way into the Brain, as the leak harness probes it
 * (brain-next-leaks.test.ts). A probe calls one surface every way it can
 * answer as a reader who may not read the marked sources: finding
 * something, finding nothing, refusing. It returns all that came back; the
 * harness looks for the markers in that, in the logs written meanwhile and
 * in what reached a model, and holds each answer to what the reader asked
 * only of hidden sources to the answer to words nothing holds.
 *
 * Three lists, checked against what exists: `coreProbes` has one entry
 * per export of core's `brain-next.ts`, `instructionProbes` one per export
 * of core's `instruction-files.ts` (the rules over the instruction files
 * brain-next.ts names), `storeProbes` one per public method of the
 * Brain's store (its contract, and anything else a holder of its
 * namespace could call). A member without an entry fails the type check
 * and the harness. A new surface is one more entry here:
 *
 * - one that answers about a single item probes it with `hiddenVersions`;
 * - one with no reader (an overview, a step the clock runs) ignores the
 *   reader: what it returns, logs or sends a model must hold no marker in
 *   any pass.
 */
import {
  brainOf,
  currentReadMax,
  instructionsMaxLength,
  modelNameMaxLength,
  questionMaxLength,
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
  ChunkRef,
  EmbedModel,
  ErasureReason,
  Embedders,
  Reader,
  VectorModel,
  VectorsToPut,
} from "@grasp-os/brain-next/contract";
import {
  defineWork,
  enqueueWork,
  workAttemptsMax,
} from "@grasp-os/brain-next/work";
import type { Authority } from "@grasp-os/shared/permissions";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { embedInProcess } from "../../../packages/embed/test/test-models.ts";
import * as coreBrain from "../src/brain-next.ts";
import type {
  InstructionFile,
  InstructionFileVersion,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import type { BrainStore } from "../src/index.ts";
import * as instructionFiles from "../src/instruction-files.ts";

/** The reader a probe calls as, and what they may not see. */
export interface Probing {
  /** The reader, a member of the organization, as core names them. */
  personId: string;
  /**
   * The same reader as the Brain's contract takes them: the person and
   * their teams as core names its groups (`team:<id>`, core's
   * brain-next.ts).
   */
  reader: Reader;
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
 * The host's embedders, as a probe hands them: they run a model, and fail
 * every passage with the passages and the markers in their error, so
 * anything of an error that gets out shows.
 */
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

/** Each export of core's brain-next.ts. */
type CoreMember = keyof typeof coreBrain;

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
    ];
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
  recallAs: async (probing) => {
    const recall = async (asking: PackAsk) =>
      await coreBrain.recallAs(env, probing.personId, asking);
    const hidden = probing.markers.join(" ");
    const whole = { tokens: recallBudgetMax };
    return [
      ...(await askedOfMarkers(probing, momentsOf(probing), recall)),
      await answer(
        "the shared word",
        async () =>
          await recall({ question: probing.sharedWord, budget: whole })
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
        "no tokens",
        async () => await recall({ question: hidden, budget: { tokens: 0 } })
      ),
      await answer(
        "a moment named by the markers",
        async () =>
          await recall(
            unchecked({ question: hidden, budget: whole, asOf: hidden })
          )
      ),
      await answer(
        "the markers, as someone who isn't a member",
        async () =>
          await coreBrain.recallAs(env, stranger(), {
            question: hidden,
            budget: whole,
          })
      ),
    ];
  },
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
        await coreBrain.workBrain(env, at);
      },
      "a marked item worked through core's clock"
    );
    for (const at of sweepTimes()) {
      // oxlint-disable-next-line no-await-in-loop -- one tick at a time
      const answered = await answer(
        `a tick as of ${at.toISOString()}`,
        async () => {
          await coreBrain.workBrain(env, at);
        }
      );
      asked.push(answered);
    }
    asked.push(
      await answer("a tick at no time", async () => {
        await coreBrain.workBrain(env, unchecked(markers.join(" ")));
      })
    );
    return asked;
  },
  // Erasure has no reader: what it answers must be alike whether there
  // was anything to erase, and hold no marker. Each probe erases marked
  // content of its own (someone else's), never the planted sources later
  // passes read.
  eraseSource: async ({ markers }) => {
    const erase = async (
      name: string,
      source: SourceRef,
      reason: ErasureReason = "deleted",
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => {
          await coreBrain.eraseSource(env, { source, reason });
        },
        about
      );
    const marked = missingSource();
    await coreBrain.addSource(env, {
      source: marked,
      change: crypto.randomUUID(),
      text: markedText(markers),
      readers: { kind: "owner", personId: stranger() },
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
    ];
  },
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
      await erase("someone with nothing", stranger(), "withdrawn", "nothing"),
      await erase("someone with marked sources", holder, "withdrawn", "hidden"),
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
  brainWorkOverview: async ({ markers }) => [
    ...(await workMarked(
      markers,
      async (at) => {
        await store().work(quietModel, at, noEmbedders);
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
        await coreBrain.workBrain(env, at);
      },
      "a marked item worked through core's clock after a re-embed"
    )),
  ],
} satisfies Record<CoreMember, Probe>;

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

/**
 * Each public method of the Brain's store: what it defines, not the
 * handlers its base class only declares. The store implements `Brain`,
 * so the contract's members are among them.
 */
type StoreMember = {
  [
    Key in Exclude<keyof BrainStore, keyof Rpc.DurableObjectBranded>
  ]-?: Key extends string
    ? Record<never, never> extends Pick<BrainStore, Key>
      ? never
      : Key
    : never;
}[Exclude<keyof BrainStore, keyof Rpc.DurableObjectBranded>];

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
        await store().work(quietModel, nextDay(), embedders);
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
const vectorScene = async (reader: Reader) => {
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
  recall: async (probing) => {
    const { reader, markers } = probing;
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
    return [
      ...(await askedOfMarkers(probing, momentsOf(probing), recall)),
      ...withGroups.map((answered) => ({
        ...answered,
        call: `${like}: ${answered.call}`,
        like: `${like}: ${answered.like ?? ""}`,
      })),
      await answer(
        "the shared word",
        async () =>
          await recall({ question: probing.sharedWord, budget: whole })
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
    const inTail = await modelWith(
      placedAt(firstChunksOf(hiddenVersions), question),
      placedAt(
        await chunkedSource(
          { kind: "owner", person: stranger() },
          rescoredMost + 44,
          words
        ),
        question
      )
    );
    const inBlock = await modelWith(
      placedAt(
        await chunkedSource(
          { kind: "owner", person: stranger() },
          vectorBlockSize,
          words
        ),
        question
      )
    );
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
    return asked;
  },
  addInstructions: async ({ markers }) => {
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
    return [
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
        await store().work(quietModel, at, noEmbedders);
      },
      "a marked item worked by the store"
    )),
    ...(await Promise.all(
      sweepTimes().map(
        async (at) =>
          await answer(`a tick as of ${at.toISOString()}`, async () => {
            await store().work(quietModel, at, noEmbedders);
          })
      )
    )),
    // One tick with embedders that fail with the passages and the markers
    // in their error: what embedding's items do with a failure.
    await answer("a tick whose embedders fail", async () => {
      await store().work(quietModel, nextDay(), leakyEmbedders(markers));
    }),
    await answer("a tick at no time", async () => {
      await store().work(
        quietModel,
        unchecked(markers.join(" ")),
        leakyEmbedders(markers)
      );
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
      await store().work(quietModel, nextDay(), leakyEmbedders(markers));
    }),
    ...(await workMarked(
      markers,
      async (at) => {
        await store().reembed();
        await store().work(quietModel, at, noEmbedders);
      },
      "a marked item worked after a re-embed"
    )),
  ],
  workOverview: async ({ markers }) => [
    ...(await workMarked(
      markers,
      async (at) => {
        await store().work(quietModel, at, noEmbedders);
      },
      "a marked item worked to parking"
    )),
    await answer(
      "the store's overview, the marked item parked",
      async () => await store().workOverview()
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
} satisfies Record<StoreMember, Probe>;
