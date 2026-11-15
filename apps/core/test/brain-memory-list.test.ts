import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { seedMemory } from "./knowledge-purge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The person's own memory records in today's Brain, as a signed-in person
// lists them through Knowledge's RPC: pages are bounded and the cursor is
// the person's own walk, which no one else can follow. Nothing in core
// remembers into it any more: the records are kept as its remember left
// them.

const idp = mockIdp();

/** Signing in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const key = () => `remember-${unique()}-${unique()}`;

describe("the Brain's memory records", setUpTime, () => {
  it("list the person's records a bounded page at a time, of one kind if asked", async () => {
    const person = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "user");
    const brain = person.api.knowledge;
    for (const [kind, text] of [
      ["fact", "One."],
      ["fact", "Two."],
      ["lesson", "Three."],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- in order, newest last
      await seedMemory(person, { kind, text }, { idempotencyKey: key() });
    }
    const first = await brain.memoriesList({ limit: 2 });
    const second =
      first.cursor === null
        ? undefined
        : await brain.memoriesList({ limit: 2, cursor: first.cursor });
    const facts = await brain.memoriesList({ kind: "fact" });
    expect({
      pages: [
        first.records.map(({ statement }) => statement),
        second?.records.map(({ statement }) => statement),
      ],
      last: second?.cursor,
      facts: facts.records.map(({ statement }) => statement),
      forged: await outcome(brain.memoriesList({ cursor: "not-ours" })),
      // A cursor is the person's own: no one else walks on from it.
      foreign: await outcome(
        other.api.knowledge.memoriesList({ cursor: first.cursor ?? "" })
      ),
      // Nor through another kind of record than it was written for.
      otherKind: await outcome(
        brain.memoriesList({ kind: "fact", cursor: first.cursor ?? "" })
      ),
      tooMany: await outcome(brain.memoriesList({ limit: 101 })),
    }).toStrictEqual({
      pages: [["Three.", "Two."], ["One."]],
      last: null,
      facts: ["Two.", "One."],
      forged: "brain.invalid",
      foreign: "brain.invalid",
      otherKind: "brain.invalid",
      tooMany: "brain.invalid",
    });
  });
});
