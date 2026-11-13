import { agentIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { runFileContentPath } from "@grasp-os/shared/run-files";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createWorkflowResource,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { StartInvoker } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import { sweepGraceMs } from "../src/workflows/run-files.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { startFilesOf } from "./run-file-starts.ts";
import {
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// Downloading a run's finished files from its run sheet (GRA-1306), from
// its threat model (workflows/run-file-downloads.ts): through core's own route only, for the run's person
// and, unless the run is restricted, the organization's admins; nobody
// else, and no file but a finished one of that run, while its details
// last; only from the page itself; always an attachment of its checked
// type that runs nothing; each chunk's bytes as written; and each
// download audited once a day, never with the file's name.

const idp = mockIdp();

/** The file a run is handed: Markdown holding HTML, under a name claiming HTML. */
const written = '# Notes\n\n<script>alert("x")</script>\n';

/** The most bytes one chunk of a file holds. */
const chunkBytes = 512 * 1024;

/** A workflow taking a file, whose run says which file it was handed. */
const definition = JSON.stringify({
  $schema: workflowSchemaUrl,
  args: { kind: "object", fields: { doc: { kind: "file" } } },
  returns: { kind: "object", fields: { status: { kind: "string" } } },
  result: { status: { $expr: "args.doc.id" } },
  steps: [],
});

/** Someone signed in with `role`: their session, and as core takes them. */
const member = async (role: Role) => {
  const session = await signedInApi(idp, role);
  const identity: Identity = {
    userId: session.userId,
    email: String(session.person.email),
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return { ...session, identity };
};

type Member = Awaited<ReturnType<typeof member>>;

/** A workflow of `builder`'s whose runs are each handed one file. */
const filesWorkflow = async (builder: Member) => {
  const workflow = await createWorkflowResource(
    env,
    builder.identity,
    `files-${unique()}`
  );
  await publishDefinition(env, builder.identity, workflow.id, definition);
  return workflow.id;
};

/** The bytes of `size`, in chunks of at most 512 KiB, as a file's are stored. */
const chunksOf = (size: number): Uint8Array[] => {
  const bytes = new TextEncoder().encode("a".repeat(size));
  return Array.from({ length: Math.ceil(size / chunkBytes) }, (_, at) =>
    bytes.subarray(at * chunkBytes, (at + 1) * chunkBytes)
  );
};

/** Runs workflow `id` once for `by` (or as `invoker`), to its end: the run and its file. */
const ranOnce = async (
  by: Member,
  id: string,
  invoker?: StartInvoker,
  /** How many bytes the file holds, or none for `written`. */
  size = 0
): Promise<{ run: string; file: string }> => {
  const handed = await startFilesOf({
    name: "notes.html",
    type: "text/markdown",
    chunks: size === 0 ? [new TextEncoder().encode(written)] : chunksOf(size),
  });
  const { runId } = await startWorkflow(
    env,
    invoker ?? { type: "person", person: by.identity },
    id,
    { version: 1, args: { doc: { id: handed.id } }, key: unique() },
    undefined,
    undefined,
    undefined,
    handed.files
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  const run = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by.identity, id, runId);
      expect(read.status).toBe("completed");
      return read;
    },
    { timeout: 60_000, interval: 100 }
  );
  const { status } = z.object({ status: z.string() }).parse(run.result);
  return { run: runId, file: status };
};

/** A download, as the run sheet's link asks for it, by `session`. */
const download = async (
  session: string | null,
  path: string,
  site: string | null = "same-origin"
): Promise<Response> =>
  await routed(path, {
    headers: {
      ...(session === null ? {} : { cookie: session }),
      ...(site === null ? {} : { "sec-fetch-site": site }),
    },
  });

/** A download's status, as `download` asks. */
const statusOf = async (
  ...args: Parameters<typeof download>
): Promise<number> => {
  const response = await download(...args);
  return response.status;
};

/** What a download answers: its status, and its body once read whole, or why not. */
const answerOf = async (response: Response) => ({
  status: response.status,
  body: response.ok ? await outcome(response.text()) : undefined,
});

/** The downloads of file `file` the audit log holds. */
const downloadsOf = async (file: string) => {
  const events = await allEvents();
  return events.filter(
    (event) =>
      event.action === "workflow.file.downloaded" && event.detail?.file === file
  );
};

/** A restricted start of workflow `id` by `by`'s agent: a start naming no chat. */
const agentOf = async (
  by: Member,
  admin: Member,
  id: string
): Promise<StartInvoker> => {
  const agentId = agentIdSchema.parse(`agent-${unique()}`);
  const asked = await requestPermission(
    env,
    by.identity,
    {
      subject: { type: "agent", agentId },
      object: { type: "workflow", workflowId: id },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
    } satisfies PermissionRequest,
    {
      app: async (named: string, role: "user" | "builder") =>
        await appFor(env, by.identity, named, role),
      resource: async (
        ref: Parameters<typeof requireResourceRole>[2],
        needed: Parameters<typeof requireResourceRole>[3]
      ) => {
        await requireResourceRole(env, by.identity, ref, needed);
      },
    }
  );
  await grantPermission(env, admin.identity, asked.id, { version: null });
  return {
    type: "agent",
    authority: {
      subject: { type: "agent", agentId },
      onBehalfOf: by.userId,
      mode: "interactive",
    },
  };
};

describe(
  "a run's files, downloaded from its run sheet",
  { timeout: 120_000 },
  () => {
    it("go to the run's person and an admin, as an attachment of their checked type that runs nothing, audited once a day per reader without the name", async () => {
      const [admin, ada] = await Promise.all([
        member("admin"),
        member("builder"),
      ]);
      const id = await filesWorkflow(ada);
      const { run, file } = await ranOnce(ada, id);
      const path = runFileContentPath(id, run, file);

      const own = await download(ada.session, path);
      const headers = Object.fromEntries(
        [
          "content-type",
          "content-disposition",
          "content-length",
          "cache-control",
          "x-content-type-options",
          "content-security-policy",
          "cross-origin-resource-policy",
        ].map((name) => [name, own.headers.get(name)])
      );
      const ownBody = await own.text();
      const byAdmin = await answerOf(await download(admin.session, path));
      // Again the same day: still one event each.
      const again = await download(ada.session, path);
      await again.text();
      const events = await downloadsOf(file);
      expect({
        status: own.status,
        headers,
        ownBody,
        byAdmin,
        audited: events
          .map(({ actor, target, detail }) => ({
            actor,
            target,
            run: detail?.run,
            type: detail?.type,
            size: detail?.size,
            as: detail?.as,
          }))
          .toSorted((one, other) =>
            JSON.stringify(one).localeCompare(JSON.stringify(other))
          ),
        named: JSON.stringify(events).includes("notes"),
      }).toStrictEqual({
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          // Saved under its type's extension, whatever its name claims.
          "content-disposition":
            "attachment; filename=\"notes.html.md\"; filename*=UTF-8''notes.html.md",
          "content-length": String(
            new TextEncoder().encode(written).byteLength
          ),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cross-origin-resource-policy": "same-origin",
        },
        ownBody: written,
        byAdmin: { status: 200, body: "ok" },
        audited: [
          { reader: admin, as: "admin" },
          { reader: ada, as: "person" },
        ]
          .map(({ reader, as }) => ({
            actor: { type: "person", userId: reader.userId },
            target: { type: "workflow_resource", id },
            run,
            type: "text/markdown",
            size: new TextEncoder().encode(written).byteLength,
            as,
          }))
          .toSorted((one, other) =>
            JSON.stringify(one).localeCompare(JSON.stringify(other))
          ),
        named: false,
      });
    });

    it("go to nobody else: not another member who sees the run, staff, someone signed out or another site, nor a restricted run's to an admin", async () => {
      const [admin, ada, bob, carol] = await Promise.all([
        member("admin"),
        member("builder"),
        member("user"),
        member("builder"),
      ]);
      const id = await filesWorkflow(ada);
      await shareWorkflowResource(env, ada.identity, id, {
        type: "person",
        id: bob.userId,
        role: "user",
      });
      await shareWorkflowResource(env, ada.identity, id, {
        type: "person",
        id: carol.userId,
        role: "builder",
      });
      const { run, file } = await ranOnce(ada, id);
      const path = runFileContentPath(id, run, file);
      const restricted = await ranOnce(ada, id, await agentOf(ada, admin, id));
      const restrictedPath = runFileContentPath(
        id,
        restricted.run,
        restricted.file
      );
      const staff = await signedIn(idp, "grasp-staff", staffPerson());
      const adaListed = await ada.api.workflowResources.runFiles(id, run);
      const { core: staffCore } = await openRpc(staff);
      const staffApi = staffCore.authenticate();
      const staffListed = await outcome(
        staffApi.workflowResources.runFiles(id, run)
      );

      expect({
        // A user of the workflow, not the run's person: the run isn't theirs.
        user: await statusOf(bob.session, path),
        // A builder who isn't an admin: sees the run, not its files.
        builder: await statusOf(carol.session, path),
        // Staff aren't signed in to the workspace at all.
        staff: await statusOf(staff, path),
        signedOut: await statusOf(null, path),
        crossSite: await statusOf(ada.session, path, "cross-site"),
        sameSite: await statusOf(ada.session, path, "same-site"),
        // No `Sec-Fetch-Site` at all: not from the page.
        unsaid: await statusOf(ada.session, path, null),
        // A restricted run's file: its person alone.
        restrictedOwn: await statusOf(ada.session, restrictedPath),
        restrictedAdmin: await statusOf(admin.session, restrictedPath),
        // Listed on the run sheet as for the download.
        listed: {
          ada: adaListed?.map(({ id: listedId, name, type }) => ({
            listedId,
            name,
            type,
          })),
          carol: await carol.api.workflowResources.runFiles(id, run),
          bob: await outcome(bob.api.workflowResources.runFiles(id, run)),
          restrictedAdmin: await admin.api.workflowResources.runFiles(
            id,
            restricted.run
          ),
          // Staff reach nothing in the workspace, its runs' files included.
          staff: staffListed,
        },
      }).toStrictEqual({
        user: 404,
        builder: 404,
        staff: 401,
        signedOut: 401,
        crossSite: 403,
        sameSite: 403,
        unsaid: 403,
        restrictedOwn: 200,
        restrictedAdmin: 404,
        listed: {
          ada: [{ listedId: file, name: "notes.html", type: "text/markdown" }],
          carol: null,
          bob: "workflow.run_unavailable",
          restrictedAdmin: null,
          staff: "role.forbidden",
        },
      });
    });

    it("serve only a finished file of that run while its details last, and end a download whose stored bytes changed", async () => {
      const ada = await member("builder");
      const id = await filesWorkflow(ada);
      const first = await ranOnce(ada, id);
      const second = await ranOnce(ada, id);
      const adaGets = async (path: string) => await statusOf(ada.session, path);

      // Another run's file under this run, and under another workflow.
      const crossed = await adaGets(
        runFileContentPath(id, first.run, second.file)
      );
      const otherWorkflow = await adaGets(
        runFileContentPath(crypto.randomUUID(), first.run, first.file)
      );
      // A chunk changed in R2: the bytes never arrive.
      const { key } = (await env.DB.prepare(
        "SELECT key FROM workflow_run_file_chunks WHERE file_id = ?"
      )
        .bind(second.file)
        .first<{ key: string }>()) ?? { key: "" };
      await env.FILES.put(key, written.replace("Notes", "Nates"));
      const tampered = await answerOf(
        await download(
          ada.session,
          runFileContentPath(id, second.run, second.file)
        )
      );
      // Being written again, then deleted, then the run's details gone.
      const path = runFileContentPath(id, first.run, first.file);
      const before = await adaGets(path);
      await env.DB.prepare(
        "UPDATE workflow_run_files SET state = 'writing' WHERE id = ?"
      )
        .bind(first.file)
        .run();
      const writing = await adaGets(path);
      await env.DB.prepare(
        "UPDATE workflow_run_files SET state = 'deleted' WHERE id = ?"
      )
        .bind(first.file)
        .run();
      const deleted = await adaGets(path);
      await env.DB.prepare(
        "UPDATE workflow_run_files SET state = 'done' WHERE id = ?"
      )
        .bind(first.file)
        .run();
      // Its details swept past their retention: the file is marked too,
      // and set back here, so the run's details alone keep it.
      const now = new Date();
      await sweepWorkflowStartDetails(
        env,
        new Date(now.getTime() + 1000),
        new Date(now.getTime() - 2 * sweepGraceMs)
      );
      await env.DB.prepare(
        "UPDATE workflow_run_files SET state = 'done' WHERE id = ?"
      )
        .bind(first.file)
        .run();
      const removed = await adaGets(path);

      expect({
        crossed,
        otherWorkflow,
        tampered: { status: tampered.status, read: tampered.body !== "ok" },
        before,
        writing,
        deleted,
        removed,
      }).toStrictEqual({
        crossed: 404,
        otherWorkflow: 404,
        tampered: { status: 200, read: true },
        before: 200,
        writing: 404,
        deleted: 404,
        removed: 404,
      });
    });

    it("stop a download partway, before the next chunk, once its reader loses access, the file is deleted or the run's details go", async () => {
      const [admin, ada] = await Promise.all([
        member("admin"),
        member("builder"),
      ]);
      const id = await filesWorkflow(ada);
      // Three chunks.
      const size = 2 * chunkBytes + 7;
      /** A download by `reader` of a new run's file, `meanwhile` done after its first chunk. */
      const partway = async (
        reader: Member,
        meanwhile: (made: { run: string; file: string }) => Promise<unknown>
      ) => {
        const made = await ranOnce(ada, id, undefined, size);
        const chunks = await env.DB.prepare(
          "SELECT count(*) AS n FROM workflow_run_file_chunks WHERE file_id = ?"
        )
          .bind(made.file)
          .first<number>("n");
        const response = await download(
          reader.session,
          runFileContentPath(id, made.run, made.file)
        );
        const body: ReadableStream<Uint8Array> | null = response.body;
        const stream = body?.getReader();
        const first = await stream?.read();
        await meanwhile(made);
        const rest = await outcome(
          (async () => {
            let read = 0;
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- one chunk after another
              const next = await stream?.read();
              if (next === undefined || next.done) {
                return read;
              }
              read += next.value.byteLength;
            }
          })()
        );
        return {
          chunks,
          status: response.status,
          first: first?.value?.byteLength,
          rest,
        };
      };
      const stopped = {
        chunks: 3,
        status: 200,
        first: chunkBytes,
        rest: "file.not_found",
      };

      expect({
        // Deleted while it came.
        deleted: await partway(ada, async ({ file }) => {
          await env.DB.prepare(
            "UPDATE workflow_run_files SET state = 'deleted', deleted_at = ? WHERE id = ?"
          )
            .bind(Date.now(), file)
            .run();
        }),
        // The run's details swept past their retention while it came.
        swept: await partway(ada, async () => {
          const now = new Date();
          await sweepWorkflowStartDetails(
            env,
            new Date(now.getTime() + 1000),
            new Date(now.getTime() - 2 * sweepGraceMs)
          );
        }),
        // No longer an admin: the run isn't theirs, so its files aren't
        // either. Last, as it changes who reads.
        revoked: await partway(admin, async () => {
          await env.DB.prepare(
            "UPDATE members SET role = 'user' WHERE user_id = ?"
          )
            .bind(admin.userId)
            .run();
        }),
      }).toStrictEqual({ deleted: stopped, swept: stopped, revoked: stopped });
    });

    it("hold back a chunk whose reader loses access, or whose file is deleted or details go, while it is read from storage", async () => {
      const [admin, ada] = await Promise.all([
        member("admin"),
        member("builder"),
      ]);
      const id = await filesWorkflow(ada);
      /** A download by `reader` of a new run's one-chunk file, `meanwhile` done as storage reads it. */
      const whileRead = async (
        reader: Member,
        meanwhile: (made: { run: string; file: string }) => Promise<unknown>
      ) => {
        const made = await ranOnce(ada, id);
        // Storage answers only once `meanwhile` is done: the change lands
        // after every check before the read, and before the bytes go out.
        const files = new Proxy(env.FILES, {
          get: (target, property) => {
            if (property === "get") {
              return async (key: string) => {
                const object = await target.get(key);
                await meanwhile(made);
                return object;
              };
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
        const response = await routed(
          runFileContentPath(id, made.run, made.file),
          {
            headers: {
              cookie: reader.session,
              "sec-fetch-site": "same-origin",
            },
          },
          { ...env, FILES: files }
        );
        return {
          status: response.status,
          body: await outcome(response.text()),
        };
      };
      const refused = { status: 200, body: "file.not_found" };

      expect({
        deleted: await whileRead(ada, async ({ file }) => {
          await env.DB.prepare(
            "UPDATE workflow_run_files SET state = 'deleted', deleted_at = ? WHERE id = ?"
          )
            .bind(Date.now(), file)
            .run();
        }),
        // The run's details past their retention: the file has expired.
        expired: await whileRead(ada, async () => {
          const now = new Date();
          await sweepWorkflowStartDetails(
            env,
            new Date(now.getTime() + 1000),
            new Date(now.getTime() - 2 * sweepGraceMs)
          );
        }),
        // Last, as it changes who reads.
        revoked: await whileRead(admin, async () => {
          await env.DB.prepare(
            "UPDATE members SET role = 'user' WHERE user_id = ?"
          )
            .bind(admin.userId)
            .run();
        }),
      }).toStrictEqual({
        deleted: refused,
        expired: refused,
        revoked: refused,
      });
    });
  }
);
