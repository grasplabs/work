import {
  brainOf,
  listPageMax,
  questionMaxLength,
} from "@grasp-os/brain-next/contract";
import type { Reader } from "@grasp-os/brain-next/contract";
import { brainSearchBudget } from "@grasp-os/shared/brain-sources";
import { roleErrors } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import {
  addSource,
  eraseSource,
  recallAs,
  recallPassagesAs,
  rememberAs,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { soleReadersOf } from "./brain-next-sole-readers.ts";
import { mockIdp } from "./idp.ts";
import { openRpc, signedIn, signedInApi, staffPerson } from "./sign-in.ts";

type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

// The Brain's Sources page, through core's RPC (`session.brainSources`)
// into the Brain's store (GRA-1734): a person lists only the sources they
// may read, as an outsider, a team-mate and an admin, each counting only
// the versions they may read; reads a version only where they may, and
// gets the same for one they may not as for one there isn't; pages
// through what they may read only, what they may not taking no place in a
// page or in whether more follow; and searches with recall itself, the
// pack exactly what `recallAs` answers them. The permission harness
// (brain-next-surfaces.ts) probes the listings with markers.

const idp = mockIdp();

/** A word no other test's sources hold, without a digit. */
const word = (): string =>
  `w${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 10)}`;

const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

const teamOf = async (...members: string[]): Promise<string> => {
  const teamId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${teamId}`,
    organizationId,
    createdAt: new Date(),
  });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId,
      createdAt: new Date(),
    });
  }
  return teamId;
};

/** Adds `text` as a version of `source`, readable by `readers`. */
const add = async (
  source: SourceRef,
  text: string,
  readers: SourceReaders
): Promise<void> => {
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
};

/** Code unit order, as SQLite compares text. */
const byCodeUnits = (one: string, two: string): number => {
  if (one === two) {
    return 0;
  }
  return one < two ? -1 : 1;
};

const owner = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

/** What `api`'s person lists: each source's id, first line, version and count. */
const titlesOf = async (api: Api) => {
  const { sources } = await api.brainSources.list();
  return sources.map(({ source, firstLine, personal, version, versions }) => ({
    id: source.id,
    firstLine,
    personal,
    version,
    versions,
  }));
};

/** The versions of `source` `api`'s person lists. */
const versionsOf = async (api: Api, source: SourceRef) => {
  const { versions } = await api.brainSources.versions(source);
  return versions.map(({ version }) => version);
};

/** The ids of `listed`, sorted. */
const idsOf = (listed: readonly { source: { id: string } }[]): string[] =>
  listed.map(({ source }) => source.id).toSorted(byCodeUnits);

describe("the Brain's sources, as a person reads them", () => {
  it("lists only what each person may read, counts only the versions they may read, and reads a hidden version as one there isn't", async () => {
    const [writer, mate, outsider, admin, newcomer] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const team = await teamOf(writer.userId, mate.userId);
    const own = newSource();
    const shared = newSource();
    const nobody = newSource();
    await add(own, `Salary review\n${word()}`, owner(writer.userId));
    // Its first version is the writer's alone, a team of theirs, as a
    // source keeps its kind of readers (one person's own is in their own
    // store); its second the team's.
    await add(
      shared,
      `Draft minutes ${word()}`,
      await soleReadersOf(writer.userId)
    );
    const sharedText = `\n  Board minutes  \n${word()}`;
    await add(shared, sharedText, {
      kind: "team",
      teamId: team,
    });
    await add(nobody, `Unclaimed ${word()}`, { kind: "none" });

    const [
      writerSees,
      mateSees,
      outsiderSees,
      adminSees,
      newcomerSees,
      mateVersions,
      writerVersions,
      adminVersions,
      noVersions,
      reads,
    ] = await Promise.all([
      titlesOf(writer.api),
      titlesOf(mate.api),
      titlesOf(outsider.api),
      titlesOf(admin.api),
      titlesOf(newcomer.api),
      versionsOf(mate.api, shared),
      versionsOf(writer.api, shared),
      Promise.all(
        [own, shared, nobody].map(
          async (source) => await admin.api.brainSources.versions(source)
        )
      ),
      newcomer.api.brainSources.versions(newSource()),
      Promise.all([
        mate.api.brainSources.read(shared, 2),
        mate.api.brainSources.read(shared, 1),
        outsider.api.brainSources.read(shared, 2),
        outsider.api.brainSources.read(newSource(), 1),
      ]),
    ]);

    expect({
      writerSees,
      // The team-mate was never among the first version's readers.
      mateSees,
      mateVersions,
      writerVersions,
      // An outsider and an admin get what someone with nothing gets.
      outsiderSees,
      adminSees,
      // A version is read whole where it may be, and as missing where not.
      reads: reads.map((read) => read?.text ?? null),
    }).toStrictEqual({
      writerSees: [
        {
          id: shared.id,
          firstLine: "Board minutes",
          personal: false,
          version: 2,
          versions: 2,
        },
        // The writer's alone: marked so, to them and to nobody else.
        {
          id: own.id,
          firstLine: "Salary review",
          personal: true,
          version: 1,
          versions: 1,
        },
      ],
      mateSees: [
        {
          id: shared.id,
          firstLine: "Board minutes",
          personal: false,
          version: 2,
          versions: 1,
        },
      ],
      mateVersions: [2],
      writerVersions: [2, 1],
      outsiderSees: newcomerSees,
      adminSees: newcomerSees,
      reads: [sharedText, null, null, null],
    });
    expect({ newcomerSees, adminVersions }).toStrictEqual({
      newcomerSees: [],
      adminVersions: [noVersions, noVersions, noVersions],
    });
  });

  it("searches with recall of passages itself: the same pack it gives that person, cut short or not, and no memory", async () => {
    const [reader, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const asked = word();
    const missing = word();
    // More of what the reader may read than the budget holds (dates and
    // amounts count a token a character or so), so the pack is cut short;
    // and the same word where they may not.
    const long = `${asked} paid 2026-05-01, 1.250,00\n`.repeat(60);
    for (let index = 0; index < 5; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await add(newSource(), long, owner(reader.userId));
    }
    await add(newSource(), `${asked} hidden`, owner(other.userId));
    // A memory of theirs the question's word finds: the page shows none,
    // so none is sent.
    const remembered = `${asked} remembered note`;
    await rememberAs(env, reader.userId, {
      change: crypto.randomUUID(),
      about: { kind: "customer", names: [`Depot ${word()}`] },
      type: "fact",
      statement: remembered,
      quote: remembered,
    });

    const questions = [asked, `${asked} ${missing}`, `"${missing}"`];
    const searched = await Promise.all(
      questions.map(
        async (question) => await reader.api.brainSources.search(question)
      )
    );
    const recalled = await Promise.all(
      questions.map(
        async (question) =>
          await recallPassagesAs(env, reader.userId, {
            question,
            budget: { tokens: brainSearchBudget },
            personal: true,
          })
      )
    );

    expect(searched).toStrictEqual(recalled);
    expect({
      fields: searched.map((pack) => Object.keys(pack).toSorted()),
      memory: JSON.stringify(searched).includes(remembered),
    }).toStrictEqual({
      fields: questions.map(() => ["items", "notFound", "truncated"]),
      memory: false,
    });
    expect(
      searched.map(({ items, notFound, truncated }) => ({
        found: items.length > 0,
        notFound,
        truncated,
      }))
    ).toStrictEqual([
      { found: true, notFound: [], truncated: true },
      { found: true, notFound: [missing], truncated: true },
      { found: false, notFound: [missing, missing], truncated: false },
    ]);
  });

  it("refuses a question longer than the Brain takes, as recall does for every caller", async () => {
    const { api, userId } = await signedInApi(idp, "user");
    const tooLong = "a".repeat(questionMaxLength + 1);
    await expect(api.brainSources.search(tooLong)).rejects.toThrow(
      "Something went wrong."
    );
    // Core's own refusal, not the store's ("The Brain refused it"): the
    // question is checked before anything of it reaches the embedder.
    await expect(
      recallAs(env, userId, {
        question: tooLong,
        budget: { tokens: brainSearchBudget },
        personal: true,
      })
    ).rejects.toThrow(/^Refused: /u);
  });

  it("reads a null page start as none, and refuses one that names no page", async () => {
    const reader = await signedInApi(idp, "user");
    await add(newSource(), `${word()} kept`, owner(reader.userId));
    const first = await reader.api.brainSources.list();

    await expect(reader.api.brainSources.list(null)).resolves.toStrictEqual(
      first
    );
    await expect(
      reader.api.brainSources.list({
        addedAt: "not a time",
        source: { producer: "upload", id: crypto.randomUUID() },
      })
    ).rejects.toThrow("Something went wrong.");
  });

  it("refuses a Grasp staff session", async () => {
    const staff = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    await expect(staff.core.authenticate().brainSources.list()).rejects.toThrow(
      roleErrors.create("role.forbidden").message
    );
  });

  it("pages through what the person may read alone, newest first, and lists nothing erased", async () => {
    const [reader, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    // A page and one more of the reader's, with someone else's before
    // and after them.
    await add(newSource(), "Hidden first", owner(other.userId));
    const readable: SourceRef[] = [];
    for (let index = 0; index <= listPageMax; index += 1) {
      const source = newSource();
      readable.push(source);
      // oxlint-disable-next-line no-await-in-loop -- in order of adding
      await add(source, `Note ${index}`, owner(reader.userId));
    }
    await add(newSource(), "Hidden last", owner(other.userId));

    const first = await reader.api.brainSources.list();
    const second = await reader.api.brainSources.list(first.next ?? undefined);
    const listed = [...first.sources, ...second.sources];
    // Newest first, then by key, as the store orders them.
    const order = listed.map(({ addedAt, source }) => ({
      addedAt,
      key: `upload:${source.id}`,
    }));
    const [erased, ...kept] = readable;
    if (erased === undefined) {
      throw new Error("No source was added");
    }
    await eraseSource(env, {
      source: erased,
      readers: owner(reader.userId),
      reason: "deleted",
    });
    const again = await reader.api.brainSources.list();

    expect({
      pages: [first.sources.length, second.sources.length],
      next: [first.next === null, second.next, again.next],
      listed: idsOf(listed),
      order,
      again: idsOf(again.sources),
    }).toStrictEqual({
      pages: [listPageMax, 1],
      next: [false, null, null],
      listed: idsOf(readable.map((source) => ({ source }))),
      order: order.toSorted((one, two) =>
        one.addedAt === two.addedAt
          ? byCodeUnits(two.key, one.key)
          : byCodeUnits(two.addedAt, one.addedAt)
      ),
      again: idsOf(kept.map((source) => ({ source }))),
    });
  });

  it("pages at the store with the reader's sets in the statement: a hidden source never takes a place or says more follow", async () => {
    const store = brainOf(inJurisdiction(env, env.BRAIN_STORE));
    const tag = word();
    const prefix = `upload:${tag}-`;
    const reader: Reader = { person: `p-${tag}`, groups: [`team:${tag}`] };
    const keys: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const key = `${prefix}${index}`;
      keys.push(key);
      // oxlint-disable-next-line no-await-in-loop -- in order of adding
      await store.addSource({
        source: key,
        change: crypto.randomUUID(),
        text: `Readable ${index}`,
        access: { kind: "audience", group: `team:${tag}` },
      });
      // oxlint-disable-next-line no-await-in-loop -- in order of adding
      await store.addSource({
        source: `${prefix}hidden-${index}`,
        change: crypto.randomUUID(),
        text: `Hidden ${index}`,
        access: { kind: "owner", person: `someone-${tag}` },
      });
    }
    const pages = [];
    let page = await store.listSources({
      reader,
      prefixes: [prefix],
      limit: 2,
    });
    pages.push(page);
    while (page.more) {
      const last = page.sources.at(-1);
      if (last === undefined) {
        throw new Error("A page that says more follow holds nothing");
      }
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      page = await store.listSources({
        reader,
        prefixes: [prefix],
        limit: 2,
        after: { addedAt: last.addedAt, source: last.source },
      });
      pages.push(page);
    }
    expect(
      pages.map(({ sources, more }) => ({
        count: sources.length,
        more,
      }))
    ).toStrictEqual([
      { count: 2, more: true },
      { count: 1, more: false },
    ]);
    expect(
      pages
        .flatMap(({ sources }) => sources.map(({ source }) => source))
        .toSorted(byCodeUnits)
    ).toStrictEqual(keys);
  });
});
