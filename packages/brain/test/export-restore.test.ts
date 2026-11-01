import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { ensureCollection } from "../src/collections.ts";
import {
  brainForgottenPeople,
  brainMemories,
  brainMemoryCites,
  collections,
  documents,
} from "../src/db/schema.ts";
import { versionText, writeVersion } from "../src/documents.ts";
import { sha256Hex, toBase64Url } from "../src/encoding.ts";
import {
  advanceExport,
  exportFile,
  exportStatus,
  manifestName,
  prepareExport,
  startExport,
} from "../src/exports.ts";
import { canonicalJson } from "../src/json.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import { citesWrite } from "../src/memories.ts";
import { restoreExport } from "../src/restore.ts";
import { newCollection, testHost, writerOf } from "./host.ts";

// Restoring an export into an empty Brain (GRA-1193, GRA-335's E2; the
// threat model is on GRA-335). It starts from the ways it can fail: a
// bundle that doesn't match its manifest restored all the same; a restore
// over a Brain that holds something; a person's own collection, or a
// forgotten person, coming back; history lost on the way.

const admin = writerOf("admin");

/** Nothing of the host's own. */
const noHost = {
  excluded: [],
  files: async () => await Promise.resolve([]),
};

/** An export of `brain`, written whole; its ID. */
const exported = async (
  brain: ReturnType<typeof testHost>["brain"]
): Promise<string> => {
  const { token } = await prepareExport(brain, admin, noHost);
  const { exportId } = await startExport(brain, admin, token, noHost);
  const done = await advanceExport(
    brain,
    exportId,
    noHost,
    new Date(Date.now() + 60_000)
  );
  if (!done) {
    throw new Error("The export didn't finish");
  }
  return exportId;
};

/** Export `exportId`'s files, as its admin downloads them, by name. */
const bundleOf = async (
  brain: ReturnType<typeof testHost>["brain"],
  exportId: string
): Promise<Map<string, string>> => {
  const { files } = await exportStatus(brain, admin, exportId);
  const names = [manifestName, ...files.map(({ name }) => name)];
  const texts = await Promise.all(
    names.map(
      async (name) =>
        await new Response(
          await exportFile(brain, admin, exportId, name)
        ).text()
    )
  );
  return new Map(names.map((name, at) => [name, texts[at] ?? ""]));
};

/** Reads file `name` of `bundle`. */
const readerOf =
  (bundle: ReadonlyMap<string, string>) =>
  async (name: string): Promise<string | null> =>
    await Promise.resolve(bundle.get(name) ?? null);

/** A refusal's code, or `ok`. */
const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return knowledgeErrors.codeOf(error) ?? String(error);
  }
};

describe("restoring an export of the company's Brain", () => {
  it("brings back the company's documents with their history and its shared memory, replays who was forgotten, and nothing personal", async () => {
    const source = testHost().brain;
    const u = crypto.randomUUID().slice(0, 8);
    const handbook = await newCollection(source, `Handbook ${u}`);
    const first = await writeVersion(source, writerOf("ada"), {
      collection: handbook,
      path: "rules.md",
      text: `# Rules\nAsk keep${u}.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    await writeVersion(source, writerOf("ben"), {
      collection: handbook,
      path: "rules.md",
      text: `# Rules\nAsk keep${u} first.`,
      ifVersion: 1,
      message: "Sharper",
      restoredFrom: null,
    });
    const personal = await ensureCollection(
      source,
      {
        id: crypto.randomUUID(),
        name: "Ada's",
        description: "",
        owner: "ada",
        access: "me",
        sensitive: false,
        source: "here",
        createdAt: new Date(),
      },
      admin.actor
    );
    await writeVersion(source, writerOf("ada"), {
      collection: personal,
      path: "USER.md",
      text: `# Me\nCall me own${u}.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const now = new Date();
    const memoryId = crypto.randomUUID();
    await source.db.insert(brainMemories).values({
      id: memoryId,
      revision: 1,
      scope: "company",
      scopeId: null,
      ownerId: "ada",
      kind: "fact",
      statement: `The handbook says keep${u}.`,
      sourceRefs: JSON.stringify([
        {
          kind: "document",
          documentId: first.id,
          collectionId: handbook.id,
          version: 1,
        },
      ]),
      state: "accepted",
      indexingState: "pending",
      recordedAt: now,
      updatedAt: now,
    });
    await citesWrite(source.db, memoryId, [handbook.id]);
    await source.db
      .insert(brainForgottenPeople)
      .values({ userId: `leaver-${u}`, forgottenAt: now });
    // A record of the forgotten person's, left behind: never restored, nor
    // a record resting on it.
    const leftBehind = crypto.randomUUID();
    await source.db.insert(brainMemories).values({
      id: leftBehind,
      revision: 1,
      scope: "company",
      scopeId: null,
      ownerId: `leaver-${u}`,
      kind: "fact",
      statement: `The leaver said gone${u}.`,
      sourceRefs: "[]",
      state: "accepted",
      indexingState: "pending",
      recordedAt: now,
      updatedAt: now,
    });
    await source.db.insert(brainMemories).values({
      id: crypto.randomUUID(),
      revision: 1,
      scope: "company",
      scopeId: null,
      ownerId: "ben",
      kind: "fact",
      statement: `Ben agreed with gone${u}.`,
      sourceRefs: JSON.stringify([
        { kind: "memory", memoryId: leftBehind, revision: 1 },
      ]),
      state: "accepted",
      indexingState: "pending",
      recordedAt: now,
      updatedAt: now,
    });
    const exportId = await exported(source);
    const bundle = await bundleOf(source, exportId);

    const target = testHost(undefined, {}, env.RESTORED).brain;
    const restored = await restoreExport(target, admin, readerOf(bundle));
    const [document] = await target.db
      .select()
      .from(documents)
      .where(eq(documents.path, "rules.md"));
    const texts = await Promise.all(
      [1, 2].map(
        async (number) =>
          await versionText(target, target.db, document?.id ?? "", number)
      )
    );
    const [memory] = await target.db
      .select()
      .from(brainMemories)
      .where(eq(brainMemories.id, memoryId));
    const cites = await target.db
      .select({ collectionId: brainMemoryCites.collectionId })
      .from(brainMemoryCites)
      .where(eq(brainMemoryCites.memoryId, memoryId));
    const kept = await target.db.select().from(collections);
    const forgotten = await target.db
      .select({ userId: brainForgottenPeople.userId })
      .from(brainForgottenPeople);
    expect({
      collections: kept.map(({ id }) => id),
      texts,
      memory: {
        statement: memory?.statement,
        pointsAtRestored: memory?.sourceRefs.includes(document?.id ?? "-"),
      },
      cites: cites.map(({ collectionId }) => collectionId),
      personal: JSON.stringify(
        await target.db.select().from(documents)
      ).includes(`own${u}`),
      forgotten: forgotten.map(({ userId }) => userId),
      result: {
        documents: restored.documents,
        versions: restored.versions,
        memories: restored.memories,
        memoriesLeftOut: restored.memoriesLeftOut,
      },
    }).toStrictEqual({
      collections: [handbook.id],
      texts: [`# Rules\nAsk keep${u}.`, `# Rules\nAsk keep${u} first.`],
      memory: {
        statement: `The handbook says keep${u}.`,
        pointsAtRestored: true,
      },
      cites: [handbook.id],
      personal: false,
      forgotten: [`leaver-${u}`],
      result: { documents: 1, versions: 2, memories: 1, memoriesLeftOut: 2 },
    });
  });

  it("refuses a bundle a file of which doesn't match its manifest, and writes nothing", async () => {
    const source = testHost().brain;
    const handbook = await newCollection(source, "Handbook");
    await writeVersion(source, admin, {
      collection: handbook,
      path: "a.md",
      text: "# A\nSomething.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const exportId = await exported(source);
    // Renamed, as a row still reads, and the manifest's checksum made to
    // match: only the manifest's signature tells.
    const bundle = await bundleOf(source, exportId);
    const text = bundle.get("collections.jsonl") ?? "";
    const tampered = text.replace('"Handbook"', '"Tampered"');
    bundle.set("collections.jsonl", tampered);
    bundle.set(
      manifestName,
      (bundle.get(manifestName) ?? "").replace(
        await sha256Hex(text),
        await sha256Hex(tampered)
      )
    );
    const target = testHost(undefined, {}, env.RESTORED).brain;
    await target.db.delete(collections);
    const refused = await codeOf(
      restoreExport(target, admin, readerOf(bundle))
    );
    const written = await target.db.select().from(collections);
    expect({ refused, written: written.length }).toStrictEqual({
      refused: "knowledge.invalid",
      written: 0,
    });
  });

  it("never restores over a Brain that holds something", async () => {
    const source = testHost().brain;
    const handbook = await newCollection(source, "Shared handbook");
    await writeVersion(source, admin, {
      collection: handbook,
      path: "b.md",
      text: "# B\nSomething.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const exportId = await exported(source);
    const target = testHost(undefined, {}, env.RESTORED).brain;
    await target.db.delete(collections);
    const other = await newCollection(target, "Another company's");
    const refused = await codeOf(
      restoreExport(target, admin, readerOf(await bundleOf(source, exportId)))
    );
    const held = await target.db
      .select({ id: collections.id })
      .from(collections);
    expect({ refused, held: held.map(({ id }) => id) }).toStrictEqual({
      refused: "knowledge.conflict",
      held: [other.id],
    });
  });

  it("refuses a signed bundle a write would refuse before writing anything, so nothing is left behind", async () => {
    // A path twice in one collection: the second write would fail midway.
    const collection = {
      id: crypto.randomUUID(),
      name: "Crafted",
      description: "",
      owner: "admin",
      access: "everyone",
      sensitive: false,
      source: "here",
      createdAt: new Date().toISOString(),
    };
    const documentOf = (id: string) => ({
      id,
      collectionId: collection.id,
      path: "same.md",
      createdAt: new Date().toISOString(),
      versions: [
        {
          number: 1,
          author: "admin",
          message: null,
          restoredFrom: null,
          createdAt: new Date().toISOString(),
          text: "# Same\nTwice.",
        },
      ],
      transcript: null,
    });
    const files = new Map([
      ["collections.jsonl", `${JSON.stringify(collection)}\n`],
      [
        "documents-0001.jsonl",
        `${JSON.stringify(documentOf("a"))}\n${JSON.stringify(documentOf("b"))}\n`,
      ],
      ["memories.jsonl", ""],
      ["erasures.jsonl", ""],
    ]);
    const body = {
      format: "grasp-brain-export",
      version: 1,
      exportId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      files: await Promise.all(
        [...files].map(async ([name, text]) => ({
          name,
          sha256: await sha256Hex(text),
          bytes: new TextEncoder().encode(text).byteLength,
          rows: text.split("\n").filter((line) => line !== "").length,
        }))
      ),
    };
    // Signed as the test host's key signs it (test/host.ts `keys`).
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(
        "test key for grasp-os brain export manifest v1"
      ),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = toBase64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(canonicalJson(body))
        )
      )
    );
    files.set("manifest.json", JSON.stringify({ ...body, signature }));
    const target = testHost(undefined, {}, env.RESTORED).brain;
    await target.db.delete(collections);
    const refused = await codeOf(
      restoreExport(
        target,
        admin,
        async (name) => await Promise.resolve(files.get(name) ?? null)
      )
    );
    const written = await target.db.select().from(collections);
    expect({ refused, written: written.length }).toStrictEqual({
      refused: "knowledge.invalid",
      written: 0,
    });
  });
});
