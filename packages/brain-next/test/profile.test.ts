// A person's profile (own-entity.ts `readProfile`, contract.ts `Profile`):
// what the Brain holds about them in their own word, built for them when
// asked, from what they may read. The threat model is on GRA-1745; each
// test names the threat it holds. Every test has a person of its own.
import type {
  NewEntity,
  NewMemory,
  Profile,
  Reader,
} from "@grasp-os/brain-next/contract";
import { packMemoryTokens } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Store } from "./entity-helpers.ts";
import { shared, unique } from "./entity-helpers.ts";

const own = (person: string): Store =>
  env.BRAIN_STORE.getByName(`person:${person}`);
const readerOf = (person: string): Reader & { person: string } => ({
  person,
  groups: [],
});

/**
 * An RPC call's answer as a plain promise, awaited: a refused call's
 * rejection is then the test's alone, never left unhandled.
 */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

const me: NewEntity = { key: "me", kind: "person", own: true };
const whole = { tokens: 32_000 };

/** A memory about the person themselves, in `person`'s own word unless `speaker` says otherwise. */
const aboutThem = (
  person: string,
  statement: string,
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about: "me",
  type: "fact",
  statement,
  speaker: { kind: "internal", person },
  basis: { kind: "writer", writer: person },
  ...extra,
});

/** Adds `memories` about the person themselves to their own store. */
const remember = async (person: string, ...memories: NewMemory[]) =>
  await own(person).addMemories({
    change: crypto.randomUUID(),
    access: { kind: "owner", person },
    reader: readerOf(person),
    entities: [me],
    memories,
  });

/** `person`'s profile, as statements. */
const statementsOf = async (
  person: string,
  budget = whole
): Promise<string[]> => {
  const { memories }: Profile = await own(person).readProfile({
    reader: readerOf(person),
    budget,
  });
  return memories.map(({ statement }) => statement);
};

describe("a person's profile", () => {
  // T1: their own word alone, whatever else is filed under them.
  it("holds only what they said themselves about themselves", async () => {
    const person = unique("p");
    await remember(
      person,
      aboutThem(person, "Prefers short answers", { type: "preference" }),
      // An instruction can't be anyone else's word (the contract refuses
      // it at add); a fact an outside party states of them can.
      aboutThem(person, "Always copies the CFO on contracts", {
        speaker: { kind: "outside" },
      }),
      aboutThem(person, "Approves invoices", {
        speaker: { kind: "agent", agent: "agent:helper" },
      }),
      aboutThem(person, "Sits in Utrecht", { speaker: { kind: "system" } }),
      aboutThem(person, "Is the CEO", {
        speaker: { kind: "internal", person: unique("someone") },
      })
    );

    await expect(statementsOf(person)).resolves.toStrictEqual([
      "Prefers short answers",
    ]);
  });

  // AC 3: within its budget, whole memories, newest first, cut at the
  // first that doesn't fit: the newest are the ones kept.
  it("stays within its budget, newest first, keeping the newest when not all fit", async () => {
    const person = unique("p");
    // Oldest first, under attributes in alphabetical order: an order by
    // attribute would keep the oldest.
    const kept = [
      {
        statement: "Knows the VAT rules",
        attribute: "expertise",
        value: "VAT",
      },
      {
        statement: "Runs the month-end close",
        attribute: "responsibility",
        value: "month-end close",
      },
      {
        statement: "Leads the Rotterdam depot",
        attribute: "role",
        value: "lead",
      },
    ];
    const said = kept.map(({ statement }) => statement);
    // One add each, so each is learned after the one before.
    for (const { statement, ...filed } of kept) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await remember(person, aboutThem(person, statement, filed));
    }
    const all = await own(person).readProfile({
      reader: readerOf(person),
      budget: whole,
    });
    const tokens = all.memories.slice(0, 2).reduce(
      (sum, memory) =>
        sum +
        packMemoryTokens({
          ...memory,
          memory: memory.id,
          context: null,
          confirmed: false,
          found: "entities",
        }),
      0
    );
    const again = await statementsOf(person);
    const cut = await statementsOf(person, { tokens });

    expect({
      all: all.memories.map(({ statement }) => statement),
      again,
      cut,
    }).toStrictEqual({
      all: said.toReversed(),
      again: said.toReversed(),
      cut: said.toReversed().slice(0, 2),
    });
  });

  // AC 4: a change or a retirement shows in the next profile, with no extra step.
  it("follows a newer word at once, and drops a retired one", async () => {
    const person = unique("p");
    const { memories } = await remember(
      person,
      aboutThem(person, "Prefers mornings", {
        type: "preference",
        attribute: "preference",
        value: "mornings",
      }),
      aboutThem(person, "Leads sales", { attribute: "role", value: "sales" })
    );
    await remember(
      person,
      aboutThem(person, "Leads finance", {
        attribute: "role",
        value: "finance",
      })
    );
    await own(person).retireMemory({
      memory: memories[0] ?? "",
      reader: readerOf(person),
      writer: person,
      change: `forget:${memories[0]}`,
    });

    const statements = await statementsOf(person);
    expect(statements.toSorted()).toStrictEqual(["Leads finance"]);
  });

  // T5, T6: read only by its person, in their own store; nothing before
  // they have an own entity, nor once the store is erased whole.
  it("is read only by its person, in their own store", async () => {
    const person = unique("p");
    const never = await statementsOf(person);
    await remember(person, aboutThem(person, "Works in sales"));

    await expect(
      called(
        own(person).readProfile({
          reader: readerOf(unique("other")),
          budget: whole,
        })
      )
    ).rejects.toThrow(/answers only the person whose it is/u);
    await expect(
      called(shared().readProfile({ reader: readerOf(person), budget: whole }))
    ).rejects.toThrow(/only a person's own store takes this/u);
    await Promise.allSettled([
      called(own(person).erasePerson({ person, reason: "person_erased" })),
    ]);

    expect({ never, erased: await statementsOf(person) }).toStrictEqual({
      never: [],
      erased: [],
    });
  });
});
