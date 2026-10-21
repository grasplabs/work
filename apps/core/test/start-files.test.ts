import {
  fileChannel,
  declaredWorkflows,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { runFileLimits } from "@grasp-os/shared/run-files";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { resultOf, runOf } from "../src/workflows/resource-runs.ts";
import { copyIntoRun, sweepRunFiles } from "../src/workflows/run-files.ts";
import { handFiles } from "../src/workflows/start-files.ts";
import type { StartFile } from "../src/workflows/start-files.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";

// A screen's start handing its run a file of the App (GRA-885; the
// threat note is on the issue): the file read as the person may read it
// now, copied into the run's own files, the run reading it by the same
// `{ id }`, and every other file, or a start that may not hand one,
// refused before any run is admitted.

const idp = mockIdp();

const files = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string() }),
});
`,
  "operations/review.ts": `import { resource, v } from "@grasp-os/sdk";

export const review = resource.workflow("review", {
  input: v.object({ doc: v.file() }),
  output: v.object({ status: v.string() }),
});
`,
  "app.ts": `import { app, resource } from "@grasp-os/sdk";
import { review } from "./operations/review.ts";
import schema from "./schema.ts";

export const attachments = resource.files("attachments", {
  operations: ["upload", "read"],
});

export default app({
  name: "Reviews",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: {},
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  uses: [attachments, review],
});
`,
  "screens/desk.tsx": `export default function Desk() {
  return <main>Reviews</main>;
}
`,
});

/** A workflow taking a file, whose run says which file it was handed. */
const definitionOf = (name: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties: {
            doc: { type: "object", "x-grasp-value": { kind: "file" } },
          },
          required: ["doc"],
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    },
    // oxlint-disable-next-line no-template-curly-in-string -- a workflow expression
    do: [{ say: { set: { status: "${ $workflow.input.doc.id }" } } }],
  });

/** Someone signed in, and as core's own calls take them. */
const signedIn = async (role: Role) => {
  const session = await signedInApi(idp, role);
  const acting: Acting & Identity = {
    userId: session.userId,
    email: z.string().parse(session.person.email),
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return { ...session, acting };
};

type Person = Awaited<ReturnType<typeof signedIn>>;

/**
 * The Reviews App sealed and current, its screen approved, `review` bound
 * to a workflow taking a file, with the App's `start` grant.
 */
const reviewsApp = async () => {
  const admin = await signedIn("admin");
  const builder = await signedIn("builder");
  const workflow = await createWorkflowResource(
    env,
    builder.acting,
    `review-${unique()}`
  );
  await publishWorkflowVersion(env, builder.acting, workflow.id, {
    definition: definitionOf(workflow.name),
    basedOn: null,
  });
  const fixture = await appWith(files(), "Reviews", builder.acting);
  await bindWorkflowToApp(env, builder.acting, workflow.id, {
    app: fixture.app,
    alias: "review",
    version: 1,
  });
  await seal(fixture);
  await setCurrentVersion(env, builder.acting, fixture.app, 1);
  const asked = await requestPermission(
    env,
    builder.acting,
    {
      subject: { type: "app", appId: fixture.app },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "REVIEW",
    },
    {
      app: async (named: string, role: "user" | "builder") =>
        await appFor(env, builder.acting, named, role),
      resource: async (ref, needed) => {
        await requireResourceRole(env, builder.acting, ref, needed);
      },
    }
  );
  await grantPermission(env, admin.acting, asked.id, { version: 1 });
  const review = await admin.api.screenTrust.review(fixture.app);
  await admin.api.screenTrust.approve(fixture.app, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const release = await loadRelease(env, fixture.app, 1);
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "review"
  );
  if (declared === undefined) {
    throw new Error("No review workflow");
  }
  return {
    admin,
    builder,
    app: fixture.app,
    workflow: workflow.id,
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: "workflows.review",
      fingerprint: await workflowFingerprint(declared),
      kind: "workflow",
    },
  };
};

/** `person`'s open screen of `app`: its lease, and its file channel. */
const screenOf = async (person: Person, app: string) => {
  const { lease } = await person.api.screens.open(app, "desk");
  const fetch = async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("origin", clientOrigin);
    headers.set("cookie", person.session);
    headers.set(screenPersonHeader, person.userId);
    return await routed(path, { ...init, headers });
  };
  const named = async () => await Promise.resolve(person.userId);
  return {
    lease,
    fetch,
    channel: fileChannel({ app, lease, person: named, fetch }),
  };
};

type Screen = Awaited<ReturnType<typeof screenOf>>;

/** A PNG's bytes: its signature, then `size` bytes in all. */
const png = (size = 64): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let at = 8; at < size; at += 1) {
    bytes[at] = at % 251;
  }
  return bytes;
};

/** Uploads `bytes` as a PNG through `screen`: its file's ID. */
const uploaded = async (
  screen: Screen,
  bytes: Uint8Array<ArrayBuffer>
): Promise<string> =>
  await screen.channel.upload(
    "attachments",
    new Blob([bytes], { type: "image/png" }),
    "scan.png",
    {
      cancel: new AbortController().signal,
      onProgress: () => {
        // Nothing to show.
      },
    }
  );

/** The screen's start of `review` with `doc`: its run's ID, or its refusal's code. */
const started = async (
  screen: Screen,
  fixture: Awaited<ReturnType<typeof reviewsApp>>,
  doc: string,
  key = crypto.randomUUID().replaceAll("-", "")
): Promise<{ runId: string } | { refused: string }> => {
  const response = await screen.fetch(`${appFunctionPath}/${fixture.app}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [screenLeaseHeader]: screen.lease,
    },
    body: JSON.stringify({
      workflow: fixture.reference,
      command: "start",
      input: { doc: { id: doc } },
      idempotencyKey: key,
    }),
  });
  const answer: unknown = await response.json();
  if (!response.ok) {
    return { refused: errorPayloadSchema.parse(answer).code };
  }
  const { result } = z
    .object({
      result: z.union([
        z.object({
          ok: z.literal(true),
          value: z.object({ runId: z.string() }),
        }),
        z.object({
          ok: z.literal(false),
          error: z.object({ code: z.string() }),
        }),
      ]),
    })
    .parse(answer);
  return result.ok
    ? { runId: result.value.runId }
    : { refused: result.error.code };
};

/** Run `runId`'s files as core keeps them. */
const runFiles = async (runId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, name, type, size, sha256, state FROM workflow_run_files WHERE run_id = ? ORDER BY created_at"
  )
    .bind(runId)
    .all<{
      id: string;
      name: string;
      type: string;
      size: number;
      sha256: string | null;
      state: string;
    }>();
  return results;
};

/** The bytes run file `fileId` holds, its chunks in order. */
const bytesOf = async (fileId: string): Promise<Uint8Array> => {
  const { results } = await env.DB.prepare(
    'SELECT key FROM workflow_run_file_chunks WHERE file_id = ? ORDER BY "index"'
  )
    .bind(fileId)
    .all<{ key: string }>();
  const parts = await Promise.all(
    results.map(async ({ key }) => {
      const object = await env.FILES.get(key);
      return object === null ? new Uint8Array() : await object.bytes();
    })
  );
  return new Uint8Array(parts.flatMap((part) => [...part]));
};

/** What run `runId` was started with and returned, once it completed. */
const endOf = async (runId: string) =>
  await vi.waitFor(
    async () => {
      const row = await runOf(env, runId);
      if (row?.status !== "completed") {
        throw new Error(`Run ${runId} is ${row?.status ?? "missing"}`);
      }
      const receipt = await env.DB.prepare(
        "SELECT input FROM workflow_start_receipts WHERE id = ?"
      )
        .bind(runId)
        .first<{ input: string }>();
      const { output } = await resultOf(env, row);
      return {
        input: z.json().parse(JSON.parse(receipt?.input ?? "null")),
        output,
      };
    },
    { timeout: 30_000, interval: 100 }
  );

describe(
  "a screen's start handing its run a file",
  { timeout: 120_000 },
  () => {
    it("copies a file the person may read into the run, which reads it by the same shape, audited once, and copies nothing more for the same start sent again", async () => {
      const fixture = await reviewsApp();
      const screen = await screenOf(fixture.builder, fixture.app);
      const bytes = png(300);
      const file = await uploaded(screen, bytes);
      const key = crypto.randomUUID().replaceAll("-", "");

      const first = await started(screen, fixture, file, key);
      const again = await started(screen, fixture, file, key);
      if (!("runId" in first)) {
        throw new Error(`Refused: ${first.refused}`);
      }
      const ended = await endOf(first.runId);
      const [kept, ...more] = await runFiles(first.runId);
      const events = await allEvents();
      const sent = events.filter(
        ({ action, target }) =>
          action === "file.sent_to_run" && target?.id === file
      );

      expect({
        again,
        ended,
        kept: {
          ...kept,
          id: kept?.id === file ? "the App's file" : "its own",
        },
        more,
        sameBytes:
          kept === undefined
            ? false
            : (await sha256HexOfBytes(await bytesOf(kept.id))) ===
              (await sha256HexOfBytes(bytes)),
        sent: sent.map(({ actor, detail }) => ({
          actor,
          run: detail?.run,
          workflow: detail?.workflow,
          uploadedBy: detail?.uploadedBy,
        })),
      }).toStrictEqual({
        again: first,
        // The run's input names its own copy, in the shape the App sent, and
        // the run read it so.
        ended: {
          input: { doc: { id: kept?.id } },
          output: { status: kept?.id },
        },
        kept: {
          id: "its own",
          name: "scan.png",
          type: "image/png",
          size: 300,
          sha256: await sha256HexOfBytes(bytes),
          state: "done",
        },
        more: [],
        sameBytes: true,
        sent: [
          {
            actor: { type: "person", userId: fixture.builder.userId },
            run: first.runId,
            workflow: fixture.workflow,
            uploadedBy: fixture.builder.userId,
          },
        ],
      });
    });

    it("refuses a file the person may not read now, or no file at all, admitting no run and keeping no copy", async () => {
      const fixture = await reviewsApp();
      const builderScreen = await screenOf(fixture.builder, fixture.app);
      // The builder's own upload, attached to nothing: theirs alone to read.
      const theirs = await uploaded(builderScreen, png(120));
      const colleague = await signedIn("user");
      await fixture.builder.api.apps.members.add(fixture.app, {
        type: "person",
        id: colleague.userId,
        role: "user",
      });
      const colleagueScreen = await screenOf(colleague, fixture.app);
      const before = await env.DB.prepare(
        "SELECT count(*) AS runs FROM workflow_resource_runs WHERE workflow_resource_id = ?"
      )
        .bind(fixture.workflow)
        .first<{ runs: number }>();

      const refused = {
        anotherPersons: await started(colleagueScreen, fixture, theirs),
        madeUp: await started(colleagueScreen, fixture, crypto.randomUUID()),
        notAnId: await started(colleagueScreen, fixture, "not-a-file"),
      };
      const after = await env.DB.prepare(
        "SELECT count(*) AS runs FROM workflow_resource_runs WHERE workflow_resource_id = ?"
      )
        .bind(fixture.workflow)
        .first<{ runs: number }>();
      const copies = await env.DB.prepare(
        "SELECT count(*) AS files FROM workflow_run_files WHERE workflow_resource_id = ? AND state <> 'deleted'"
      )
        .bind(fixture.workflow)
        .first<{ files: number }>();

      expect({
        refused,
        runs: after?.runs,
        copies: copies?.files,
      }).toStrictEqual({
        refused: {
          anotherPersons: { refused: "file.not_found" },
          madeUp: { refused: "file.not_found" },
          notAnId: { refused: "file.not_found" },
        },
        runs: before?.runs,
        copies: 0,
      });
    });

    it("refuses a file larger than a run's, and one past the run's room, before any byte is copied", async () => {
      const workflowId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const source = {
        name: "big.pdf",
        type: "application/pdf",
        size: runFileLimits.fileBytes + 1,
        chunks: [],
      };
      const tooLarge = await outcome(
        copyIntoRun(env, { runId, workflowId }, 0, source)
      );
      // The run full already: as many files as it may keep.
      await env.DB.batch(
        Array.from({ length: runFileLimits.runFiles }, (_, index) =>
          env.DB.prepare(
            "INSERT INTO workflow_run_files (id, run_id, workflow_resource_id, opened_by, open_key, name, type, size, state, created_at) VALUES (?, ?, ?, 'step', ?, 'a.txt', 'text/plain', 1, 'done', ?)"
          ).bind(
            crypto.randomUUID(),
            runId,
            workflowId,
            `full:${runId}:${index}`,
            Date.now()
          )
        )
      );
      const full = await outcome(
        copyIntoRun(env, { runId, workflowId }, 0, { ...source, size: 10 })
      );
      const objects = await env.FILES.list({ prefix: `run-files/${runId}/` });

      expect({ tooLarge, full, objects: objects.objects.length }).toStrictEqual(
        {
          tooLarge: "file.run_too_large",
          full: "file.run_full",
          objects: 0,
        }
      );
    });

    it("reads each file again once all are copied, refusing the start and dropping its copies when one was hidden meanwhile", async () => {
      const runId = crypto.randomUUID();
      const workflowId = crypto.randomUUID();
      const bytes = png(90);
      const key = `app-files/test/${crypto.randomUUID()}`;
      await env.FILES.put(key, bytes);
      const file: StartFile = {
        id: crypto.randomUUID(),
        name: "scan.png",
        type: "image/png",
        size: bytes.length,
        ownerId: "user-ada",
        chunks: [{ key, sha256: await sha256HexOfBytes(bytes) }],
      };
      let reads = 0;
      const field = {
        descriptorVersion: 1,
        nullable: false,
        presence: "required",
      } as const;
      const refused = await outcome(
        handFiles(
          env,
          {
            ...field,
            kind: "object",
            fields: { doc: { ...field, kind: "file" } },
          },
          JSON.stringify({ doc: { id: file.id } }),
          { runId, workflowId, runs: true },
          {
            // Readable as it is copied, hidden by the time it is read again.
            read: async () => {
              reads += 1;
              if (reads > 1) {
                throw new Error("file.not_found");
              }
              return await Promise.resolve(file);
            },
            sent: () => {
              throw new Error("Never audited: never admitted");
            },
          }
        )
      );

      expect({ refused, reads, kept: await runFiles(runId) }).toMatchObject({
        refused: "Error: file.not_found",
        reads: 2,
        kept: [{ state: "deleted" }],
      });
    });

    it("counts no dropped copy against the workflow's bytes, and sweeps a copy no start admitted within the hour", async () => {
      const workflowId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const other = crypto.randomUUID();
      const insert = (row: {
        openedBy: string;
        size: number;
        state: string;
        at: number;
      }) =>
        env.DB.prepare(
          "INSERT INTO workflow_run_files (id, run_id, workflow_resource_id, opened_by, open_key, name, type, size, state, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, 'a.txt', 'text/plain', ?, ?, ?, ?)"
        ).bind(
          crypto.randomUUID(),
          other,
          workflowId,
          row.openedBy,
          `${row.openedBy}:${crypto.randomUUID()}`,
          row.size,
          row.state,
          row.at,
          row.state === "deleted" ? row.at : null
        );
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      await env.DB.batch([
        // A dropped copy as large as the workflow's whole quota.
        insert({
          openedBy: `start:${other}`,
          size: runFileLimits.workflowBytes,
          state: "deleted",
          at: Date.now(),
        }),
        // A copy no start admitted, and a task's file, both two hours old.
        insert({
          openedBy: `start:${other}`,
          size: 1,
          state: "writing",
          at: twoHoursAgo,
        }),
        insert({
          openedBy: `${other}:task:write`,
          size: 1,
          state: "writing",
          at: twoHoursAgo,
        }),
      ]);
      const bytes = png(70);
      const key = `app-files/test/${crypto.randomUUID()}`;
      await env.FILES.put(key, bytes);
      const copied = await outcome(
        copyIntoRun(env, { runId, workflowId }, 0, {
          name: "scan.png",
          type: "image/png",
          size: bytes.length,
          chunks: [{ key, sha256: await sha256HexOfBytes(bytes) }],
        })
      );
      await sweepRunFiles(env);
      const { results } = await env.DB.prepare(
        "SELECT opened_by, state FROM workflow_run_files WHERE run_id = ? AND size = 1 ORDER BY opened_by"
      )
        .bind(other)
        .all<{ opened_by: string; state: string }>();

      expect({
        copied,
        swept: results.map(({ opened_by: by, state }) => [
          by.startsWith("start:") ? "start copy" : "task file",
          state,
        ]),
      }).toStrictEqual({
        copied: "ok",
        swept: [
          ["task file", "writing"],
          ["start copy", "deleted"],
        ],
      });
    });
  }
);
