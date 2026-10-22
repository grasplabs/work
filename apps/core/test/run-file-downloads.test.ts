/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { agentIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { runFileContentPath } from "@grasp-os/shared/run-files";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { StartInvoker } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import { sweepGraceMs } from "../src/workflows/run-files.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Downloading a run's finished files from its run page (GRA-888), from
// its threat note: through core's own route only, for the run's person
// and, unless the run is restricted, the organization's admins; nobody
// else, and no file but a finished one of that run, while its details
// last; only from the page itself; always an attachment of its checked
// type that runs nothing; each chunk's bytes as written; and each
// download audited once a day, never with the file's name.

const idp = mockIdp();

/** The file the run writes: Markdown holding HTML, under a name claiming HTML. */
const written = '# Notes\n\n<script>alert("x")</script>\n';

const filesModule = `import { action, resource, v } from "@grasp-os/sdk/action";

const files = resource.files("files", { operations: ["write"] });

export const writeFile = action({
  args: { size: v.number() },
  returns: v.object({ status: v.string() }),
  uses: [files],
  handler: async (ctx, args) => {
    const done = await ctx.resources.files.write({
      name: "notes.html",
      type: "text/markdown",
      content: args.size === 0 ? ${JSON.stringify(written)} : "a".repeat(args.size),
    });
    return { status: done.file };
  },
});
`;

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

const definitionOf = (name: string, key: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: {
            writeFile: {
              kind: "operation",
              contract: "local:code/files.ts#writeFile",
            },
            files: { kind: "files", contract: key },
          },
        },
      },
    },
    input: { schema: objectSchema({ size: { type: "number" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        write: {
          call: "grasp.operation",
          with: {
            binding: "writeFile",
            arguments: { size: "${ $workflow.input.size }" },
          },
        },
      },
    ],
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

/** A workflow of `builder`'s that writes one file, its files binding approved. */
const filesWorkflow = async (builder: Member, admin: Member) => {
  const key = `files-${unique()}`;
  await publishCatalogContract(env, admin.identity, { key, kind: "files" });
  const workflow = await createWorkflowResource(
    env,
    builder.identity,
    `files-${unique()}`
  );
  await publishWorkflowVersion(env, builder.identity, workflow.id, {
    definition: definitionOf(workflow.name, key),
    basedOn: null,
    modules: { "code/files.ts": filesModule },
  });
  await approveWorkflowBinding(env, admin.identity, workflow.id, {
    alias: "files",
    target: { kind: "files" },
    reviewed: { version: 1 },
  });
  return workflow.id;
};

/** Runs workflow `id` once for `by` (or as `invoker`), to its end: the run and its file. */
const ranOnce = async (
  by: Member,
  id: string,
  invoker?: StartInvoker,
  /** How many bytes the file holds, or none for `written`. */
  size = 0
): Promise<{ run: string; file: string }> => {
  const { runId } = await startWorkflow(
    env,
    invoker ?? { type: "person", person: by.identity },
    id,
    { version: 1, input: { size }, key: unique() }
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
  const { status } = z.object({ status: z.string() }).parse(run.output);
  return { run: runId, file: status };
};

/** A download, as the run page's link asks for it, by `session`. */
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
  "a run's files, downloaded from its run page",
  { timeout: 120_000 },
  () => {
    it("go to the run's person and an admin, as an attachment of their checked type that runs nothing, audited once a day without the name", async () => {
      const [admin, ada] = await Promise.all([
        member("admin"),
        member("builder"),
      ]);
      const id = await filesWorkflow(ada, admin);
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
        audited: [admin, ada]
          .map((reader) => ({
            actor: { type: "person", userId: reader.userId },
            target: { type: "workflow_resource", id },
            run,
            type: "text/markdown",
            size: new TextEncoder().encode(written).byteLength,
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
      const id = await filesWorkflow(ada, admin);
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
      const staffListed = await staffApi.workflowResources.runFiles(id, run);

      expect({
        // A user of the workflow, not the run's person: the run isn't theirs.
        user: await statusOf(bob.session, path),
        // A builder who isn't an admin: sees the run, not its files.
        builder: await statusOf(carol.session, path),
        staff: await statusOf(staff, path),
        signedOut: await statusOf(null, path),
        crossSite: await statusOf(ada.session, path, "cross-site"),
        sameSite: await statusOf(ada.session, path, "same-site"),
        // No `Sec-Fetch-Site` at all: not from the page.
        unsaid: await statusOf(ada.session, path, null),
        // A restricted run's file: its person alone.
        restrictedOwn: await statusOf(ada.session, restrictedPath),
        restrictedAdmin: await statusOf(admin.session, restrictedPath),
        // Listed on the run page as for the download.
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
          // Staff see the run, never its files.
          staff: staffListed,
        },
      }).toStrictEqual({
        user: 404,
        builder: 404,
        staff: 404,
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
          staff: null,
        },
      });
    });

    it("serve only a finished file of that run while its details last, and end a download whose stored bytes changed", async () => {
      const [admin, ada] = await Promise.all([
        member("admin"),
        member("builder"),
      ]);
      const id = await filesWorkflow(ada, admin);
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

    it("stop a download whose reader loses access partway, before the next chunk", async () => {
      const [admin, ada] = await Promise.all([
        member("admin"),
        member("builder"),
      ]);
      const id = await filesWorkflow(ada, admin);
      // Three chunks: a call writes at most 512 KiB.
      const size = 1024 * 1024 + 7;
      const { run, file } = await ranOnce(ada, id, undefined, size);
      const chunks = await env.DB.prepare(
        "SELECT count(*) AS n FROM workflow_run_file_chunks WHERE file_id = ?"
      )
        .bind(file)
        .first<number>("n");
      const response = await download(
        admin.session,
        runFileContentPath(id, run, file)
      );
      const body: ReadableStream<Uint8Array> | null = response.body;
      const reader = body?.getReader();
      const first = await reader?.read();
      // No longer an admin: the run isn't theirs, so its files aren't either.
      await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
        .bind(admin.userId)
        .run();
      const rest = await outcome(
        (async () => {
          let read = 0;
          for (;;) {
            // oxlint-disable-next-line no-await-in-loop -- one chunk after another
            const next = await reader?.read();
            if (next === undefined || next.done) {
              return read;
            }
            read += next.value.byteLength;
          }
        })()
      );

      expect({
        chunks,
        status: response.status,
        first: first?.value?.byteLength,
        rest,
      }).toStrictEqual({
        chunks: 3,
        status: 200,
        first: 512 * 1024,
        rest: "file.not_found",
      });
    });
  }
);
