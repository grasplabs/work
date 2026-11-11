/**
 * Every way into the Brain, as the leak harness probes it
 * (brain-next-leaks.test.ts). A probe calls one surface every way it can
 * answer as a reader who may not read the marked sources: finding
 * something, finding nothing, refusing. It returns all that came back; the
 * harness looks for the markers in that, in the logs written meanwhile and
 * in what reached a model, and holds each answer to what the reader asked
 * only of hidden sources to the answer to words nothing holds.
 *
 * Two lists, checked against what exists: `coreProbes` has one entry per
 * export of core's `brain-next.ts`, `storeProbes` one per public method
 * of the Brain's store (its contract, and anything else a holder of its
 * namespace could call). A member without an entry fails the type check
 * and the harness. A new surface is one more entry here:
 *
 * - one that answers about a single item probes it with `hiddenIds`;
 * - one with no reader (an overview, a step the clock runs) ignores the
 *   reader: what it returns, logs or sends a model must hold no marker in
 *   any pass.
 */
import {
  brainOf,
  questionMaxLength,
  readerGroupsMax,
  sourceTextMaxBytes,
} from "@grasp-os/brain-next/contract";
import type { Access, Brain, Reader } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";

import * as coreBrain from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import type { BrainStore } from "../src/index.ts";

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
  /** A word no source holds. */
  unknownWord: string;
  /**
   * Words only in sources the reader may not read. Probes ask for them
   * and put them in what they add, so a value echoed anywhere shows.
   */
  markers: readonly string[];
  /**
   * Sources the reader may read no version of: someone else's, a team's
   * they aren't in, one nobody may read, and one whose readers were
   * narrowed away from them (they could read its first version, and no
   * longer can).
   */
  hiddenIds: readonly SourceRef[];
}

/** One call a probe made, and what came back. */
export interface Answer {
  /** What was called, for a failure. */
  call: string;
  /** Its value, or everything its error carried. */
  got: { value: unknown } | { error: unknown };
  /**
   * `hidden`: asked only of what the reader may not read; `nothing`: asked
   * of what nothing holds. Every `hidden` answer of a probe must equal its
   * `nothing` answer exactly.
   */
  about?: "hidden" | "nothing";
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
  about?: Answer["about"]
): Promise<Answer> => {
  try {
    return { call: callName, got: { value: await call() }, about };
  } catch (error) {
    return { call: callName, got: { error: unfolded(error) }, about };
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

/** A question a reader asks, and what it asks of. */
interface Question {
  name: string;
  text: string;
  about?: Answer["about"];
}

/**
 * Questions a reader asks: by the markers, as search syntax and as a
 * prefix (only what they may not read); by a word nothing holds; by the
 * shared word (found: their own source); by both; empty; and past the
 * longest question (refused).
 */
const questionsOf = ({
  sharedWord,
  unknownWord,
  markers,
}: Probing): Question[] => {
  const hidden = markers.join(" ");
  const [first = ""] = markers;
  return [
    { name: "the markers", text: hidden, about: "hidden" },
    {
      name: "the markers as search syntax",
      text: `${first}* OR "${hidden}" NEAR(${hidden}) text:${first} ^${first}`,
      about: "hidden",
    },
    { name: "a marker's prefix", text: first.slice(0, -1), about: "hidden" },
    { name: "a word nothing holds", text: unknownWord, about: "nothing" },
    { name: "the shared word", text: sharedWord },
    {
      name: "the shared word and the markers",
      text: `${sharedWord} ${hidden}`,
    },
    { name: "nothing", text: "" },
    {
      name: "too long a question",
      text: `${hidden} `
        .repeat(questionMaxLength)
        .slice(0, questionMaxLength + 1),
    },
  ];
};

/** The Brain's store, as the harness reaches it: by its contract. */
const store = (): Brain => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A source no one added. */
const missingSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

/** `source`'s key in the store, as core names it (core's brain-next.ts). */
const keyOf = ({ producer, id }: SourceRef): string => `${producer}:${id}`;

/** The versions a probe asks of each source: the first two, and one past. */
const askedVersions = [1, 2, 3] as const;

/** Times a sweep is asked for: now, far ahead, and long ago. */
const sweepTimes = (): Date[] => [
  new Date(),
  new Date(Date.now() + 365 * 86_400_000),
  new Date(0),
];

/** Each export of core's brain-next.ts. */
type CoreMember = keyof typeof coreBrain;

/** One probe per export of core's brain-next.ts. */
export const coreProbes = {
  addSource: async ({ markers }) => {
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
    ];
  },
  readSourceVersionAs: async ({ personId, hiddenIds, markers }) => {
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
    for (const [index, source] of hiddenIds.entries()) {
      for (const version of askedVersions) {
        // oxlint-disable-next-line no-await-in-loop -- one read at a time
        const answered = await read(
          `hidden source ${index}, version ${version}`,
          source,
          version,
          personId,
          "hidden"
        );
        asked.push(answered);
      }
    }
    const [hidden = missingSource()] = hiddenIds;
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
  sweepBrain: async () => {
    const asked: Answer[] = [];
    for (const at of sweepTimes()) {
      // oxlint-disable-next-line no-await-in-loop -- one sweep at a time
      const answered = await answer(`as of ${at.toISOString()}`, async () => {
        await coreBrain.sweepBrain(env, at);
      });
      asked.push(answered);
    }
    asked.push(
      await answer("as of no time", async () => {
        await coreBrain.sweepBrain(env, unchecked("never"));
      })
    );
    return asked;
  },
  recallAs: async (probing) => {
    const asked: Answer[] = [];
    for (const { name, text, about } of questionsOf(probing)) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      const answered = await answer(
        name,
        async () => await coreBrain.recallAs(env, probing.personId, text),
        about
      );
      asked.push(answered);
    }
    asked.push(
      await answer(
        "the markers, as someone who isn't a member",
        async () =>
          await coreBrain.recallAs(env, stranger(), probing.markers.join(" "))
      )
    );
    return asked;
  },
} satisfies Record<CoreMember, Probe>;

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
  readVersion: async ({ reader, hiddenIds, markers }) => {
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
    for (const [index, source] of hiddenIds.entries()) {
      for (const version of askedVersions) {
        // oxlint-disable-next-line no-await-in-loop -- one read at a time
        const answered = await read(
          `hidden source ${index}, version ${version}`,
          keyOf(source),
          version,
          reader,
          "hidden"
        );
        asked.push(answered);
      }
    }
    const hidden = keyOf(hiddenIds[0] ?? missingSource());
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
  sweep: async ({ markers }) => {
    const asked: Answer[] = [];
    for (const at of sweepTimes()) {
      // oxlint-disable-next-line no-await-in-loop -- one sweep at a time
      const answered = await answer(`as of ${at.toISOString()}`, async () => {
        await store().sweep({ at });
      });
      asked.push(answered);
    }
    asked.push(
      await answer("as of no time", async () => {
        await store().sweep(unchecked({ at: markers.join(" ") }));
      }),
      await answer("a request with an unknown field", async () => {
        await store().sweep(
          unchecked({ at: new Date(), extra: markers.join(" ") })
        );
      })
    );
    return asked;
  },
  recall: async (probing) => {
    const { reader, markers } = probing;
    const recall = async (
      name: string,
      question: string,
      as: Reader = reader,
      about?: Answer["about"]
    ) =>
      await answer(
        name,
        async () => await store().recall({ question, reader: as }),
        about
      );
    const asked: Answer[] = [];
    for (const { name, text, about } of questionsOf(probing)) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      const answered = await recall(name, text, reader, about);
      asked.push(answered);
    }
    const hidden = markers.join(" ");
    asked.push(
      await recall("too many groups", hidden, {
        ...reader,
        groups: Array.from({ length: readerGroupsMax + 1 }, () =>
          markers.join("")
        ),
      }),
      await recall("too long a person", hidden, {
        ...reader,
        person: hidden.repeat(300),
      }),
      await recall(
        "a reader with an unknown field",
        hidden,
        unchecked({ ...reader, extra: hidden })
      ),
      await answer(
        "a request with an unknown field",
        async () =>
          await store().recall(
            unchecked({ question: hidden, reader, extra: hidden })
          )
      )
    );
    return asked;
  },
} satisfies Record<StoreMember, Probe>;
