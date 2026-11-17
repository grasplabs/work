// Erasing a member, through core's real erasure path, in the new Brain's
// shared store (GRA-1747, threat model on the issue): what the Brain
// derived about them and what is in their own word goes; the documents
// stay, also where their text names them.
import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import {
  addSource,
  brainExportFile,
  brainExportStatus,
  entitiesAs,
  recallAs,
  startBrainExport,
  workBrain,
} from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { finishedByTheClock } from "./brain-next-own-store.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { noProducers } from "./no-producers.ts";
import { signedInApi } from "./sign-in.ts";

const idp = mockIdp();
const shared = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A team of `members`, as an admin makes one. */
const teamOf = async (...members: string[]): Promise<string> => {
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  await db.insert(teamMembers).values(
    members.map((userId) => ({
      id: crypto.randomUUID(),
      teamId: id,
      userId,
      createdAt: new Date(),
    }))
  );
  return id;
};

/** A word of letters only, as recall finds one. */
const word = (): string =>
  `w${crypto.randomUUID().replaceAll("-", "").replaceAll(/\d/gu, "")}`.slice(
    0,
    14
  );

/**
 * Anna and Bob in a team: Bob's note about her (her name and address),
 * her own note for the team, and from them memories about her and one in
 * her word; Anna confirms Bob's memory about the project; and Cas, outside
 * the team, who could never read any of it.
 */
const annaAndBob = async () => {
  const admin = await signedInApi(idp, "admin");
  const anna = await signedInApi(idp, "user");
  const bob = await signedInApi(idp, "user");
  const cas = await signedInApi(idp, "user");
  const name = String(anna.person.name);
  const address = String(anna.person.email).toLowerCase();
  const team = await teamOf(anna.userId, bob.userId);
  const marker = word();
  const bobsNote = { producer: "upload", id: crypto.randomUUID() } as const;
  await addSource(env, {
    source: bobsNote,
    change: crypto.randomUUID(),
    text: `${name} (${address}) leads finance ${marker}.`,
    readers: { kind: "team", teamId: team },
  });
  const annasNote = { producer: "upload", id: crypto.randomUUID() } as const;
  await addSource(env, {
    source: annasNote,
    change: crypto.randomUUID(),
    text: `I am on leave in March. Atlas ships in May ${marker}.`,
    readers: { kind: "team", teamId: team },
  });
  const access = { kind: "audience", group: `team:${team}` } as const;
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access,
    entities: [
      {
        key: "anna",
        kind: "person",
        names: [name],
        identifiers: [{ type: "email", value: address }],
      },
      { key: "atlas", kind: "project", names: [`Atlas ${marker}`] },
    ],
    memories: [
      {
        about: "anna",
        attribute: "role",
        value: "finance lead",
        type: "fact",
        statement: `${name} leads finance ${marker}`,
        speaker: { kind: "internal", person: bob.userId },
        basis: {
          kind: "source",
          source: `upload:${bobsNote.id}`,
          version: 1,
          quote: "leads finance",
        },
      },
      {
        about: "atlas",
        type: "fact",
        statement: `Atlas ships in May, ${marker} said`,
        speaker: { kind: "internal", person: anna.userId },
        basis: {
          kind: "source",
          source: `upload:${annasNote.id}`,
          version: 1,
          quote: "Atlas ships in May",
        },
      },
      {
        about: "atlas",
        type: "fact",
        statement: `Atlas has a finance lead ${marker}`,
        speaker: { kind: "internal", person: bob.userId },
        basis: {
          kind: "source",
          source: `upload:${bobsNote.id}`,
          version: 1,
          quote: "leads finance",
        },
      },
    ],
  });
  await shared().confirmMemory({
    memory: added.memories.at(2) ?? "",
    reader: { person: anna.userId, groups: [`team:${team}`] },
  });
  return { admin, anna, bob, cas, name, address, marker };
};

/** What `personId` is answered by the Brain about the people, and to a recall of `question`. */
const seenBy = async (personId: string, question: string) => {
  const people = await entitiesAs(env, personId, { kind: "person" });
  const recalled = await recallAs(env, personId, {
    question,
    budget: { tokens: recallBudgetMax },
    personal: true,
  });
  return {
    people: people.items.map(({ name }) => name),
    texts: recalled.items.map(({ text }) => text),
    memories: recalled.memories.map(({ statement }) => statement),
  };
};

/** Erases `who` as an admin does, and lets the clock finish it. */
const erased = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  who: Awaited<ReturnType<typeof signedInApi>>
) => {
  await admin.api.members.remove(who.userId);
  await admin.api.members.erase(who.userId, String(who.person.name));
  await finishedByTheClock(who.userId);
  return await admin.api.members.erasure(who.userId);
};

describe(
  "erasing a member, in what others may read in the Brain",
  { timeout: 180_000 },
  () => {
    it("takes their card and what the Brain drew about them or in their word, keeps the documents, and changes nothing for someone who could never read them", async () => {
      const at = await annaAndBob();
      const question = `${at.marker} finance leave Atlas`;
      const casBefore = await seenBy(at.cas.userId, question);

      const erasure = await erased(at.admin, at.anna);
      const bob = await seenBy(at.bob.userId, question);

      expect({
        completed: erasure.erasure?.completedAt !== null,
        area: erasure.erasure?.areas.find(({ area }) => area === "brain_shared")
          ?.state,
        // No person entity, card or memory of hers for a teammate.
        herEntity: bob.people.includes(at.name),
        herMemories: bob.memories.filter(
          (statement) =>
            statement.includes(at.name) || statement.includes("ships in May")
        ),
        // Bob's own word stays.
        kept: bob.memories.filter((statement) =>
          statement.includes("has a finance lead")
        ),
        // The documents stay, also where they name her.
        documents: [
          `${at.name} (${at.address}) leads finance ${at.marker}.`,
          `I am on leave in March. Atlas ships in May ${at.marker}.`,
        ].map((text) => bob.texts.includes(text)),
        // Someone who could never read any of it reads exactly as before.
        cas: await seenBy(at.cas.userId, question),
      }).toStrictEqual({
        completed: true,
        area: "complete",
        herEntity: false,
        herMemories: [],
        kept: [`Atlas has a finance lead ${at.marker}`],
        documents: [true, true],
        cas: casBefore,
      });
    });

    it("holds no id, name or address of theirs in a company export started after it, but in the documents' own text", async () => {
      const at = await annaAndBob();
      await erased(at.admin, at.anna);

      const { id } = await startBrainExport(env);
      for (let ticks = 0; ticks < 20; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await workBrain(env, new Date(), noProducers);
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        const status = await brainExportStatus(env, { id });
        if (status?.state !== "writing") {
          break;
        }
      }
      const status = await brainExportStatus(env, { id });
      const files = await Promise.all(
        (status?.files ?? []).map(
          async (file) => (await brainExportFile(env, { id, file })) ?? ""
        )
      );
      const lines = files.join("\n").split("\n");
      const derived = lines.filter(
        (line) =>
          line.includes('"kind":"memory"') ||
          line.includes('"kind":"confirmation"')
      );
      expect({
        state: status?.state,
        id: lines.some((line) => line.includes(at.anna.userId)),
        derived: [at.name, at.address].filter((needle) =>
          derived.some((line) => line.includes(needle))
        ),
        documents: lines.some((line) =>
          line.includes(`(${at.address}) leads finance ${at.marker}`)
        ),
      }).toStrictEqual({
        state: "done",
        id: false,
        derived: [],
        documents: true,
      });
    });

    it("keeps their address until the Brain took what it derived by it, though the Brain failed the first time", async () => {
      const at = await annaAndBob();
      const question = `${at.marker} finance leave Atlas`;
      const brainStore = inJurisdiction(env, env.BRAIN_STORE).getByName(
        "brain"
      );
      const holding = async (held: boolean) => {
        await runInDurableObject(brainStore, (_instance, state) => {
          state.storage.sql.exec(
            held
              ? `CREATE TRIGGER IF NOT EXISTS test_hold_person BEFORE INSERT ON erasures
                WHEN NEW.kind = 'person'
                BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
              : "DROP TRIGGER IF EXISTS test_hold_person"
          );
        });
      };
      await holding(true);
      let meanwhile:
        | Awaited<ReturnType<typeof at.admin.api.members.erasure>>
        | undefined;
      try {
        await at.admin.api.members.remove(at.anna.userId);
        await at.admin.api.members.erase(
          at.anna.userId,
          String(at.anna.person.name)
        );
        meanwhile = await at.admin.api.members.erasure(at.anna.userId);
      } finally {
        await holding(false);
      }
      await finishedByTheClock(at.anna.userId);
      await runMinuteTasks();
      const done = await at.admin.api.members.erasure(at.anna.userId);
      const bob = await seenBy(at.bob.userId, question);

      expect({
        meanwhile: meanwhile?.erasure?.areas.filter(({ area }) =>
          ["brain_shared", "identity"].includes(area)
        ),
        done: done.erasure?.completedAt !== null,
        herEntity: bob.people.includes(at.name),
        herMemories: bob.memories.filter((statement) =>
          statement.includes(at.name)
        ),
      }).toStrictEqual({
        meanwhile: [
          { area: "brain_shared", state: "pending" },
          { area: "identity", state: "pending" },
        ],
        done: true,
        herEntity: false,
        herMemories: [],
      });
    });

    it("stays erased once an older copy of the shared store comes back", async () => {
      const at = await annaAndBob();
      const question = `${at.marker} finance leave Atlas`;
      const before = await copyOfStore();

      await erased(at.admin, at.anna);
      await restoreStore(before);
      const bob = await seenBy(at.bob.userId, question);

      expect({
        herEntity: bob.people.includes(at.name),
        herMemories: bob.memories.filter(
          (statement) =>
            statement.includes(at.name) || statement.includes("ships in May")
        ),
        documents: bob.texts.some((text) => text.includes(at.address)),
      }).toStrictEqual({
        herEntity: false,
        herMemories: [],
        documents: true,
      });
    });
  }
);
