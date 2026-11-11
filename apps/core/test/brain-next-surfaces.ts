/**
 * Every way into the Brain, as the leak harness probes it
 * (brain-next-leaks.test.ts). A probe calls one surface every way it can
 * answer as a reader who may not read the marked sources: finding
 * something, finding nothing, refusing. It returns all that came back; the
 * harness looks for the markers in that, in the logs written meanwhile and
 * in what reached a model.
 *
 * Two lists, checked against what exists: `coreProbes` has one entry per
 * export of core's `brain-next.ts`, `storeProbes` one per public method
 * of the Brain's store (its contract, and anything else a holder of its
 * namespace could call). A member without an entry fails the type check
 * and the harness. A new surface is one more entry here.
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
import type { SourceReaders } from "../src/brain-next.ts";
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
  /**
   * Words only in sources the reader may not read. Probes ask for them
   * and put them in what they add, so a value echoed anywhere shows.
   */
  markers: readonly string[];
}

/** Calls one surface every way it can answer; returns what came back each time. */
export type Probe = (probing: Probing) => Promise<unknown[]>;

/** What a call gave: its value, or what its error carried. */
const outcome = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof Error)) {
      return { error: String(error) };
    }
    return {
      error: error.message,
      stack: error.stack,
      ...Object.fromEntries(Object.entries(error)),
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
 * Questions a reader asks: by the markers, by the shared word (found:
 * their own source), by both, as search syntax, as a prefix, empty, and
 * past the longest question (refused).
 */
const questionsOf = ({ sharedWord, markers }: Probing): string[] => {
  const hidden = markers.join(" ");
  const [first = ""] = markers;
  return [
    hidden,
    sharedWord,
    `${sharedWord} ${hidden}`,
    `${first}* OR "${hidden}" NEAR(${hidden}) text:${first} ^${first}`,
    first.slice(0, -1),
    "",
    `${hidden} `.repeat(questionMaxLength).slice(0, questionMaxLength + 1),
  ];
};

/** The Brain's store, as the harness reaches it: by its contract. */
const store = (): Brain => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** Each export of core's brain-next.ts. */
type CoreMember = keyof typeof coreBrain;

/** One probe per export of core's brain-next.ts. */
export const coreProbes = {
  addSource: async ({ markers }) => {
    const text = markedText(markers);
    const add = async (readers: SourceReaders, as = text) =>
      await outcome(
        async () => await coreBrain.addSource(env, { text: as, readers })
      );
    return [
      // Kept, for someone else; and for nobody.
      await add({ kind: "owner", personId: stranger() }),
      await add({ kind: "none" }),
      // Refused.
      await add(unchecked({ kind: "everyone" })),
      await add(unchecked({ kind: "owner", personId: "" })),
      await add(unchecked({ kind: "team", teamId: markers.join("") })),
      await add({ kind: "owner", personId: stranger() }, ""),
      await add(
        { kind: "owner", personId: stranger() },
        oversizedText(markers)
      ),
    ];
  },
  recallAs: async (probing) => {
    const asked: unknown[] = [];
    for (const question of questionsOf(probing)) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      const answer = await outcome(
        async () => await coreBrain.recallAs(env, probing.personId, question)
      );
      asked.push(answer);
    }
    // Someone who isn't a member (refused), asking for the markers.
    asked.push(
      await outcome(
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
    const add = async (access: Access, as = text) =>
      await outcome(async () => await store().addSource({ text: as, access }));
    return [
      // Kept, for someone else; and for nobody.
      await add({ kind: "owner", person: stranger() }),
      await add({ kind: "audience", group: stranger() }),
      await add({ kind: "none" }),
      // Refused.
      await add(unchecked({ kind: "everyone" })),
      await add(unchecked({ kind: "audience", group: "" })),
      await add(unchecked({ kind: "owner", person: text.repeat(300) })),
      await add(unchecked({ kind: "none", person: markers.join("") })),
      await add({ kind: "owner", person: stranger() }, oversizedText(markers)),
      await outcome(
        async () =>
          await store().addSource(
            unchecked({ text, access: { kind: "none" }, extra: text })
          )
      ),
    ];
  },
  recall: async (probing) => {
    const { reader, markers } = probing;
    const recall = async (question: string, as: Reader = reader) =>
      await outcome(async () => await store().recall({ question, reader: as }));
    const asked: unknown[] = [];
    for (const question of questionsOf(probing)) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      const answer = await recall(question);
      asked.push(answer);
    }
    const hidden = markers.join(" ");
    asked.push(
      // Refused: too many groups, a principal too long, an unknown field.
      await recall(hidden, {
        ...reader,
        groups: Array.from({ length: readerGroupsMax + 1 }, () =>
          markers.join("")
        ),
      }),
      await recall(hidden, { ...reader, person: hidden.repeat(300) }),
      await recall(hidden, unchecked({ ...reader, extra: hidden })),
      await outcome(
        async () =>
          await store().recall(
            unchecked({ question: hidden, reader, extra: hidden })
          )
      )
    );
    return asked;
  },
} satisfies Record<StoreMember, Probe>;

/**
 * Cases the design's access tests name whose feature isn't built yet. The
 * issue that builds it adds the case to the harness (a probe above, or a
 * test in brain-next-leaks.test.ts or brain-next-random.test.ts) and takes
 * its line out of this list.
 */
export const casesStillToCover = [
  {
    case: "A revoked share stops answering within a stated time",
    issue: "GRA-1761",
  },
  {
    case: "An email from outside never becomes a standing instruction",
    issue: "GRA-1737",
  },
  {
    case: "A model that saw a restricted source can't produce a company-readable fact",
    issue: "GRA-1737",
  },
  {
    case: "Markers in memories drawn from restricted sources stay out of every surface",
    issue: "GRA-1737",
  },
  {
    case: "Markers in entity names and company terms stay out of every surface",
    issue: "GRA-1740",
  },
  {
    case: "The pack's counts, gaps and suggestions of where to look hold no marker",
    issue: "GRA-1728",
  },
  {
    // The provider stub already sees every prompt sent while the probes
    // run; the first work that prompts a model must run then too.
    case: "Background work that prompts a model runs while the markers are planted",
    issue: "GRA-1737",
  },
  {
    case: "Erased content stays gone after a restore",
    issue: "GRA-1729",
  },
] as const;
