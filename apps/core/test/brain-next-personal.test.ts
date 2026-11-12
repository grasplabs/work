import {
  brainOf,
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
import { ageOwnErasure } from "./brain-next-own-store.ts";
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

/**
 * The names of the Brain's stores core addressed while `run` ran, and
 * what it returned: through the binding itself.
 */
const addressedBy = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; names: string[] }> => {
  const spy = vi.spyOn(env.BRAIN_STORE, "getByName");
  try {
    const value = await run();
    return { value, names: spy.mock.calls.map(([name]) => name) };
  } finally {
    spy.mockRestore();
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

describe("erasing a person", () => {
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
    await expect(erasePerson(env, erasing)).rejects.toThrow(
      /still deleting its files/u
    );
    const whileDeleting = await textsFor(person, word, true);
    await undeletable.heal();
    // Its files deleted, it is still deleting until an add under way
    // could have written its file: as if that time had passed.
    await expect(erasePerson(env, erasing)).rejects.toThrow(
      /still deleting its files/u
    );
    await ageOwnErasure(person);
    await erasePerson(env, erasing);

    expect({
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
      beforeErasure: [`Their own ${word}`, `The team's ${word} and more`],
      whileDeleting: [`The team's ${word} and more`],
      afterwards: [`The team's ${word} and more`],
      read: null,
      sourceErased: "erased",
      addRefused: true,
    });
  });
});
