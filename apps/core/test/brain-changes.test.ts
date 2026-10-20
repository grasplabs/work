import type { BrainChange } from "@grasp-os/shared/brain";
import { brainErrors } from "@grasp-os/shared/brain";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// What changed in the brain since a moment (`brain.changes`,
// brain-changes.ts), as each person may read it. From its threat model:
// a document's existence or title reaching someone who can't read it (a
// team's, someone's own: the admins' collections, which only the platform
// makes, go by the same condition, knowledge-admins-access.test.ts); paging that skips, repeats or
// shows what the person can't read; a cursor that isn't core's. The
// onboarding's sources are in brain.test.ts.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A moment just before now: what is saved from here on is a change. */
const justBefore = (): string => new Date(Date.now() - 1).toISOString();

/** Every document change `person` reads since `since`, page by page of `limit`. */
const changesOf = async (
  person: Person,
  since: string,
  limit = 100
): Promise<BrainChange[]> => {
  const all: BrainChange[] = [];
  let cursor: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const page = await person.api.brain.changes({
      since,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    all.push(...page.changes);
    if (page.next === null) {
      return all;
    }
    cursor = page.next;
  }
};

/** Of `changes`, the documents of `collections`: their collection's name, path and change. */
const documentsIn = (
  changes: readonly BrainChange[],
  collections: Readonly<Record<string, string>>
): string[] =>
  changes
    .flatMap((change) => {
      if (change.kind !== "document") {
        return [];
      }
      const name = Object.entries(collections).find(
        ([, id]) => id === change.document.collectionId
      )?.[0];
      return name === undefined
        ? []
        : [`${name}/${change.document.path} ${change.change}`];
    })
    .toSorted();

describe("the brain's changes", { timeout: 120_000 }, () => {
  it("show each person only the documents they may read, added or changed since the moment asked about", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const outsider = await signedInApi(idp, "user");
    const teamId = await newTeam(admin, [member]);
    // A document from before the moment, changed after it.
    const handbook = await admin.api.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    await admin.api.knowledge.saveDocument({
      collectionId: handbook.id,
      path: "rules.md",
      text: "# Rules\nBe kind.",
      ifVersion: 0,
    });
    const since = justBefore();
    await admin.api.knowledge.saveDocument({
      collectionId: handbook.id,
      path: "rules.md",
      text: "# Rules\nBe kind and quick.",
      ifVersion: 1,
    });
    const finance = await collectionWithNote(admin.api, {
      name: `Finance ${unique()}`,
      access: "teams",
      teams: [teamId],
    });
    const diary = await collectionWithNote(member.api, {
      name: `Diary ${unique()}`,
      access: "me",
    });
    const collections = {
      handbook: handbook.id,
      finance: finance.collectionId,
      diary: diary.collectionId,
    };
    const team = ["finance/note.md added", "finance/other.md added"];
    const shown = async (person: Person, from = since) =>
      documentsIn(await changesOf(person, from), collections);

    expect({
      admin: await shown(admin),
      member: await shown(member),
      outsider: await shown(outsider),
      // Nothing changed after now.
      later: await shown(admin, new Date(Date.now() + 60_000).toISOString()),
    }).toStrictEqual({
      // The team's collection is its owner's too; someone's own is theirs.
      admin: [...team, "handbook/rules.md changed"],
      member: [
        "diary/note.md added",
        "diary/other.md added",
        ...team,
        "handbook/rules.md changed",
      ],
      outsider: ["handbook/rules.md changed"],
      later: [],
    });
    // Recorded as the Knowledge read it is, by whom.
    const events = await allEvents();
    expect(
      events.some(
        ({ action, actor, detail }) =>
          action === "knowledge.read" &&
          actor.type === "person" &&
          actor.userId === outsider.userId &&
          detail.read === "changes"
      )
    ).toBeTruthy();
  });

  it("page through every change once, newest first, and refuse a cursor core didn't make", async () => {
    const admin = await signedInApi(idp, "admin");
    const since = justBefore();
    const { id } = await admin.api.knowledge.createCollection({
      name: `Notes ${unique()}`,
      access: "everyone",
    });
    for (const index of [1, 2, 3, 4, 5]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, in order
      await admin.api.knowledge.saveDocument({
        collectionId: id,
        path: `note-${index}.md`,
        text: `# Note ${index}`,
        ifVersion: 0,
      });
    }
    const paths = (changes: readonly BrainChange[]) =>
      changes.flatMap((change) =>
        change.kind === "document" && change.document.collectionId === id
          ? [change.document.path]
          : []
      );
    const refused = await admin.api.brain
      .changes({ since, cursor: btoa("not a cursor") })
      .then(
        () => "listed",
        (error: unknown) => brainErrors.codeOf(error) ?? String(error)
      );

    const newestFirst = paths(await changesOf(admin, since, 2));
    // Changed at the same moment, as saves in one millisecond are: a page
    // ends between two of them, and the next goes on from there.
    await env.KNOWLEDGE.prepare(
      "UPDATE documents SET updated_at = ? WHERE collection_id = ?"
    )
      .bind(Date.now(), id)
      .run();
    const atOnce = paths(await changesOf(admin, since, 2));

    expect({
      newestFirst,
      atOnce: atOnce.toSorted(),
      onePage: paths(await changesOf(admin, since)),
      refused,
    }).toStrictEqual({
      newestFirst: [
        "note-5.md",
        "note-4.md",
        "note-3.md",
        "note-2.md",
        "note-1.md",
      ],
      // Each once, by two or all at once.
      atOnce: ["note-1.md", "note-2.md", "note-3.md", "note-4.md", "note-5.md"],
      onePage: atOnce,
      refused: "brain.invalid",
    });
  });
});
