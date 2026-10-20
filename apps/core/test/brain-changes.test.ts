import type { BrainChange } from "@grasp-os/shared/brain";
import { brainChangesMaxLimit, brainErrors } from "@grasp-os/shared/brain";
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
  limit = brainChangesMaxLimit
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
    // The clock past its first save, so the moment comes after it.
    await scheduler.wait(5);
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

  it("record every document of a full page in the read's audit event, and go back 90 days at most", async () => {
    const admin = await signedInApi(idp, "admin");
    const since = justBefore();
    const { id } = await admin.api.knowledge.createCollection({
      name: `Many ${unique()}`,
      access: "everyone",
    });
    const saved = await Promise.all(
      Array.from(
        { length: brainChangesMaxLimit },
        async (_, index) =>
          await admin.api.knowledge.saveDocument({
            collectionId: id,
            path: `many-${index}.md`,
            text: `# Many ${index}`,
            ifVersion: 0,
          })
      )
    );
    const page = await admin.api.brain.changes({
      since,
      limit: brainChangesMaxLimit,
    });
    const shown = page.changes.flatMap((change) =>
      change.kind === "document" ? [change.document.id] : []
    );
    const events = await allEvents();
    const recorded = events.find(
      ({ action, actor, detail, provenance }) =>
        action === "knowledge.read" &&
        actor.type === "person" &&
        actor.userId === admin.userId &&
        detail.read === "changes" &&
        detail.count === brainChangesMaxLimit &&
        provenance.includes(saved[0]?.id ?? "")
    );
    // One of them last changed 100 days ago: past what the feed goes
    // back to, whatever moment is asked about.
    const old = saved[0]?.id ?? "";
    await env.KNOWLEDGE.prepare(
      "UPDATE documents SET updated_at = ? WHERE id = ?"
    )
      .bind(Date.now() - 100 * 24 * 60 * 60 * 1000, old)
      .run();
    const longAgo = await changesOf(
      admin,
      new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
    );

    expect({
      full: shown.length,
      recorded: shown.every((document) =>
        (recorded?.provenance ?? []).includes(document)
      ),
      collection: recorded?.provenance.includes(id),
      old: longAgo.some(
        (change) => change.kind === "document" && change.document.id === old
      ),
    }).toStrictEqual({
      full: brainChangesMaxLimit,
      recorded: true,
      collection: true,
      old: false,
    });
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
    const refusedFor = async (cursor: string) =>
      await admin.api.brain.changes({ since, cursor }).then(
        () => "listed",
        (error: unknown) => brainErrors.codeOf(error) ?? String(error)
      );
    const refused = {
      malformed: await refusedFor(btoa("not a cursor")),
      // Past the latest moment a date holds.
      outOfRange: await refusedFor(
        btoa(JSON.stringify([9_000_000_000_000_000, "document", "x"]))
      ),
    };

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
      refused: { malformed: "brain.invalid", outOfRange: "brain.invalid" },
    });
  });
});
