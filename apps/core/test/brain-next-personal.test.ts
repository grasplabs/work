import {
  brainOf,
  listPageMax,
  personalBrainOf,
  recallBudgetMax,
} from "@grasp-os/brain-next/contract";
import type { Reader } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import {
  addInstructionFile,
  addSource,
  eraseSource,
  erasePerson,
  listSourcesAs,
  listVersionsAs,
  readInstructionFilesAs,
  readSourceVersionAs,
  recallAs,
} from "../src/brain-next.ts";
import type {
  InstructionFile,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { ageOwnErasure, breakOwnStore } from "./brain-next-own-store.ts";
import { holdNextBucketPut, ledgerOf } from "./brain-next-traces.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// A person's own store (GRA-1762), as core reaches it: what only one
// person may read is kept in their own store, the rest in the shared one;
// their own recall and reads ask both, any other only the shared one and
// their own; erasing them erases both, and is pending while their store
// is still deleting. From the threat model on the issue: no one else's
// call, nor an App's recall, ever addresses a person's own store, and a
// store that can't finish its erasure keeps the caller's erasure pending.
// The leak harness (brain-next-leaks.test.ts) probes every surface.

const idp = mockIdp();

/** The Brain's namespace, as core reaches it. */
const namespace = () => inJurisdiction(env, env.BRAIN_STORE);

/** The shared store, by its contract. */
const shared = () => brainOf(namespace());

/** `personId`'s own store, by its contract. */
const own = (personId: string) => personalBrainOf(namespace(), personId);

/** A word nothing else holds. */
const markerWord = (): string => `m${crypto.randomUUID().replaceAll("-", "")}`;

/** A member of the organization, signed in. */
const member = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

/** A team of the organization with `members`. */
const teamOf = async (...members: string[]): Promise<string> => {
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId: id,
      userId,
      createdAt: new Date(),
    });
  }
  return id;
};

/** A source of its own, as an upload names it. */
const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

/** The store's key for `source`, as core names it. */
const keyOf = ({ producer, id }: SourceRef): string => `${producer}:${id}`;

/** Adds `text` as a version of `source` through core. */
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

/**
 * Core's env with the store named `name` failing its `method` on the
 * calls numbered in `failing` (from 1), as a store out of reach would:
 * every other call reaches the store itself. A failing call fails only
 * once a shared store's erasure started beside it has landed, so what
 * runs beside a failure is seen, with no clock to wait on.
 */
const envFailing = (
  name: string,
  method: string,
  failing: readonly number[]
): Env => {
  let calls = 0;
  /** The shared store's erasure under way, if one is. */
  let sharedErasing: Promise<unknown> | undefined;
  const binding = env.BRAIN_STORE;
  const getByName = (named: string) => {
    const stub = binding.getByName(named);
    if (named !== name && named !== "brain") {
      return stub;
    }
    return new Proxy(stub, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        // Called through, never bound: an RPC stub takes `bind` for a
        // method of the store.
        const through = async (args: unknown[]): Promise<unknown> => {
          const answered: unknown = await Reflect.apply(value, target, args);
          return answered;
        };
        if (named === "brain" && property === "eraseSource") {
          return async (...args: unknown[]) => {
            const erasing = through(args);
            sharedErasing = erasing.catch(() => "failed");
            return await erasing;
          };
        }
        if (named !== name || property !== method) {
          return async (...args: unknown[]) => await through(args);
        }
        return async (...args: unknown[]) => {
          calls += 1;
          if (failing.includes(calls)) {
            // Anything started beside this call has been called by now.
            await Promise.resolve();
            await sharedErasing;
            throw new Error("Out of reach, for the test");
          }
          return await through(args);
        };
      },
    });
  };
  return {
    ...env,
    BRAIN_STORE: new Proxy(binding, {
      get: (target, property): unknown =>
        property === "getByName" ? getByName : Reflect.get(target, property),
    }),
  };
};

/** Adds `text` to `source` for `readers` through core with `withEnv`. */
const addWith = async (
  withEnv: Env,
  source: SourceRef,
  text: string,
  readers: SourceReaders
): Promise<void> => {
  await addSource(withEnv, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
};

/** What `personId` recalls for `question` through core: each chunk's text. */
const textsFor = async (
  personId: string,
  question: string,
  personal: boolean
): Promise<string[]> => {
  const { items } = await recallAs(env, personId, {
    question,
    budget: { tokens: recallBudgetMax },
    personal,
  });
  return items.map(({ text }) => text);
};

/** The text of `wanted` as `personId` reads it through core: null if not. */
const historyAs = async (
  personId: string,
  wanted: { source: SourceRef; version: number }
): Promise<string | null> => {
  const read = await readSourceVersionAs(env, personId, wanted);
  return read?.text ?? null;
};

/** What `promise` was refused with, or `answered`. */
const outcomeOf = async (promise: Promise<unknown>): Promise<string> =>
  await promise.then(() => "answered", String);

/**
 * The names of the Brain's stores core addressed while `run` ran, and
 * what it returned: through the binding itself.
 */
const addressedBy = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; names: string[] }> => {
  const binding = env.BRAIN_STORE;
  const byName = vi.spyOn(binding, "getByName");
  const idsByName = vi.spyOn(binding, "idFromName");
  const byId = vi.spyOn(binding, "get");
  try {
    const value = await run();
    return {
      value,
      names: [
        ...byName.mock.calls.map(([name]) => name),
        ...idsByName.mock.calls.map(([name]) => name),
        ...byId.mock.calls.map(([id]) => id.name ?? `id:${String(id)}`),
      ],
    };
  } finally {
    byName.mockRestore();
    idsByName.mockRestore();
    byId.mockRestore();
  }
};

/** R2's calls by name, as the store makes them. */
const r2Calls = ["get", "head", "put", "delete", "list"] as const;

/**
 * Makes `personId`'s own store's bucket fail `failing` (R2's calls by
 * name) until `heal` is called.
 */
const breakBucketOf = async (
  personId: string,
  failing: readonly string[]
): Promise<{ heal: () => Promise<void> }> => {
  const stub = namespace().getByName(`person:${personId}`);
  const bucket = env.BRAIN_OBJECTS;
  const swap = async (to: unknown): Promise<void> => {
    await runInDurableObject(stub, (instance) => {
      const objectEnv: unknown = Reflect.get(instance, "env");
      if (typeof objectEnv !== "object" || objectEnv === null) {
        throw new TypeError("The store has no env");
      }
      Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: to });
    });
  };
  await swap(
    Object.fromEntries(
      r2Calls.map((name) => [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          if (failing.includes(name)) {
            throw new Error("Broken by the test");
          }
          const method: unknown = Reflect.get(bucket, name);
          if (typeof method !== "function") {
            throw new TypeError(`R2 has no ${name}`);
          }
          const result: unknown = await Reflect.apply(method, bucket, args);
          return result;
        },
      ])
    )
  );
  return {
    heal: async () => {
      await swap(bucket);
    },
  };
};

describe("what one person alone may read, in their own store", () => {
  it("is kept in their own store, and what a team or nobody may read in the shared one", async () => {
    const person = await member();
    const team = await teamOf(person);
    const theirs = newSource();
    const teamsNote = newSource();
    await add(theirs, "Their own note", { kind: "owner", personId: person });
    await add(teamsNote, "The team's note", { kind: "team", teamId: team });
    const reader: Reader = { person, groups: [`team:${team}`] };
    const sources = [keyOf(theirs), keyOf(teamsNote)];

    const [inOwn, inShared] = await Promise.all([
      own(person).readCurrent({ sources, reader }),
      shared().readCurrent({ sources, reader }),
    ]);

    expect({
      inOwn: inOwn.map(({ text }) => text),
      inShared: inShared.map(({ text }) => text),
    }).toStrictEqual({
      inOwn: ["Their own note"],
      inShared: ["The team's note"],
    });
  });

  it("is recalled with what is shared only in their own recall, and no one else's recall or an App's addresses their store", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    const word = markerWord();
    await add(newSource(), `Their own ${word}`, {
      kind: "owner",
      personId: person,
    });
    await add(newSource(), `The team's ${word} and more`, {
      kind: "team",
      teamId: team,
    });
    const theirStore = `person:${person}`;

    const theirOwn = await addressedBy(
      async () => await textsFor(person, word, true)
    );
    const asApp = await addressedBy(
      async () => await textsFor(person, word, false)
    );
    const colleagues = await addressedBy(
      async () => await textsFor(colleague, word, true)
    );

    expect({
      own: theirOwn.value,
      ownAddressed: theirOwn.names.includes(theirStore),
      asApp: asApp.value,
      asAppAddressed: asApp.names.includes(theirStore),
      colleagues: colleagues.value,
      colleaguesAddressed: colleagues.names.includes(theirStore),
    }).toStrictEqual({
      own: [`Their own ${word}`, `The team's ${word} and more`],
      ownAddressed: true,
      asApp: [`The team's ${word} and more`],
      asAppAddressed: false,
      colleagues: [`The team's ${word} and more`],
      colleaguesAddressed: false,
    });
  });

  it("is read as history, and their instruction file loaded, by them alone, without anyone else's read addressing their store", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const source = newSource();
    await add(source, "Their own draft", { kind: "owner", personId: person });
    const file: InstructionFile = { scope: "person", personId: person };
    const company: InstructionFile = { scope: "company", name: "facts" };
    await addInstructionFile(env, {
      file,
      change: crypto.randomUUID(),
      text: "Call me by my first name",
    });
    await addInstructionFile(env, {
      file: company,
      change: crypto.randomUUID(),
      text: "We sell bicycles",
    });
    const theirStore = `person:${person}`;
    const wanted = { source, version: 1 };

    const read = await readSourceVersionAs(env, person, wanted);
    const files = await readInstructionFilesAs(env, { userId: person }, [
      company,
      file,
    ]);
    const othersRead = await addressedBy(
      async () => await readSourceVersionAs(env, colleague, wanted)
    );
    const othersFiles = await addressedBy(
      async () =>
        await readInstructionFilesAs(env, { userId: colleague }, [
          company,
          file,
        ])
    );

    expect({
      read: read?.text,
      files: files.map(({ file: which, text }) => [which.scope, text]),
      othersRead: othersRead.value,
      othersFiles: othersFiles.value.map(({ file: which }) => which.scope),
      addressed: [...othersRead.names, ...othersFiles.names].includes(
        theirStore
      ),
    }).toStrictEqual({
      read: "Their own draft",
      files: [
        ["company", "We sell bicycles"],
        ["person", "Call me by my first name"],
      ],
      othersRead: null,
      othersFiles: ["company"],
      addressed: false,
    });
  });

  it("is closed in the shared store, which staff read, only once their own store's erasure returned", async () => {
    const person = await member();
    const word = markerWord();
    const source = newSource();
    const readers: SourceReaders = { kind: "owner", personId: person };
    await add(source, `Their own ${word}`, readers);
    const key = keyOf(source);
    // Their own store's erasure fails once, as a store out of reach.
    const failing = envFailing(`person:${person}`, "eraseSource", [1]);

    const first = await outcomeOf(
      eraseSource(failing, { source, readers, reason: "deleted" })
    );
    const sharedMeanwhile = await ledgerOf(key);
    const foundMeanwhile = await textsFor(person, word, true);
    await eraseSource(failing, { source, readers, reason: "deleted" });

    const sharedAfter = await ledgerOf(key);

    expect({
      first,
      sharedMeanwhile,
      foundMeanwhile,
      shared: sharedAfter.length,
      found: await textsFor(person, word, true),
    }).toStrictEqual({
      first: "Error: Out of reach, for the test",
      // Not erased in the shared ledger while their copy is still found.
      sharedMeanwhile: [],
      foundMeanwhile: [`Their own ${word}`],
      shared: 1,
      found: [],
    });
  });

  it("is erased in their own store by the readers its producer names, and its key closed", async () => {
    const person = await member();
    const word = markerWord();
    const source = newSource();
    const readers: SourceReaders = { kind: "owner", personId: person };
    await add(source, `Their own ${word}`, readers);

    await eraseSource(env, { source, readers, reason: "deleted" });

    expect({
      found: await textsFor(person, word, true),
      read: await readSourceVersionAs(env, person, { source, version: 1 }),
      readdedRefused: await add(source, `Back ${word}`, readers).then(
        () => false,
        () => true
      ),
    }).toStrictEqual({ found: [], read: null, readdedRefused: true });
  });
});

describe("listing a person's sources", () => {
  it("lists their own beside the team's, newest first, a page at a time across both stores, and none of theirs to anyone else", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    // More than a page, the person's own and the team's taking turns.
    const added: { source: SourceRef; theirs: boolean }[] = [];
    for (let index = 0; index <= listPageMax; index += 1) {
      const theirs = index % 2 === 0;
      const source = newSource();
      added.push({ source, theirs });
      // oxlint-disable-next-line no-await-in-loop -- in order of adding
      await add(
        source,
        `Note ${index}`,
        theirs
          ? { kind: "owner", personId: person }
          : { kind: "team", teamId: team }
      );
      // oxlint-disable-next-line no-await-in-loop -- a time of its own each
      await scheduler.wait(2);
    }
    const ownSource = added[0]?.source ?? newSource();

    const first = await listSourcesAs(env, person, {});
    const second = await listSourcesAs(env, person, {
      after: first.next ?? undefined,
    });
    const colleagues = await addressedBy(
      async () => await listSourcesAs(env, colleague, {})
    );
    const ownVersions = await listVersionsAs(env, person, {
      source: ownSource,
    });
    const listedIds = [...first.sources, ...second.sources].map(
      ({ source }) => source.id
    );

    expect({
      pages: [first.sources.length, second.sources.length],
      last: second.next,
      listed: listedIds,
      personal: [...first.sources, ...second.sources]
        .filter(({ personal }) => personal)
        .map(({ source }) => source.id)
        .toSorted(),
      versions: ownVersions.versions.length,
      colleague: colleagues.value.sources
        .map(({ source }) => source.id)
        .toSorted(),
      colleagueAddressed: colleagues.names.includes(`person:${person}`),
    }).toStrictEqual({
      pages: [listPageMax, 1],
      last: null,
      listed: added.map(({ source }) => source.id).toReversed(),
      personal: added
        .filter(({ theirs }) => theirs)
        .map(({ source }) => source.id)
        .toSorted(),
      versions: 1,
      colleague: added
        .filter(({ theirs }) => !theirs)
        .map(({ source }) => source.id)
        .toSorted(),
      colleagueAddressed: false,
    });
  });
});

describe("a source whose readers would change kind", () => {
  it("is refused when a shared source would become one person's own, and keeps nothing of it", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    const word = markerWord();
    const source = newSource();
    await add(source, `The team's draft ${word}`, {
      kind: "team",
      teamId: team,
    });

    const narrowing = await outcomeOf(
      add(source, `Theirs alone ${word}`, { kind: "owner", personId: person })
    );
    const theirsAlone = await own(person).readCurrent({
      sources: [keyOf(source)],
      reader: { person, groups: [] },
    });

    expect({
      narrowing: narrowing.includes("keeps the readers it was first added for"),
      namesTheKey: narrowing.includes(source.id),
      colleague: await textsFor(colleague, word, true),
      person: await textsFor(person, word, true),
      theirsAlone,
    }).toStrictEqual({
      narrowing: true,
      namesTheKey: false,
      colleague: [`The team's draft ${word}`],
      person: [`The team's draft ${word}`],
      theirsAlone: [],
    });
  });

  it("fails, not refused, when the shared store can't be asked after it landed, leaving a copy only they can read", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    const word = markerWord();
    const source = newSource();
    const theirs: SourceReaders = { kind: "owner", personId: person };
    const text = `Theirs alone ${word}`;
    // The shared store answers the first ask and not the second.
    const failing = envFailing("brain", "keyState", [2]);
    const gate = await holdNextBucketPut(`person:${person}`);
    const adding = outcomeOf(addWith(failing, source, text, theirs));
    await vi.waitFor(
      () => {
        expect(gate.reached).toBeTruthy();
      },
      { timeout: 10_000 }
    );
    await add(source, `The team's ${word}`, { kind: "team", teamId: team });
    gate.released = true;
    const first = await adding;

    // The retry is refused at the first ask, and erases nothing.
    const retry = await outcomeOf(add(source, text, theirs));
    const colleagues = await listSourcesAs(env, colleague, {});
    const theirsFound = await textsFor(person, word, true);

    expect({
      first,
      retry: retry.includes("keeps the readers it was first added for"),
      colleague: await textsFor(colleague, word, true),
      colleagueListed: colleagues.sources
        .filter(({ source: listed }) => listed.id === source.id)
        .map(({ personal }) => personal),
      colleagueRead: await historyAs(colleague, { source, version: 1 }),
      // What is left is theirs alone, and goes with their erasure.
      theirs: theirsFound.toSorted(),
    }).toStrictEqual({
      first: "Error: Out of reach, for the test",
      retry: true,
      colleague: [`The team's ${word}`],
      colleagueListed: [false],
      colleagueRead: `The team's ${word}`,
      theirs: [`The team's ${word}`, text].toSorted(),
    });
  });

  it("is refused without erasing an earlier version of theirs, when the shared store holds the key", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    const word = markerWord();
    const source = newSource();
    const theirs: SourceReaders = { kind: "owner", personId: person };
    // Theirs, then the team's (a producer's mistake): a real version of
    // theirs under a key the shared store holds.
    await add(source, `Theirs alone ${word}`, theirs);
    await add(source, `The team's ${word}`, { kind: "team", teamId: team });

    const later = await outcomeOf(add(source, `Theirs again ${word}`, theirs));
    const theirsKept = await own(person).readCurrent({
      sources: [keyOf(source)],
      reader: { person, groups: [] },
    });

    expect({
      later: later.includes("keeps the readers it was first added for"),
      theirsKept: theirsKept.map(({ text }) => text),
      colleague: await textsFor(colleague, word, true),
    }).toStrictEqual({
      later: true,
      theirsKept: [`Theirs alone ${word}`],
      colleague: [`The team's ${word}`],
    });
  });

  it("is refused, and kept nowhere of theirs, when a team's add of the same new key lands while it is being added", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    const word = markerWord();
    const source = newSource();
    // Theirs past the shared store's first answer and writing its file in
    // their own store, as the team's lands in the shared one.
    const gate = await holdNextBucketPut(`person:${person}`);
    const adding = outcomeOf(
      add(source, `Theirs alone ${word}`, { kind: "owner", personId: person })
    );
    await vi.waitFor(
      () => {
        expect(gate.reached).toBeTruthy();
      },
      { timeout: 10_000 }
    );
    const teamAdd = await outcomeOf(
      add(source, `The team's ${word}`, { kind: "team", teamId: team })
    );
    gate.released = true;
    const theirs = await adding;
    const theirsKept = await own(person).readCurrent({
      sources: [keyOf(source)],
      reader: { person, groups: [] },
    });

    expect({
      teamAdd,
      theirs: theirs.includes("keeps the readers it was first added for"),
      theirsKept,
      found: await textsFor(person, word, true),
      colleague: await textsFor(colleague, word, true),
    }).toStrictEqual({
      teamAdd: "answered",
      theirs: true,
      theirsKept: [],
      found: [`The team's ${word}`],
      colleague: [`The team's ${word}`],
    });
  });

  it("is erased in the shared store whatever readers its erasure names, its key closed there", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    const word = markerWord();
    const source = newSource();
    await add(source, `The team's draft ${word}`, {
      kind: "team",
      teamId: team,
    });

    // Named by readers the producer thinks it has now: its own person.
    await eraseSource(env, {
      source,
      readers: { kind: "owner", personId: person },
      reason: "deleted",
    });

    expect({
      colleague: await textsFor(colleague, word, true),
      read: await readSourceVersionAs(env, colleague, { source, version: 1 }),
      addedAgain: await add(source, "Back again", {
        kind: "team",
        teamId: team,
      }).then(
        () => "added",
        () => "refused"
      ),
    }).toStrictEqual({ colleague: [], read: null, addedAgain: "refused" });
  });

  it("widened from one person's own to a team, keeps its private version readable to that person alone until their erasure", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    const [draft, final] = [markerWord(), markerWord()];
    const source = newSource();
    // The producers' rule is never to widen a source: this is what holds
    // when one does anyway. Each store then numbers its own versions.
    await add(source, `Their own draft ${draft}`, {
      kind: "owner",
      personId: person,
    });
    await add(source, `The team's final ${final}`, {
      kind: "team",
      teamId: team,
    });
    const before = {
      theirs: await textsFor(person, draft, true),
      colleagues: await textsFor(colleague, draft, true),
    };

    // Erased as the team's: the shared copy goes, theirs stays theirs.
    await eraseSource(env, {
      source,
      readers: { kind: "team", teamId: team },
      reason: "deleted",
    });
    const afterSharedErasure = {
      theirs: await textsFor(person, draft, true),
      final: await textsFor(colleague, final, true),
    };
    const erasing = { personId: person, reason: "person_erased" } as const;
    await Promise.allSettled([erasePerson(env, erasing)]);
    await ageOwnErasure(person);
    await erasePerson(env, erasing);

    expect({
      before,
      afterSharedErasure,
      afterTheirErasure: await textsFor(person, draft, true),
    }).toStrictEqual({
      before: { theirs: [`Their own draft ${draft}`], colleagues: [] },
      afterSharedErasure: { theirs: [`Their own draft ${draft}`], final: [] },
      afterTheirErasure: [],
    });
  });
});

describe("a person's own store failing", () => {
  it("leaves what is shared readable, listed and loaded for them and others' recall whole, and fails only their own recall that reads it", async () => {
    const [person, colleague] = await Promise.all([member(), member()]);
    const team = await teamOf(person, colleague);
    const word = markerWord();
    const teamNote = newSource();
    await add(teamNote, `The team's note ${word}`, {
      kind: "team",
      teamId: team,
    });
    await add(newSource(), `Their own ${word}`, {
      kind: "owner",
      personId: person,
    });
    const company: InstructionFile = { scope: "company", name: "facts" };
    const theirFile: InstructionFile = { scope: "person", personId: person };
    await addInstructionFile(env, {
      file: company,
      change: crypto.randomUUID(),
      text: "We sell bicycles",
    });
    await addInstructionFile(env, {
      file: theirFile,
      change: crypto.randomUUID(),
      text: "Call me by my first name",
    });
    const broken = await breakOwnStore(person);
    try {
      const listed = await listSourcesAs(env, person, {});
      const versions = await listVersionsAs(env, person, { source: teamNote });
      const files = await readInstructionFilesAs(env, { userId: person }, [
        company,
        theirFile,
      ]);
      expect({
        history: await historyAs(person, { source: teamNote, version: 1 }),
        listed: listed.sources.map(({ source }) => source.id),
        versions: versions.versions.map(({ version }) => version),
        files: files.map(({ text }) => text),
        asApp: await textsFor(person, word, false),
        colleague: await textsFor(colleague, word, true),
        own: await outcomeOf(textsFor(person, word, true)),
      }).toStrictEqual({
        history: `The team's note ${word}`,
        // Their own part goes missing, never the shared part.
        listed: [teamNote.id],
        versions: [1],
        files: ["We sell bicycles"],
        asApp: [`The team's note ${word}`],
        colleague: [`The team's note ${word}`],
        own: "Error: The Brain can't read its erasure ledger yet, so it answers nothing: try again shortly",
      });
    } finally {
      await broken.heal();
    }
  });
});

describe("erasing a person", () => {
  it("as a withdrawal leaves their own store answering and taking adds", async () => {
    const person = await member();
    const word = markerWord();
    const readers: SourceReaders = { kind: "owner", personId: person };
    await add(newSource(), `Their own ${word}`, readers);

    await erasePerson(env, { personId: person, reason: "withdrawn" });
    await add(newSource(), `Added after ${word}`, readers);

    const found = await textsFor(person, word, true);
    expect(found.toSorted()).toStrictEqual(
      [`Added after ${word}`, `Their own ${word}`].toSorted()
    );
  });

  it("erases their own store whole after the shared store, stays pending while it is still deleting, and then answers them as nothing does", async () => {
    const person = await member();
    const team = await teamOf(person);
    const word = markerWord();
    const source = newSource();
    const readers: SourceReaders = { kind: "owner", personId: person };
    await add(source, `Their own ${word}`, readers);
    await add(newSource(), `The team's ${word} and more`, {
      kind: "team",
      teamId: team,
    });
    const erasing = { personId: person, reason: "person_erased" } as const;

    // The record of the erasure can't be written: nothing is erased.
    const unrecorded = await breakBucketOf(person, ["put"]);
    await expect(erasePerson(env, erasing)).rejects.toThrow(
      /could not record the erasure/u
    );
    await unrecorded.heal();
    const beforeErasure = await textsFor(person, word, true);

    // Recorded, but its files can't be deleted yet: still pending.
    const undeletable = await breakBucketOf(person, ["delete"]);
    const whileUndeletable = await erasePerson(env, erasing);
    const whileDeleting = await textsFor(person, word, true);
    await undeletable.heal();
    // Its files deleted, it is still deleting until an add under way
    // could have written its file: as if that time had passed.
    const withinGrace = await erasePerson(env, erasing);
    await ageOwnErasure(person);
    const done = await erasePerson(env, erasing);

    expect({
      answers: [whileUndeletable, withinGrace, done],
      beforeErasure,
      whileDeleting,
      afterwards: await textsFor(person, word, true),
      read: await readSourceVersionAs(env, person, { source, version: 1 }),
      // A producer erasing their source after them isn't held pending.
      sourceErased: await eraseSource(env, {
        source,
        readers,
        reason: "deleted",
      }).then(() => "erased"),
      addRefused: await add(newSource(), "Later", readers).then(
        () => false,
        () => true
      ),
    }).toStrictEqual({
      answers: ["still_deleting", "still_deleting", "erased"],
      beforeErasure: [`Their own ${word}`, `The team's ${word} and more`],
      whileDeleting: [`The team's ${word} and more`],
      afterwards: [`The team's ${word} and more`],
      read: null,
      sourceErased: "erased",
      addRefused: true,
    });
  });
});
