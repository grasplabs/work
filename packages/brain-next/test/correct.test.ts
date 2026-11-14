// Correcting a memory, and retiring a writer's own memory for a reader of
// no person (correct.ts, memories.ts), through the store's own methods.
// The threat model is on GRA-1837: a fix keeps the readers of the memory
// it corrects, exactly, or is not written; the memory is found by its id,
// never in a list a cap could cut. Every test has its own groups, sources
// and entities, so what earlier tests left in the shared store is hidden
// from it.
import type {
  Access,
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { memoriesReadMax } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { BrainStore } from "../src/store.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");
const unique = (name: string): string => `${name}-${crypto.randomUUID()}`;
const audience = (group: string): Access => ({ kind: "audience", group });
/** A reader of no person, as the host's code reads: its groups alone. */
const groupsOf = (...groups: string[]): Reader => ({ person: null, groups });

/**
 * An RPC call's answer as a plain promise, awaited: a refused call's
 * rejection is then the test's alone, never left unhandled.
 */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

/** A customer entity of the add, under key `c`. */
const customer: NewEntity = { key: "c", kind: "customer", names: ["Acme"] };

/** A memory about `c`: its status, as `statement`, resting on `basis`. */
const status = (
  basis: NewMemory["basis"],
  value: string,
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about: "c",
  attribute: "status",
  value,
  type: "fact",
  statement: `Acme is ${value}`,
  speaker: { kind: "system" },
  basis,
  ...extra,
});

/**
 * Adds `memories` about Acme, readable as `access` says, a new Acme or the
 * entity `id`: their ids and Acme's.
 */
const remember = async (
  access: Access,
  memories: NewMemory[],
  id?: string
): Promise<{ entity: string; memories: string[] }> => {
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access,
    entities: [id === undefined ? customer : { ...customer, id }],
    memories,
  });
  return { entity: added.entities.c ?? "", memories: added.memories };
};

/** A source of its own in the shared store: its version. */
const addSource = async (
  text: string,
  access: Access,
  source = unique("test")
): Promise<{ source: string; version: number }> =>
  await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text,
    access,
  });

/** A correction of `memory` by the App `writer`, for `reader`, under a new change. */
const correction = (
  memory: string,
  reader: Reader,
  writer: string,
  fix: { value?: string; statement: string },
  change: string = crypto.randomUUID()
) => ({
  change,
  memory,
  reader,
  writer,
  speaker: { kind: "agent" as const, agent: writer },
  ...fix,
});

/**
 * What `reader` reads of Acme's status: each memory's statement, who
 * confirmed it, and whether it is contested, in the store's order.
 */
const statusAsRead = async (
  entity: string,
  reader: Reader
): Promise<
  { statement: string; confirmedBy: string | null; contested: boolean }[]
> => {
  const { memories } = await shared().readMemories({
    entity,
    reader,
    attribute: "status",
  });
  return memories.map(({ statement, confirmed, contested }) => ({
    statement,
    confirmedBy: confirmed?.by ?? null,
    contested,
  }));
};

/** How many memories the shared store holds. */
const memoriesHeld = async (): Promise<number> =>
  await runInDurableObject(
    shared(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM memories")
        .one().count
  );

describe("correcting a memory", () => {
  it("files an App's fix under the memory's own readers, unconfirmed and contested with it, and leaves the memory as it was", async () => {
    const group = unique("group");
    const app = unique("app:corrector");
    const version = await addSource("Acme is active", audience(group));
    const { entity, memories } = await remember(audience(group), [
      status({ kind: "source", ...version, quote: "Acme is active" }, "active"),
    ]);
    const [target = ""] = memories;

    const fix = await shared().correctMemory(
      correction(target, groupsOf(group), app, {
        value: "churned",
        statement: "Acme left in May",
      })
    );

    expect({
      member: await statusAsRead(entity, groupsOf(group)),
      outsider: await statusAsRead(entity, groupsOf(unique("other"))),
      fix: typeof fix,
    }).toStrictEqual({
      // An agent's word is no person's confirmation: both stand.
      member: [
        { statement: "Acme left in May", confirmedBy: null, contested: true },
        { statement: "Acme is active", confirmedBy: null, contested: true },
      ],
      outsider: [],
      fix: "string",
    });
  });

  it("confirms a person's own correction in their name, read first, both sides still shown", async () => {
    const group = unique("group");
    const person = unique("person");
    const version = await addSource("Acme is active", audience(group));
    const { entity, memories } = await remember(audience(group), [
      status({ kind: "source", ...version, quote: "Acme is active" }, "active"),
    ]);
    const reader = { person, groups: [group] };

    await shared().correctMemory({
      change: crypto.randomUUID(),
      memory: memories[0] ?? "",
      reader,
      writer: person,
      speaker: { kind: "internal", person },
      value: "churned",
      statement: "Acme left in May",
    });

    await expect(statusAsRead(entity, reader)).resolves.toStrictEqual([
      { statement: "Acme left in May", confirmedBy: person, contested: true },
      { statement: "Acme is active", confirmedBy: null, contested: true },
    ]);
  });

  it("answers null alike for no such memory, a hidden one, one no longer current, a relation, and one whose readers can't be kept, and writes nothing", async () => {
    const group = unique("group");
    const reader = groupsOf(group);
    const app = unique("app:corrector");
    // Hidden: readable by another group alone.
    const hidden = await remember(audience(unique("hidden")), [
      status({ kind: "writer", writer: unique("w") }, "active"),
    ]);
    // No longer current: its writer said something newer.
    const writer = unique("w");
    const ended = await remember(audience(group), [
      status({ kind: "writer", writer }, "active"),
    ]);
    await remember(
      audience(group),
      [status({ kind: "writer", writer }, "paused")],
      ended.entity
    );
    // A relation: Acme's account owner.
    const related = await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      entities: [customer, { key: "p", kind: "person", names: ["Anna Smit"] }],
      memories: [
        {
          about: "c",
          attribute: "account_owner",
          object: "p",
          type: "fact",
          statement: "Anna owns Acme",
          speaker: { kind: "system" },
          basis: { kind: "writer", writer: unique("w") },
        },
      ],
    });
    // Readers that can't be kept: its source's current version is read by
    // the group and another; the memory by the group alone.
    const source = unique("narrowed");
    const first = await addSource("Acme is active", audience(group), source);
    const narrowed = await remember(audience(group), [
      status({ kind: "source", ...first, quote: "Acme is active" }, "active"),
    ]);
    const other = unique("other");
    await addSource("Acme is active, still", audience(other), source);
    const both = groupsOf(group, other);
    const before = await memoriesHeld();

    const answers = [
      await shared().correctMemory(
        correction(crypto.randomUUID(), reader, app, {
          value: "churned",
          statement: "Gone",
        })
      ),
      await shared().correctMemory(
        correction(hidden.memories[0] ?? "", reader, app, {
          value: "churned",
          statement: "Gone",
        })
      ),
      await shared().correctMemory(
        correction(ended.memories[0] ?? "", reader, app, {
          value: "churned",
          statement: "Gone",
        })
      ),
      await shared().correctMemory(
        correction(related.memories[0] ?? "", reader, app, {
          statement: "Someone else owns Acme",
        })
      ),
      await shared().correctMemory(
        correction(narrowed.memories[0] ?? "", both, app, {
          value: "churned",
          statement: "Gone",
        })
      ),
    ];

    expect({ answers, written: (await memoriesHeld()) - before }).toStrictEqual(
      { answers: [null, null, null, null, null], written: 0 }
    );
    // The last one is readable to that reader: only its readers stop it.
    await expect(statusAsRead(narrowed.entity, both)).resolves.toStrictEqual([
      { statement: "Acme is active", confirmedBy: null, contested: false },
    ]);
  });

  it("answers the same fix for the same change again, and refuses another correction under it", async () => {
    const group = unique("group");
    const app = unique("app:corrector");
    const { entity, memories } = await remember(audience(group), [
      status({ kind: "writer", writer: unique("w") }, "active"),
    ]);
    const asked = correction(
      memories[0] ?? "",
      groupsOf(group),
      app,
      { value: "churned", statement: "Acme left" },
      unique("change")
    );

    const first = await shared().correctMemory(asked);
    const again = await shared().correctMemory(asked);
    const other = await called(
      shared().correctMemory({ ...asked, statement: "Acme left in May" })
    ).then(() => "answered", String);

    expect({
      same: again === first,
      other: other.includes("made before as another correction"),
      read: await statusAsRead(entity, groupsOf(group)),
    }).toStrictEqual({
      same: true,
      other: true,
      read: [
        { statement: "Acme left", confirmedBy: null, contested: true },
        { statement: "Acme is active", confirmedBy: null, contested: true },
      ],
    });
  });

  it("refuses a fix its attribute doesn't take, and an agent's fix of a preference, writing nothing", async () => {
    const group = unique("group");
    const app = unique("app:corrector");
    const person = unique("person");
    const { memories } = await remember(audience(group), [
      status({ kind: "writer", writer: unique("w") }, "active"),
    ]);
    const preference = await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      entities: [{ key: "p", kind: "person", names: ["Anna Smit"] }],
      memories: [
        {
          about: "p",
          attribute: "preference",
          value: "short replies",
          type: "preference",
          statement: "Anna prefers short replies",
          speaker: { kind: "internal", person },
          basis: { kind: "writer", writer: person },
        },
      ],
    });
    const before = await memoriesHeld();
    const refusal = async (asked: Parameters<BrainStore["correctMemory"]>[0]) =>
      await called(shared().correctMemory(asked)).catch(String);

    const refused = [
      await refusal(
        correction(memories[0] ?? "", groupsOf(group), app, {
          statement: "No value",
        })
      ),
      await refusal(
        correction(preference.memories[0] ?? "", groupsOf(group), app, {
          value: "long replies",
          statement: "Anna prefers long replies",
        })
      ),
    ];

    expect({ refused, written: (await memoriesHeld()) - before }).toStrictEqual(
      {
        refused: [
          expect.stringContaining("exactly when its memory's attribute holds"),
          expect.stringContaining("breaks a memory's rules"),
        ],
        written: 0,
      }
    );
  });

  it("finds the memory by its id past a page of others the reader may read", async () => {
    const group = unique("group");
    const app = unique("app:corrector");
    const notes = (count: number): NewMemory[] =>
      Array.from({ length: count }, (_, at) => ({
        about: "c",
        type: "fact" as const,
        statement: `Note ${at}`,
        speaker: { kind: "system" as const },
        basis: { kind: "writer" as const, writer: unique("w") },
      }));
    // The oldest, then a page and more of newer ones: it is last in every
    // order a read pages by.
    const oldest = await remember(audience(group), notes(1));
    await remember(audience(group), notes(memoriesReadMax));
    await remember(audience(group), notes(1));

    const fix = await shared().correctMemory(
      correction(oldest.memories[0] ?? "", groupsOf(group), app, {
        statement: "The oldest note was wrong",
      })
    );

    expect(fix).toBeTypeOf("string");
  });
});

describe("retiring a writer's own memory", () => {
  it("retires the named writer's own for a reader of no person, and answers nothing for another writer's", async () => {
    const group = unique("group");
    const app = unique("app:writer");
    const { entity, memories } = await remember(audience(group), [
      status({ kind: "writer", writer: app }, "active"),
    ]);
    const others = await remember(
      audience(group),
      [status({ kind: "writer", writer: unique("w") }, "paused")],
      entity
    );
    const reader = groupsOf(group);

    const outcomes = [
      await shared().retireMemory({
        memory: others.memories[0] ?? "",
        reader,
        writer: app,
      }),
      await shared().retireMemory({
        memory: memories[0] ?? "",
        reader: groupsOf(unique("other")),
        writer: app,
      }),
      await shared().retireMemory({
        memory: memories[0] ?? "",
        reader,
        writer: app,
      }),
      await shared().retireMemory({
        memory: memories[0] ?? "",
        reader,
        writer: app,
      }),
    ];
    const refused = await called(
      shared().retireMemory({ memory: memories[0] ?? "", reader })
    ).then(() => "answered", String);
    const read = await statusAsRead(entity, reader);

    expect({
      outcomes,
      refused: refused.includes("Names no writer"),
      read: read.map(({ statement }) => statement),
    }).toStrictEqual({
      outcomes: ["nothing", "nothing", "done", "done"],
      refused: true,
      read: ["Acme is paused"],
    });
  });
});
