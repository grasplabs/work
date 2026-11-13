// What the round-trip tests of exports share (exports-roundtrip.test.ts,
// exports-interleave.test.ts): a tick, every public read of memories and
// entities for a set of readers, and an export restored into an empty
// store. Two stores answer alike when these reads are alike, but for what
// legitimately differs between them (`comparable`).
import type {
  AskModel,
  Embedders,
  HandOvers,
  Reader,
} from "@grasp-os/brain-next/contract";

import type { BrainStore } from "../src/store.ts";
import { restore } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

export type Store = DurableObjectStub<BrainStore>;

const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
};

const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

const noEmbedders: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

/** One tick of `store`, as the host's clock gives it. */
export const tick = async (store: Store): Promise<void> => {
  await store.work({
    ask: quietAsk,
    at: new Date(),
    embedders: noEmbedders,
    handOvers: noHandOvers,
  });
};

/**
 * `value` without what legitimately differs between two stores holding
 * the same: the moments pages are read at (a page's `at`) and their
 * cursors (`next`), and a chunk's row; dates as milliseconds.
 */
export const comparable = (value: unknown, top = true): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => comparable(item, false));
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => key !== "next" && key !== "row" && !(top && key === "at")
        )
        .map(([key, item]) => [key, comparable(item, false)])
    );
  }
  return value;
};

/** What `everyRead` reads: of whom, about what, and as of when. */
export interface Asked {
  readers: readonly Reader[];
  entities: readonly string[];
  names: readonly string[];
  emails: readonly string[];
  questions: readonly string[];
  /** The moment memories are read as of: past every write, so both stores read alike. */
  asOf: Date;
}

/** Every public read of memories and entities `asked` names, by a key each, comparable. */
export const everyRead = async (
  store: Store,
  { readers, entities, names, emails, questions, asOf }: Asked
): Promise<Record<string, unknown>> => {
  const reads: [string, () => Promise<unknown>][] = readers.flatMap(
    (reader, index): [string, () => Promise<unknown>][] => [
      ...entities.flatMap((entity): [string, () => Promise<unknown>][] => [
        [
          `reader ${index} memories of ${entity}`,
          async () => await store.readMemories({ entity, reader, asOf }),
        ],
        [
          `reader ${index} history of ${entity}`,
          async () =>
            await store.readMemories({ entity, reader, asOf, history: true }),
        ],
        [
          `reader ${index} entity ${entity}`,
          async () => await store.readEntity({ entity, reader }),
        ],
        [
          `reader ${index} names of ${entity}`,
          async () => await store.readEntityNames({ entity, reader }),
        ],
        [
          `reader ${index} contested of ${entity}`,
          async () => await store.listContested({ reader, entity }),
        ],
      ]),
      [
        `reader ${index} contested`,
        async () => await store.listContested({ reader }),
      ],
      ...(["customer", "person"] as const).map(
        (kind): [string, () => Promise<unknown>] => [
          `reader ${index} ${kind}s`,
          async () => await store.findEntities({ reader, kind }),
        ]
      ),
      ...names.map((name): [string, () => Promise<unknown>] => [
        `reader ${index} named ${name}`,
        async () => await store.findEntities({ reader, name }),
      ]),
      ...emails.map((value): [string, () => Promise<unknown>] => [
        `reader ${index} with ${value}`,
        async () =>
          await store.findEntities({
            reader,
            identifier: { type: "email", value },
          }),
      ]),
      ...questions.map((question): [string, () => Promise<unknown>] => [
        `reader ${index} recalls ${question}`,
        async () =>
          await store.recall({ question, reader, budget: { tokens: 4000 } }),
      ]),
    ]
  );
  const answered: Record<string, unknown> = {};
  for (const [key, read] of reads) {
    // oxlint-disable-next-line no-await-in-loop -- one read at a time
    answered[key] = comparable(await read());
  }
  return answered;
};

/** The keys of `before` whose read `after` answers otherwise. */
export const differences = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>
): string[] =>
  Object.keys(before).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  );

/**
 * Ticks the store `store` names until `state` says it is past `waiting`:
 * at most 40 ticks; its last state. A stub is taken afresh for each call,
 * as one whose store was killed answers nothing more.
 */
const tickedPast = async (
  store: () => Store,
  state: () => Promise<string | undefined>,
  waiting: string
): Promise<string | undefined> => {
  let now: string | undefined = waiting;
  for (let ticks = 0; ticks < 40 && now === waiting; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick(store());
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    now = await state();
  }
  return now;
};

/** Ticks the store until its export `id` is no longer being written: its state. */
export const exportSettled = async (
  store: () => Store,
  id: string
): Promise<string | undefined> =>
  await tickedPast(
    store,
    async () => {
      const status = await store().exportStatus({ id });
      return status?.state;
    },
    "writing"
  );

/**
 * The export `id` of the store restored after its storage is lost (put
 * back as `empty`, the bucket kept): the restore's last state.
 */
export const restoredAfterLoss = async (
  store: () => Store,
  id: string,
  empty: Copy
): Promise<string | undefined> => {
  await restore(store(), empty);
  await store().startRestore(id, "test");
  return await tickedPast(
    store,
    async () => {
      const status = await store().restoreStatus(id);
      return status?.state;
    },
    "running"
  );
};
