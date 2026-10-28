import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { createBrain } from "../src/brain.ts";
import type { Brain } from "../src/brain.ts";
import { writeVersion } from "../src/documents.ts";
import {
  advanceExport,
  exportFile,
  exportLeaseMs,
  exportStatus,
  manifestName,
  prepareExport,
  startExport,
} from "../src/exports.ts";
import type { HostExportFile, OnExport } from "../src/exports.ts";
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
const hostWith = (files: () => HostExportFile[] = () => []): OnExport => ({
  excluded: [],
  files: async () => await Promise.resolve(files()),
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

/** `exportId` advanced until it is complete or refuses. */
const ranToEnd = async (
  brain: Brain<Caller>,
  exportId: string,
  onExport: OnExport
): Promise<string> =>
  await outcome(
    advanceExport(
      brain,
      exportId,
      onExport,
      new Date(brain.ports.clock().getTime() + 60_000)
    )
  );

/** File `name` of a complete export, as text. */
const fileText = async (
  brain: Brain<Caller>,
  exportId: string,
  name: string
): Promise<string> =>
  await new Response(await exportFile(brain, admin, exportId, name)).text();

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
    const listed = await fileText(brain, exportId, "collections.jsonl");
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

  it("writes the host's files again, all from one ask, after a run stopped among them", async () => {
    const { brain } = testHost();
    await newCollection(brain, "Plans");
    let asked = 0;
    const onExport = hostWith(() => {
      asked += 1;
      return asked === 1
        ? [
            { name: "grants", rows: [{ ask: 1 }] },
            { name: "teams", rows: [{ ask: 1 }] },
          ]
        : [{ name: "grants", rows: [{ ask: 2 }] }];
    });
    // The first run stops among the host's files: its second upload never
    // ends, as a run whose isolate went away.
    let stopped = false;
    const cut = withPorts(brain, {
      blobs: {
        delete: env.BLOBS.delete.bind(env.BLOBS),
        get: env.BLOBS.get.bind(env.BLOBS),
        head: env.BLOBS.head.bind(env.BLOBS),
        list: env.BLOBS.list.bind(env.BLOBS),
        put: async (key, value, options) => {
          if (key.endsWith("-host-teams.jsonl")) {
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
    const files = await checked(brain, exportId);

    expect({
      ended,
      whole: files.every(({ matches }) => matches),
      hostFiles: files
        .map(({ name }) => name)
        .filter((name) => name.startsWith("host-")),
      hosted: await fileText(brain, exportId, "hosted.jsonl"),
      grants: await fileText(brain, exportId, "host-grants.jsonl"),
    }).toStrictEqual({
      ended: "ok",
      whole: true,
      // The second ask's alone: none of the first's left beside it.
      hostFiles: ["host-grants.jsonl"],
      hosted: `${JSON.stringify({ name: "host-grants.jsonl" })}\n`,
      grants: `${JSON.stringify({ ask: 2 })}\n`,
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
          if (key.endsWith("-memories.jsonl")) {
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
    const onExport = hostWith(() => [{ name: "grants", rows: [{ a: 1 }] }]);
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
});
