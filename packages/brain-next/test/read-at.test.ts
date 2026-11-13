import type { Access, NewSource } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

// When a producer read a source's text (`NewSource.readAt`): an add of a
// text read before the source's current version was writes nothing and
// answers `newer`, whatever order the adds arrive in; every other add is
// made as ever. Each case, through the store's own add: whether the
// current version says when it was read, whether the add does, and
// whether the add's read is earlier, the same, or later.

const store = () => env.BRAIN_STORE.getByName("brain");

const group = `team:${crypto.randomUUID()}`;
const access: Access = { kind: "audience", group };

/** The text a reader of `group` gets as `source`'s current version. */
const currentText = async (source: string): Promise<string | undefined> => {
  const [current] = await store().readCurrent({
    sources: [source],
    reader: { person: crypto.randomUUID(), groups: [group] },
  });
  return current?.text;
};

/** An add of `text` as change `change` of `source`, read at `readAt` if given. */
const adding = (
  source: string,
  change: string,
  text: string,
  readAt?: number
): NewSource => ({
  source,
  change,
  text,
  access,
  ...(readAt === undefined ? {} : { readAt }),
});

/**
 * A source whose current version was read at `currentAt` (or never said),
 * then an add read at `addAt` (or never said): what the add answers, and
 * the source's current text after it.
 */
const caseOf = async (currentAt?: number, addAt?: number) => {
  const source = `test:${crypto.randomUUID()}`;
  await store().addSource(adding(source, "1", "first read", currentAt));
  const added = await store().addSource(
    adding(source, "2", "second read", addAt)
  );
  return {
    version: added.version,
    newer: added.newer,
    current: await currentText(source),
  };
};

const kept = { version: 2, newer: undefined, current: "second read" };
const dropped = { version: 1, newer: true, current: "first read" };

describe("an add that says when its text was read", () => {
  it("is made as ever unless the current version was read later", async () => {
    const at = Date.now();
    await expect(
      Promise.all([
        caseOf(),
        caseOf(undefined, at),
        caseOf(at),
        caseOf(at, at - 1),
        caseOf(at, at),
        caseOf(at, at + 1),
      ])
    ).resolves.toStrictEqual([
      // Neither says: as ever.
      kept,
      // The current version never said: nothing to be newer than.
      kept,
      // The add never said: nothing to compare.
      kept,
      // Read before the current version was: nothing written.
      dropped,
      // Read at the same moment: made.
      kept,
      // Read later: made.
      kept,
    ]);
  });

  it("records nothing when it answers newer, so the same change tried again is judged afresh", async () => {
    const source = `test:${crypto.randomUUID()}`;
    const at = Date.now();
    await store().addSource(adding(source, "1", "read now", at));
    const first = await store().addSource(
      adding(source, "late", "read before", at - 1)
    );
    // The same change again, now said to be read after the current one.
    const again = await store().addSource(
      adding(source, "late", "read before", at + 1)
    );

    expect({
      first: first.newer,
      again: { version: again.version, newer: again.newer },
      current: await currentText(source),
    }).toStrictEqual({
      first: true,
      again: { version: 2, newer: undefined },
      current: "read before",
    });
  });
});
