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
): Promise<{ statements: string[]; truncated: boolean }> => {
  const { memories, truncated }: Profile = await own(person).readProfile({
    reader: readerOf(person),
    budget,
  });
  return { statements: memories.map(({ statement }) => statement), truncated };
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

    await expect(statementsOf(person)).resolves.toStrictEqual({
      statements: ["Prefers short answers"],
      truncated: false,
    });
  });

  // AC 3: within its budget, whole memories, in the store's order, cut at the first that doesn't fit.
  it("stays within its budget, the same memories in the same order every time", async () => {
    const person = unique("p");
    await remember(
      person,
      aboutThem(person, "Leads the Rotterdam depot", {
        attribute: "role",
        value: "depot lead",
      }),
      aboutThem(person, "Prefers answers in Dutch", {
        type: "preference",
        attribute: "preference",
        value: "Dutch",
      }),
      aboutThem(person, "Works on the warehouse move this quarter")
    );
    const all = await own(person).readProfile({
      reader: readerOf(person),
      budget: whole,
    });
    const [first] = all.memories;
    const firstTokens =
      first === undefined
        ? 0
        : packMemoryTokens({
            ...first,
            memory: first.id,
            context: null,
            confirmed: false,
            found: "entities",
          });
    const again = await statementsOf(person);
    const cut = await statementsOf(person, { tokens: firstTokens });

    expect({
      count: all.memories.length,
      again: again.statements,
      cut,
    }).toStrictEqual({
      count: 3,
      again: all.memories.map(({ statement }) => statement),
      cut: { statements: [first?.statement], truncated: true },
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

    const { statements } = await statementsOf(person);
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
      never: { statements: [], truncated: false },
      erased: { statements: [], truncated: false },
    });
  });
});
