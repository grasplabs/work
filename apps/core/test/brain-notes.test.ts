import type { BrainNote } from "@grasp-os/shared/brain";
import { brainErrors, brainNotesMaxLimit } from "@grasp-os/shared/brain";
import { identifierMaxLength } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Every note in the brain with its links (`brain.notes`, brain-notes.ts),
// as each person may read them. From its threat model: a note reaching
// someone who can't read it (a team's, someone's own); a link resolving to
// a document they can't read (an App's entry they can't open); paging that
// skips or repeats; a cursor that isn't core's.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** Every note `person` reads, page by page of `limit`. */
const notesOf = async (
  person: Person,
  limit = brainNotesMaxLimit
): Promise<BrainNote[]> => {
  const all: BrainNote[] = [];
  let cursor: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const page = await person.api.brain.notes({
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    all.push(...page.notes);
    if (page.next === null) {
      return all;
    }
    cursor = page.next;
  }
};

/** Of `notes`, those in `collections`, as `name/path`, each with its links as `path → name/path` or `path → none`. */
const shownIn = (
  notes: readonly BrainNote[],
  collections: Readonly<Record<string, string>>
): string[] => {
  const pathOf = new Map(notes.map((note) => [note.id, note.path]));
  return notes
    .flatMap((note) => {
      const name = Object.entries(collections).find(
        ([, id]) => id === note.collectionId
      )?.[0];
      if (name === undefined) {
        return [];
      }
      const linked = note.links.map(
        ({ path, documentId }) =>
          `${path} → ${documentId === null ? "none" : (pathOf.get(documentId) ?? "unlisted")}`
      );
      return [`${name}/${note.path} [${linked.join(", ")}]`];
    })
    .toSorted();
};

/** A collection's two notes: `note.md` links to itself and `other.md`, `other.md` back to it. */
const pair = (name: string): string[] => [
  `${name}/note.md [note.md → note.md, other.md → other.md]`,
  `${name}/other.md [note.md → note.md]`,
];

describe("the brain's notes", { timeout: 120_000 }, () => {
  it("show each person the notes they may read with their links, resolved only to what they may read", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const outsider = await signedInApi(idp, "user");
    const teamId = await newTeam(admin, [member]);
    const handbook = await collectionWithNote(admin.api, {
      name: `Handbook ${unique()}`,
      access: "everyone",
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
      handbook: handbook.collectionId,
      finance: finance.collectionId,
      diary: diary.collectionId,
    };
    const shown = async (person: Person) =>
      shownIn(await notesOf(person), collections);

    expect({
      member: await shown(member),
      outsider: await shown(outsider),
    }).toStrictEqual({
      member: [...pair("diary"), ...pair("finance"), ...pair("handbook")],
      outsider: pair("handbook"),
    });
    // Recorded as the Knowledge read it is, by whom.
    const events = await allEvents();
    expect(
      events.some(
        ({ action, actor, detail }) =>
          action === "knowledge.read" &&
          actor.type === "person" &&
          actor.userId === outsider.userId &&
          detail.read === "notes"
      )
    ).toBeTruthy();
  });

  it("leave a link to an App's entry the person can't open unresolved", async () => {
    const owner = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "builder");
    const hidden = await owner.api.apps.create({
      name: `Hidden ${unique()}`,
      description: "Not shared.",
    });
    await release(owner, hidden.id, { "AGENTS.md": "# Hidden\n" });
    const shared = await owner.api.apps.create({
      name: `Shared ${unique()}`,
      description: "Shared with the other builder.",
    });
    await release(owner, shared.id, {
      "AGENTS.md": `# Shared\nSee [[${hidden.id}/AGENTS.md]].\n`,
    });
    await owner.api.apps.members.add(shared.id, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const linksOf = async (person: Person) => {
      const notes = await notesOf(person);
      const entry = notes.find(({ path }) => path === `${shared.id}/AGENTS.md`);
      return entry?.links.map(({ path, documentId }) => [
        path,
        documentId === null ? "none" : "resolved",
      ]);
    };

    expect({
      owner: await linksOf(owner),
      other: await linksOf(other),
    }).toStrictEqual({
      owner: [[`${hidden.id}/AGENTS.md`, "resolved"]],
      other: [[`${hidden.id}/AGENTS.md`, "none"]],
    });
  });

  it("page through every note once, and refuse a cursor core didn't make", async () => {
    const admin = await signedInApi(idp, "admin");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Paged ${unique()}`,
      access: "everyone",
    });
    const ids = (notes: readonly BrainNote[]) =>
      notes.flatMap((note) =>
        note.collectionId === collectionId ? [note.id] : []
      );
    const byTwo = ids(await notesOf(admin, 2));
    // Not an ID: longer than any.
    const refused = await admin.api.brain
      .notes({ cursor: "x".repeat(identifierMaxLength + 1) })
      .then(
        () => "listed",
        (error: unknown) => brainErrors.codeOf(error) ?? String(error)
      );

    expect({
      byTwo: byTwo.length,
      once: new Set(byTwo).size,
      same: byTwo.toSorted(),
      refused,
    }).toStrictEqual({
      byTwo: 2,
      once: 2,
      same: ids(await notesOf(admin)).toSorted(),
      refused: "brain.invalid",
    });
  });
});
