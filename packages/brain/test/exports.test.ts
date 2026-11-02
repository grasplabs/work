import { env } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { createBrain } from "../src/brain.ts";
import type { Brain } from "../src/brain.ts";
import { ensureCollection } from "../src/collections.ts";
import {
  brainMemories,
  collections as collectionsTable,
} from "../src/db/schema.ts";
import { writeVersion } from "../src/documents.ts";
import {
  advanceExport,
  exportFile,
  exportFileBytes,
  exportFileReads,
  exportLeaseMs,
  exportStatus,
  manifestName,
  prepareExport,
  startExport,
} from "../src/exports.ts";
import type { HostExportFile, OnExport } from "../src/exports.ts";
import type { Json } from "../src/json.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import { preparePurge, purge } from "../src/purge.ts";
import type { OnErase } from "../src/purge.ts";
import type { Caller } from "./host.ts";
import { newCollection, noCopies, testHost, writerOf } from "./host.ts";

// An export of the company's Brain, as its writer fails (GRA-335's E1;
// the threat model is on GRA-335): more collections than D1 binds to one
// statement; collections made while it runs; a purge unfinished as it
// would begin, or begun while it runs; the host's files cut short; an
// upload that fails; and a run that lost its claim writing on after
// another took over.

const admin = writerOf("admin");

const manifestSchema = z.object({
  files: z.array(z.object({ name: z.string(), sha256: z.string() })),
});

const idSchema = z.object({ id: z.string() });

/** A piece of a document in an export's documents file: its first, or one continuing it. */
const pieceSchema = z.object({
  id: z.string().optional(),
  continues: z.string().optional(),
  versions: z.array(z.object({ number: z.number() })),
});

/** A line of an export's documents file, as far as these tests read it. */
const documentRowSchema = z.object({
  id: z.string(),
  versions: z.array(z.object({ number: z.number() })),
  transcript: z.object({ version: z.number() }).nullable(),
});

/** The code of what `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return knowledgeErrors.codeOf(error) ?? String(error);
  }
};

/** A host that adds `files` of its own. */
const hostWith = (files: readonly HostExportFile[] = []): OnExport => ({
  excluded: [],
  files,
});

/** A part of the host's holding `rows`, a page of two at a time. */
const hostPart = (name: string, rows: readonly Json[]): HostExportFile => ({
  name,
  page: async (_, after) =>
    await Promise.resolve(
      rows
        .map((row, at) => ({ row, key: String(at).padStart(8, "0") }))
        .filter(({ key }) => after === null || key > after)
        .slice(0, 2)
    ),
});

/** `brain` with its ports changed as `change` says. */
const withPorts = (
  brain: Brain<Caller>,
  change: Partial<Brain<Caller>["ports"]>
): Brain<Caller> => createBrain(env.BRAIN, { ...brain.ports, ...change });

/** An export begun, confirmed with its token. */
const begun = async (brain: Brain<Caller>, onExport: OnExport) => {
  const { token } = await prepareExport(brain, admin, onExport);
  const { exportId } = await startExport(brain, admin, token, onExport);
  return exportId;
};

/**
 * `exportId` advanced until it is complete or refuses, a call at a time
 * as the host's clock calls it (each within `exportInvocationReads`).
 */
const ranToEnd = async (
  brain: Brain<Caller>,
  exportId: string,
  onExport: OnExport
): Promise<string> =>
  await outcome(
    (async () => {
      for (let call = 0; call < 100; call += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one call after another
        const complete = await advanceExport(
          brain,
          exportId,
          onExport,
          new Date(brain.ports.clock().getTime() + 60_000)
        );
        if (complete) {
          return;
        }
      }
      throw new Error(`Export ${exportId} is still running`);
    })()
  );

/** File `name` of a complete export, as text. */
const fileText = async (
  brain: Brain<Caller>,
  exportId: string,
  name: string
): Promise<string> =>
  await new Response(await exportFile(brain, admin, exportId, name)).text();

/** The rows of every file of part `prefix` of a complete export, by file. */
const partRows = async (
  brain: Brain<Caller>,
  exportId: string,
  prefix: string
): Promise<{ file: string; rows: unknown[] }[]> => {
  const manifest = manifestSchema.parse(
    JSON.parse(await fileText(brain, exportId, manifestName))
  );
  const files = manifest.files
    .map(({ name }) => name)
    .filter((name) => new RegExp(`^${prefix}-\\d{4}\\.jsonl$`, "u").test(name));
  const read: { file: string; rows: unknown[] }[] = [];
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time, as each is large
    const text = await fileText(brain, exportId, file);
    read.push({
      file,
      rows: text
        .split("\n")
        .filter((line) => line !== "")
        .map((line): unknown => JSON.parse(line)),
    });
  }
  return read;
};

/** Each file the manifest names, and whether its download has its checksum. */
const checked = async (brain: Brain<Caller>, exportId: string) => {
  const manifest = manifestSchema.parse(
    JSON.parse(await fileText(brain, exportId, manifestName))
  );
  return await Promise.all(
    manifest.files.map(async ({ name, sha256 }) => {
      const bytes = new TextEncoder().encode(
        await fileText(brain, exportId, name)
      );
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes)
      );
      const hex = [...digest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return { name, matches: hex === sha256 };
    })
  );
};

/** Where `exportId` stands. */
const stateOf = async (brain: Brain<Caller>, exportId: string) => {
  const { state } = await exportStatus(brain, admin, exportId);
  return state;
};

/** Whether every file the manifest names downloads with its checksum. */
const whole = async (brain: Brain<Caller>, exportId: string) => {
  const files = await checked(brain, exportId);
  return files.every(({ matches }) => matches);
};

/** Every object the bucket keeps for `exportId`. */
const objectsOf = async (exportId: string): Promise<string[]> => {
  const listed = await env.BLOBS.list({ prefix: `exports/${exportId}/` });
  return listed.objects.map(({ key }) => key);
};

/** A purge of `term` from `documentId` that its host's copies fail. */
const blockedPurge = async (brain: Brain<Caller>, documentId: string) => {
  const failing: OnErase = {
    ...noCopies,
    forgetFiles: async () => {
      await Promise.resolve();
      throw new Error("The host's copies are out of reach");
    },
  };
  const input = {
    type: "content",
    documentIds: [documentId],
    terms: ["route"],
    reason: "erasure_request",
  };
  const { token } = await preparePurge(brain, admin, input, failing);
  return await outcome(purge(brain, admin, input, token, failing));
};

describe("exporting the company's Brain", () => {
  it("holds more collections than one statement binds, and only those it began with", async () => {
    const { brain } = testHost();
    const made = await Promise.all(
      Array.from(
        { length: 120 },
        async (_, at) => await newCollection(brain, `Collection ${at}`)
      )
    );
    const onExport = hostWith();
    const exportId = await begun(brain, onExport);
    // Made after it began: not what was confirmed, so not in it.
    const later = await newCollection(brain, "Later");
    await writeVersion(brain, admin, {
      collection: later,
      path: "later.md",
      text: "# Later\nMade after the export began.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const ended = await ranToEnd(brain, exportId, onExport);
    const listed = await fileText(brain, exportId, "collections-0001.jsonl");
    const collections = new Set(
      listed
        .trim()
        .split("\n")
        .map((line) => idSchema.parse(JSON.parse(line)).id)
    );

    expect({
      ended,
      holdsAll: made.every(({ id }) => collections.has(id)),
      holdsLater: collections.has(later.id),
      files: await whole(brain, exportId),
    }).toStrictEqual({
      ended: "ok",
      holdsAll: true,
      holdsLater: false,
      files: true,
    });
  });

  it("refuses to begin while a purge is unfinished, and fails once one begins while it runs", async () => {
    const { brain } = testHost();
    const plans = await newCollection(brain, "Plans");
    const plan = await writeVersion(brain, admin, {
      collection: plans,
      path: "plan.md",
      text: "# Plan\nThe route is secret.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const onExport = hostWith();
    // Begun before the purge: running when one starts.
    const during = await begun(brain, onExport);
    const blocked = await blockedPurge(brain, plan.id);
    const duringEnded = await ranToEnd(brain, during, onExport);
    const { token } = await prepareExport(brain, admin, onExport);
    const whileOpen = await outcome(startExport(brain, admin, token, onExport));

    expect({
      blocked,
      duringEnded,
      during: await stateOf(brain, during),
      left: await objectsOf(during),
      whileOpen,
    }).toStrictEqual({
      blocked: "Error: The host's copies are out of reach",
      duringEnded: "knowledge.export_purged",
      during: "failed",
      left: [],
      whileOpen: "knowledge.export_purge_open",
    });
    // Finished, as its host's copies come back in reach: exports may run.
    const input = {
      type: "content",
      documentIds: [plan.id],
      terms: ["route"],
      reason: "erasure_request",
    };
    const again = await preparePurge(brain, admin, input, noCopies);
    await purge(brain, admin, input, again.token, noCopies);
  });

  it("goes on with a part from the file a run stopped before, after another takes it over", async () => {
    const { brain } = testHost();
    await newCollection(brain, "Plans");
    // A part of the host's three files long: each row more than half of
    // one (`exportFileBytes`).
    const overHalf = Math.floor(exportFileBytes / 2) + 1;
    const rows = Array.from({ length: 3 }, (_, at) => ({
      at,
      text: "x".repeat(overHalf),
    }));
    const onExport = hostWith([hostPart("big", rows)]);
    // The first run stops at the part's second file: its upload never
    // ends, as a run whose isolate went away.
    let stopped = false;
    const cut = withPorts(brain, {
      blobs: {
        delete: env.BLOBS.delete.bind(env.BLOBS),
        get: env.BLOBS.get.bind(env.BLOBS),
        head: env.BLOBS.head.bind(env.BLOBS),
        list: env.BLOBS.list.bind(env.BLOBS),
        put: async (key, value, options) => {
          if (key.endsWith("-host-big-0002.jsonl")) {
            stopped = true;
            // Never ends.
            await Promise.withResolvers<never>().promise;
          }
          return await env.BLOBS.put(key, value, options);
        },
      },
    });
    const exportId = await begun(brain, onExport);
    void advanceExport(cut, exportId, onExport, new Date(Date.now() + 60_000));
    await expect.poll(() => stopped).toBe(true);
    // Past its lease, another run takes it over and finishes it.
    const later = withPorts(brain, {
      clock: () => new Date(Date.now() + exportLeaseMs + 60_000),
    });
    const ended = await ranToEnd(later, exportId, onExport);
    const files = await partRows(brain, exportId, "host-big");

    expect({
      ended,
      whole: await whole(brain, exportId),
      files: files.map(({ file }) => file),
      rows: files.flatMap(({ rows: held }) =>
        held.map((row) => z.object({ at: z.number() }).parse(row).at)
      ),
    }).toStrictEqual({
      ended: "ok",
      whole: true,
      files: [
        "host-big-0001.jsonl",
        "host-big-0002.jsonl",
        "host-big-0003.jsonl",
      ],
      rows: [0, 1, 2],
    });
  });

  it("fails an export whose upload fails, and leaves nothing of it in the bucket", async () => {
    const { brain } = testHost();
    await newCollection(brain, "Plans");
    const onExport = hostWith();
    const failing = withPorts(brain, {
      blobs: {
        delete: env.BLOBS.delete.bind(env.BLOBS),
        get: env.BLOBS.get.bind(env.BLOBS),
        head: env.BLOBS.head.bind(env.BLOBS),
        list: env.BLOBS.list.bind(env.BLOBS),
        put: async (key, value, options) => {
          if (key.endsWith("-memories-0001.jsonl")) {
            throw new Error("The bucket is out of reach");
          }
          return await env.BLOBS.put(key, value, options);
        },
      },
    });
    const exportId = await begun(brain, onExport);

    expect({
      ended: await ranToEnd(failing, exportId, onExport),
      state: await stateOf(brain, exportId),
      left: await objectsOf(exportId),
    }).toStrictEqual({
      ended: "Error: The bucket is out of reach",
      state: "failed",
      left: [],
    });
  });

  it("lets a run that lost its claim change nothing of what the run that took over wrote", async () => {
    const { brain } = testHost();
    const plans = await newCollection(brain, "Plans");
    await writeVersion(brain, admin, {
      collection: plans,
      path: "plan.md",
      text: "# Plan\nThe route.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const onExport = hostWith([hostPart("grants", [{ a: 1 }])]);
    const exportId = await begun(brain, onExport);
    // The first run's first upload waits until the second run is done.
    const { promise: held, resolve: release } =
      Promise.withResolvers<boolean>();
    let waited = false;
    const stale = withPorts(brain, {
      blobs: {
        delete: env.BLOBS.delete.bind(env.BLOBS),
        get: env.BLOBS.get.bind(env.BLOBS),
        head: env.BLOBS.head.bind(env.BLOBS),
        list: env.BLOBS.list.bind(env.BLOBS),
        put: async (key, value, options) => {
          if (!waited) {
            waited = true;
            await held;
            return await env.BLOBS.put(key, "stale", options);
          }
          return await env.BLOBS.put(key, value, options);
        },
      },
    });
    const first = outcome(
      advanceExport(stale, exportId, onExport, new Date(Date.now() + 60_000))
    );
    // Past the first run's lease: another takes the export over.
    const later = withPorts(brain, {
      clock: () => new Date(Date.now() + exportLeaseMs + 60_000),
    });
    await expect.poll(() => waited).toBe(true);
    const second = await ranToEnd(later, exportId, onExport);
    release(true);
    const firstEnded = await first;

    expect({
      firstEnded,
      second,
      state: await stateOf(brain, exportId),
      files: await whole(brain, exportId),
    }).toStrictEqual({
      // It stops, as one that lost its claim: neither complete nor failed.
      firstEnded: "ok",
      second: "ok",
      state: "complete",
      files: true,
    });
  });

  it("holds each document's transcript with the version it belongs to, however a save falls between its reads", async () => {
    const { brain } = testHost();
    const meetings = await newCollection(brain, "Meetings");
    const first = await writeVersion(brain, admin, {
      collection: meetings,
      path: "standup.md",
      text: "# Standup\nNotes.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    // Its first version's text, as the bucket keeps it.
    const firstText = await env.BRAIN.prepare(
      "SELECT payload_key AS key FROM versions WHERE document_id = ? AND number = 1"
    )
      .bind(first.id)
      .first<{ key: string }>();
    const onExport = hostWith();
    const exportId = await begun(brain, onExport);
    // As the export reads the document's text, a recording of the meeting
    // is saved as its next version, with its transcript.
    let saved = false;
    const racing = withPorts(brain, {
      blobs: {
        delete: env.BLOBS.delete.bind(env.BLOBS),
        head: env.BLOBS.head.bind(env.BLOBS),
        list: env.BLOBS.list.bind(env.BLOBS),
        put: env.BLOBS.put.bind(env.BLOBS),
        get: async (key, options) => {
          if (!saved && key === firstText?.key) {
            saved = true;
            await writeVersion(brain, admin, {
              collection: meetings,
              path: "standup.md",
              text: "# Standup\nRecorded.",
              ifVersion: 1,
              message: null,
              restoredFrom: null,
              transcript: {
                turns: [{ speaker: "Ada", text: "Recorded.", startMs: 0 }],
                chapters: [],
              },
            });
          }
          return await env.BLOBS.get(key, options);
        },
      },
    });
    const ended = await ranToEnd(racing, exportId, onExport);
    const manifest = manifestSchema.parse(
      JSON.parse(await fileText(brain, exportId, manifestName))
    );
    const texts = await Promise.all(
      manifest.files
        .filter(({ name }) => name.startsWith("documents-"))
        .map(async ({ name }) => await fileText(brain, exportId, name))
    );
    const rows = texts
      .flatMap((text) => text.split("\n").filter((line) => line !== ""))
      .map((line) => documentRowSchema.parse(JSON.parse(line)));
    const row = rows.find(({ id }) => id === first.id);
    const numbers = row?.versions.map(({ number }) => number) ?? [];

    expect({
      ended,
      saved,
      transcriptVersionHeld:
        row?.transcript === null ||
        numbers.includes(row?.transcript.version ?? -1),
    }).toStrictEqual({ ended: "ok", saved: true, transcriptVersionHeld: true });
  });

  it("splits a document's history across files once it outgrows one, losing and repeating no version", async () => {
    const { brain } = testHost();
    const archive = await newCollection(brain, "Archive");
    // Each version near the most a version holds: together more than one
    // file of the export holds.
    const versionCount = 9;
    const versionChars = 1_000_000;
    let id = "";
    for (let number = 1; number <= versionCount; number += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one version after another
      const saved = await writeVersion(brain, admin, {
        collection: archive,
        path: "ledger.md",
        text: `# Ledger ${String(number)}\n${"x".repeat(versionChars)}`,
        ifVersion: number - 1,
        message: null,
        restoredFrom: null,
      });
      ({ id } = saved);
    }
    const onExport = hostWith();
    const exportId = await begun(brain, onExport);
    const ended = await ranToEnd(brain, exportId, onExport);
    const manifest = manifestSchema.parse(
      JSON.parse(await fileText(brain, exportId, manifestName))
    );
    const pieces: { file: string; numbers: number[] }[] = [];
    for (const { name } of manifest.files) {
      if (name.startsWith("documents-")) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time, as each is large
        const text = await fileText(brain, exportId, name);
        for (const line of text.split("\n")) {
          if (line !== "") {
            const row = pieceSchema.parse(JSON.parse(line));
            if (row.id === id || row.continues === id) {
              pieces.push({
                file: name,
                numbers: row.versions.map(({ number }) => number),
              });
            }
          }
        }
      }
    }

    expect({
      ended,
      files: new Set(pieces.map(({ file }) => file)).size > 1,
      numbers: pieces.flatMap(({ numbers }) => numbers),
    }).toStrictEqual({
      ended: "ok",
      files: true,
      numbers: Array.from({ length: versionCount }, (_, index) => index + 1),
    });
  });

  it(
    "splits a document of many small versions across files by the reads they take, losing and repeating no version",
    { timeout: 60_000 },
    async () => {
      const { brain } = testHost();
      const notes = await newCollection(brain, "Notes");
      // More versions than one file reads (two reads each), each tiny.
      const versionCount = exportFileReads + 50;
      let id = "";
      for (let number = 1; number <= versionCount; number += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one version after another
        const saved = await writeVersion(brain, admin, {
          collection: notes,
          path: "log.md",
          text: `# Log\nEntry ${String(number)}.`,
          ifVersion: number - 1,
          message: null,
          restoredFrom: null,
        });
        ({ id } = saved);
      }
      // The bucket reads each file of documents makes before it is written.
      let gets = 0;
      let mostGets = 0;
      const counting = withPorts(brain, {
        blobs: {
          delete: env.BLOBS.delete.bind(env.BLOBS),
          head: env.BLOBS.head.bind(env.BLOBS),
          list: env.BLOBS.list.bind(env.BLOBS),
          get: async (key, options) => {
            gets += 1;
            return await env.BLOBS.get(key, options);
          },
          put: async (key, value, options) => {
            if (key.includes("-documents-")) {
              mostGets = Math.max(mostGets, gets);
            }
            gets = 0;
            return await env.BLOBS.put(key, value, options);
          },
        },
      });
      const onExport = hostWith();
      const exportId = await begun(brain, onExport);
      const ended = await ranToEnd(counting, exportId, onExport);
      const files = await partRows(brain, exportId, "documents");
      const pieces = files.flatMap(({ file, rows }) =>
        rows.flatMap((row) => {
          const piece = pieceSchema.parse(row);
          return piece.id === id || piece.continues === id
            ? [{ file, numbers: piece.versions.map(({ number }) => number) }]
            : [];
        })
      );

      expect({
        ended,
        files: new Set(pieces.map(({ file }) => file)).size > 1,
        withinReads: mostGets <= exportFileReads,
        numbers: pieces.flatMap(({ numbers }) => numbers),
      }).toStrictEqual({
        ended: "ok",
        files: true,
        withinReads: true,
        numbers: Array.from({ length: versionCount }, (_, index) => index + 1),
      });
    }
  );

  it("refuses a download a purge began during, and deletes the export", async () => {
    const { brain } = testHost();
    const plans = await newCollection(brain, "Plans");
    const plan = await writeVersion(brain, admin, {
      collection: plans,
      path: "plan.md",
      text: "# Plan\nThe route.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const onExport = hostWith();
    const exportId = await begun(brain, onExport);
    const ended = await ranToEnd(brain, exportId, onExport);
    // As the bucket hands over the file, a purge begins.
    let purged = "";
    const racing = withPorts(brain, {
      blobs: {
        delete: env.BLOBS.delete.bind(env.BLOBS),
        head: env.BLOBS.head.bind(env.BLOBS),
        list: env.BLOBS.list.bind(env.BLOBS),
        put: env.BLOBS.put.bind(env.BLOBS),
        get: async (key, options) => {
          const object = await env.BLOBS.get(key, options);
          if (purged === "" && key.startsWith(`exports/${exportId}/`)) {
            purged = await blockedPurge(brain, plan.id);
          }
          return object;
        },
      },
    });
    const downloaded = await outcome(
      (async () =>
        await new Response(
          await exportFile(racing, admin, exportId, "collections-0001.jsonl")
        ).text())()
    );

    const audited = await env.BRAIN.prepare(
      "SELECT event FROM audit_outbox WHERE instr(event, ?) > 0 AND instr(event, 'knowledge.export.downloaded') > 0"
    )
      .bind(exportId)
      .all();
    expect({
      ended,
      purged,
      downloaded,
      state: await stateOf(brain, exportId),
      left: await objectsOf(exportId),
      // Its audit, as stored, says no download happened.
      downloadsAudited: audited.results.length,
    }).toStrictEqual({
      ended: "ok",
      purged: "Error: The host's copies are out of reach",
      downloaded: "knowledge.not_found",
      state: "failed",
      left: [],
      downloadsAudited: 0,
    });
    // Finished, as its host's copies come back in reach: exports may run.
    const input = {
      type: "content",
      documentIds: [plan.id],
      terms: ["route"],
      reason: "erasure_request",
    };
    const again = await preparePurge(brain, admin, input, noCopies);
    await purge(brain, admin, input, again.token, noCopies);
  });

  // Runs last: what it writes is large, and goes once it has run.
  it(
    "splits each of the Brain's parts across files once it outgrows one, losing and repeating no row",
    { timeout: 120_000 },
    async () => {
      const { brain } = testHost();
      const big = "x".repeat(1_000_000);
      const many = 9;
      // Collections and memory records: few, each near a megabyte.
      const collectionIds = Array.from({ length: many }, () =>
        crypto.randomUUID()
      );
      for (const id of collectionIds) {
        // oxlint-disable-next-line no-await-in-loop -- one after another
        await ensureCollection(
          brain,
          {
            id,
            name: `Shelf ${id}`,
            description: big,
            owner: "owner",
            access: "everyone",
            sensitive: false,
            source: "here",
            createdAt: new Date(),
          },
          admin.actor
        );
      }
      const now = new Date();
      const memoryIds = Array.from({ length: many }, () => crypto.randomUUID());
      for (const id of memoryIds) {
        // oxlint-disable-next-line no-await-in-loop -- one after another
        await brain.db.insert(brainMemories).values({
          id,
          revision: 1,
          scope: "company",
          scopeId: null,
          ownerId: "owner",
          kind: "fact",
          statement: big,
          sourceRefs: "[]",
          state: "accepted",
          indexingState: "pending",
          recordedAt: now,
          updatedAt: now,
        });
      }
      // Erasure records: many, each small, as they are.
      const evidence = 90_000;
      await env.BRAIN.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(evidence)})
       INSERT INTO brain_erased_evidence (evidence_id, erased_at)
       SELECT 'split-evidence-' || printf('%08d', i), ? FROM n`
      )
        .bind(now.getTime())
        .run();
      try {
        const onExport = hostWith();
        const exportId = await begun(brain, onExport);
        const ended = await ranToEnd(brain, exportId, onExport);
        const idsIn = async (
          prefix: string,
          field: string,
          among: Set<string>
        ) => {
          const files = await partRows(brain, exportId, prefix);
          const ids = files.flatMap(({ rows }) =>
            rows.flatMap((row) => {
              const id = z.record(z.string(), z.unknown()).parse(row)[field];
              return typeof id === "string" && among.has(id) ? [id] : [];
            })
          );
          return {
            files: files.length > 1,
            once: ids.length === among.size && new Set(ids).size === among.size,
          };
        };
        const evidenceIds = new Set(
          Array.from(
            { length: evidence },
            (_, at) => `split-evidence-${String(at + 1).padStart(8, "0")}`
          )
        );

        expect({
          ended,
          whole: await whole(brain, exportId),
          collections: await idsIn("collections", "id", new Set(collectionIds)),
          memories: await idsIn("memories", "id", new Set(memoryIds)),
          erasures: await idsIn("erasures", "evidenceId", evidenceIds),
        }).toStrictEqual({
          ended: "ok",
          whole: true,
          collections: { files: true, once: true },
          memories: { files: true, once: true },
          erasures: { files: true, once: true },
        });
      } finally {
        await env.BRAIN.prepare(
          "DELETE FROM brain_erased_evidence WHERE evidence_id LIKE 'split-evidence-%'"
        ).run();
        await brain.db
          .delete(brainMemories)
          .where(inArray(brainMemories.id, memoryIds));
        await brain.db
          .delete(collectionsTable)
          .where(inArray(collectionsTable.id, collectionIds));
      }
    }
  );
});
