import type {
  Access,
  AskModel,
  Embedders,
  Extract,
  HandOvers,
  ModelRequest,
  Reader,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

// Memories drawn from a source whose readers change (store.ts
// `changeReaders`, GRA-1761): a memory is read only by a reader of both its
// version and the current one, so a narrowing that lands before the
// drawing ran still gives those who remain what is drawn, a widening draws
// again for the readers it adds, and a narrowed reader reads none. Through
// the shared store's own calls and its queue, the model answered by the
// test.

const shared = () => env.BRAIN_STORE.getByName("brain");

const unique = (name: string): string => `${name}${crypto.randomUUID()}`;

const noModel: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

/** Each test's answers, by the token its text holds. */
const answers = new Map<string, unknown>();

/** The model: proposes what the test set for the token, and supports all of it. */
const ask: AskModel = async ({ purpose, input }: ModelRequest) => {
  await Promise.resolve();
  const proposed = [...answers].find(([token]) => input.includes(token))?.[1];
  if (purpose === "brain.extract") {
    return {
      kind: "answer",
      text: JSON.stringify(proposed ?? { entities: [], memories: [] }),
      model: "test/careful",
    };
  }
  const { statements } = z
    .object({ statements: z.array(z.object({ index: z.int() })) })
    .parse(JSON.parse(input));
  return {
    kind: "answer",
    text: JSON.stringify({ supported: statements.map(({ index }) => index) }),
    model: "test/quick",
  };
};

let clock = Date.now();

/** A few runs of the queue, a minute apart. */
const ticks = async (times = 3): Promise<void> => {
  for (let run = 0; run < times; run += 1) {
    clock += 60_000;
    // oxlint-disable-next-line no-await-in-loop -- one run at a time
    await shared().work({
      ask,
      at: new Date(clock),
      embedders: noModel,
      handOvers: noHandOvers,
      contextTokens: null,
    });
  }
};

const drawing: Extract = {
  speaker: { kind: "outside" },
  saidAt: new Date("2026-11-11T09:00:00Z"),
  timeZone: "Europe/Amsterdam",
  priority: "conversation",
};

/** Someone in `group` alone. */
const inGroup = (group: string): Reader => ({
  person: unique("p"),
  groups: [group],
});

/** The statements `reader` reads about the customers named `name`. */
const statementsOf = async (reader: Reader, name: string) => {
  const { entities } = await shared().findEntities({ reader, name });
  const read = await Promise.all(
    entities.map(
      async ({ id }) =>
        await shared().readMemories({ entity: id, reader, history: true })
    )
  );
  return read.flatMap(({ memories }) =>
    memories.map(({ statement }) => statement)
  );
};

/** A source for `access` whose text holds a token the model draws one memory about `name` from. */
const lease = async (access: Access, name: string) => {
  const token = unique("t");
  answers.set(token, {
    entities: [{ key: "c", kind: "customer", names: [name] }],
    memories: [
      {
        about: "c",
        type: "fact",
        statement: `${name} rents the north warehouse.`,
        quote: `${name} rents the north warehouse.`,
      },
    ],
  });
  const source = unique("test:");
  await shared().addSource({
    source,
    change: unique("c"),
    text: `${token}: ${name} rents the north warehouse.`,
    access,
    extract: drawing,
  });
  return source;
};

describe("memories of a source whose readers change", () => {
  beforeAll(async () => {
    await ticks(1);
  }, 30_000);

  it("draws them for those who remain when a narrowing lands before the drawing ran", async () => {
    const [stays, goes] = [unique("g"), unique("g")];
    const name = unique("Acme");
    const source = await lease(
      { kind: "readers", groups: [stays, goes] },
      name
    );
    // Before the queue ran, and without saying how to draw: as the queue
    // was drawing it.
    await shared().changeReaders({
      source,
      change: unique("c"),
      access: { kind: "readers", groups: [stays] },
    });
    await ticks();

    expect({
      stays: await statementsOf(inGroup(stays), name),
      goes: await statementsOf(inGroup(goes), name),
    }).toStrictEqual({
      stays: [`${name} rents the north warehouse.`],
      goes: [],
    });
  });

  it("draws them again for a reader a widening adds, and a narrowed reader reads none", async () => {
    const [first, added, narrowed] = [unique("g"), unique("g"), unique("g")];
    const name = unique("Beta");
    const source = await lease(
      { kind: "readers", groups: [first, narrowed] },
      name
    );
    await ticks();
    const before = {
      first: await statementsOf(inGroup(first), name),
      added: await statementsOf(inGroup(added), name),
    };
    // Widened to `added` and narrowed from `narrowed` at once.
    await shared().changeReaders({
      source,
      change: unique("c"),
      access: { kind: "readers", groups: [first, added] },
      extract: drawing,
    });
    await ticks();

    const firstAfter = await statementsOf(inGroup(first), name);

    expect({
      before,
      added: await statementsOf(inGroup(added), name),
      narrowed: await statementsOf(inGroup(narrowed), name),
      first: firstAfter.length > 0,
    }).toStrictEqual({
      before: {
        first: [`${name} rents the north warehouse.`],
        added: [],
      },
      added: [`${name} rents the north warehouse.`],
      narrowed: [],
      first: true,
    });
  });
});
