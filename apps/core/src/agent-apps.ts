import type {
  App,
  AppExports,
  AppFiles,
  AppVersion,
} from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { operationErrors } from "@grasp-os/shared/operations";
import type { Permission } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import { asPerson, readDenied } from "./agent-person.ts";
import { admitEffect, chatAuthority, chatContext } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { callAppFunction } from "./app-functions.ts";
import type { FunctionAnswer } from "./app-functions.ts";
import { cancelRequest, requestText } from "./app-requests.ts";
import {
  appExports,
  appFor,
  findApp,
  listApps,
  listVersions,
  readFiles,
} from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { appsCollectionId } from "./knowledge/app-entries.ts";
import { grantedPermissions } from "./permissions.ts";
import { isRestricted, restrict } from "./restricted.ts";
import { inTurn, runSessionOf } from "./run-sessions.ts";

// Apps for a chat's code: `await env.apps.list()`. What the chat's person
// sees of Apps themselves (agent-person.ts), once the agent may read the
// Apps collection, where agents find the Apps that already exist before
// anyone builds another (knowledge/apps-collection.ts): the Apps the
// person has a role in, and the files and versions of those they build.
// Every call is audited as the chat's agent acting for them.

/** Whether the agent may read the Apps collection, and so look into Apps. */
const readsApps = (permissions: Permission[]): boolean =>
  permissions.some(
    ({ object, actions }) =>
      object.type === "collection" &&
      object.collectionId === appsCollectionId &&
      actions.includes("read")
  );

/**
 * How long a chat's code waits for one of an App's functions: as long as a
 * screen does.
 */
const functionCallMs = 30_000;

/** What a call's kind needs of the agent's permission on the App. */
const actionFor = (kind: string): "read" | "write" =>
  kind === "query" ? "read" : "write";

/** Whether the agent holds `action` on App `app` (an `app` permission). */
const callsApp =
  (app: string, action: "read" | "write") =>
  (permissions: Permission[]): boolean =>
    permissions.some(
      ({ object, actions }) =>
        object.type === "app" &&
        object.appId === app &&
        actions.includes(action)
    );

/** The kind a request names, read only for the permission it needs. */
const requestKindSchema = z.looseObject({
  reference: z.looseObject({ kind: z.enum(["query", "mutation", "action"]) }),
});

/** Apps, as a chat's code reads them. */
export class AppsApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The Apps the person has a role in, oldest first. */
  async list(): Promise<App[]> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: readsApps,
      method: "apps.list",
      read: async (person) => await listApps(this.env, person),
      detail: (listed) => ({ apps: listed.length }),
    });
  }

  /** An App's files at `version`, or at its latest: for its builders. */
  async files(app: unknown, version?: unknown): Promise<AppFiles> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: readsApps,
      method: "apps.files",
      read: async (person) => await readFiles(this.env, person, app, version),
      detail: (files) => ({
        app: typeof app === "string" ? app : null,
        version: typeof version === "number" ? version : null,
        files: Object.keys(files).length,
      }),
    });
  }

  /**
   * What an App's current version exports to other Apps (the methods they
   * may call under a permission an admin grants): for anyone with a role
   * in it. Read only: nothing here asks for or calls one.
   */
  async exports(
    app: unknown
  ): Promise<{ version: number | null; exports: AppExports }> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: readsApps,
      method: "apps.exports",
      read: async (person) => await appExports(this.env, person, app),
      detail: (found) => ({
        app: typeof app === "string" ? app : null,
        version: found.version,
        exports: Object.keys(found.exports).length,
      }),
    });
  }

  /**
   * Calls a public function of App `app` for the chat's person (spec 32.6):
   * `request` is the call as JSON text, as a stream, bounded in bytes and
   * time before it is parsed. Needs the agent's permission on the App:
   * `read` for a query, `write` for a mutation or an action, checked once
   * the run's check passed and before the request is read (either action),
   * again for its kind once read, and again before every protected step of
   * the call, so a revoked grant stops a call already running. The person's
   * role in the App is checked by the call itself. Restricted mode follows
   * the data both ways: a restricted chat restricts the App before it can
   * write there, and a restricted App restricts the chat before its answer
   * is handed over. Every call, refused or not, is audited as `agent.call`.
   */
  async call(app: unknown, request: unknown): Promise<FunctionAnswer> {
    const id = appIdSchema.safeParse(app);
    const scope = this.ctx.props;
    let kind: string | null = null;
    return await asPerson(this.env, scope, {
      allowed: id.success
        ? (permissions) =>
            callsApp(id.data, "read")(permissions) ||
            callsApp(id.data, "write")(permissions)
        : () => false,
      method: "apps.call",
      read: async (person, permissions) => {
        const deadline = Date.now() + functionCallMs;
        // On-prem, a child of the calling run's sandbox session, which runs
        // one child at a time: the run's calls take their turns here, each
        // within its own deadline, rather than contend for it. A call waits
        // for its turn before its request is read, so calls queued behind
        // others hold none of theirs.
        const parentSession = runSessionOf(scope.runId);
        let read = false;
        try {
          return await inTurn(
            parentSession === undefined ? undefined : scope.runId,
            deadline,
            async () => {
              read = true;
              const text = await requestText(request);
              try {
                ({
                  reference: { kind },
                } = requestKindSchema.parse(JSON.parse(text)));
              } catch {
                throw operationErrors.create("contract.invalid_request");
              }
              const action = actionFor(kind);
              // The `allowed` check above passed, so the App's ID is valid.
              const appId = appIdSchema.parse(app);
              if (!callsApp(appId, action)(permissions)) {
                throw readDenied(action);
              }
              if (action === "write") {
                // Only someone with a role in the App reaches it at all, so a
                // restricted chat can't restrict an App its person can't use.
                await appFor(this.env, person, appId, "user");
                await this.#carryChatRestricted(appId);
              }
              const answer = await callAppFunction(
                this.env,
                person,
                appId,
                text,
                deadline,
                async () => {
                  // The code run still open (not ended, cancelled or closed by a
                  // revocation), and the grant for the call's kind still held.
                  await admitEffect(this.env, scope);
                  const now = await grantedPermissions(
                    this.env,
                    chatAuthority(scope)
                  );
                  if (!callsApp(appId, action)(now)) {
                    throw readDenied(action);
                  }
                },
                // On-prem, a child of the calling run's sandbox session: never
                // waiting for a process the run holds while it waits for it.
                parentSession,
                // Named on the workflows it starts, whose staged starts need
                // the agent's permission again as they are dispatched.
                {
                  agentId: scope.agentId,
                  workspaceId: scope.workspaceId,
                  chatId: scope.chatId,
                }
              );
              if (
                answer.manifestHash !== null &&
                (await appHost(this.env, appId).isRestricted())
              ) {
                await restrict(
                  this.env,
                  chatAuthority(scope),
                  chatContext(scope),
                  [`app:${appId}`]
                );
              }
              return answer;
            }
          );
        } catch (error) {
          // Refused before its turn came (the run's queue full, or its
          // deadline past while it waited): its request is never read.
          if (!read) {
            await cancelRequest(request);
          }
          throw error;
        }
      },
      detail: () => ({
        app: id.success ? id.data : null,
        kind,
      }),
      ended: ({ result }) =>
        result.ok
          ? undefined
          : {
              outcome:
                result.error.code === "internal.unexpected"
                  ? "failed"
                  : "refused",
              reason: result.error.code,
            },
    });
  }

  /**
   * Restricts App `app` when the chat is restricted, before a call that may
   * write there: its input may carry what the chat read restricted, as a
   * call between Apps carries it (app-calls.ts).
   */
  async #carryChatRestricted(app: AppId): Promise<void> {
    const scope = this.ctx.props;
    if (
      !(await isRestricted(this.env, chatAuthority(scope), chatContext(scope)))
    ) {
      return;
    }
    const { currentVersion } = await findApp(this.env, app);
    await restrict(
      this.env,
      {
        subject: { type: "app", appId: app },
        onBehalfOf: scope.personId,
        mode: "interactive",
        appVersion: currentVersion ?? undefined,
      },
      { type: "app", appId: app },
      [`chat:${scope.chatId}`]
    );
  }

  /** An App's versions, newest first: for its builders. */
  async versions(app: unknown, before?: unknown): Promise<AppVersion[]> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: readsApps,
      method: "apps.versions",
      read: async (person) => await listVersions(this.env, person, app, before),
      detail: (listed) => ({
        app: typeof app === "string" ? app : null,
        versions: listed.length,
      }),
    });
  }
}

/** What the model reads of `env.apps`. */
const appsDeclaration = `/**
 * The company's Apps that the person has a role in, and the code of those
 * they build. Before suggesting a new App, look for one that already does
 * it: search the Apps collection in Knowledge, then list them here.
 */
apps: {
  /** The Apps the person has a role in, oldest first. */
  list(): Promise<{
    id: string;
    name: string;
    description: string;
    owner: string;
    /** The version that runs; null until one is made current. */
    currentVersion: number | null;
    pendingVersion: number | null;
    createdAt: string;
  }[]>;
  /** An App's files by path, at \`version\`, or at its latest version without one. Only for Apps the person builds. */
  files(app: string, version?: number): Promise<Record<string, string>>;
  /**
   * The methods an App's current version lets other Apps call, by name, as
   * its \`app/exports.json\` declares them: whether each only reads or also
   * writes the App's data, and the JSON Schemas of its input and answer.
   * Another App calls one only once an admin grants it a permission on
   * this App's exports. Any App the person has a role in.
   */
  exports(app: string): Promise<{
    /** The current version; null (and no exports) while it has none. */
    version: number | null;
    exports: Record<string, {
      access: "read" | "write";
      description: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    }>;
  }>;
  /**
   * Calls a public function (query, mutation or action) of an App's current
   * version for the person, through a sealed reference: \`request\` is the
   * call as JSON text, \`{ reference, input, idempotencyKey? }\`, sent as a
   * stream: \`env.apps.call(app, new Blob([JSON.stringify(call)]).stream())\`.
   * At most 132 KiB, sent in full within 5 seconds. Calls made at once may run one at a time, in
   * the order made, each within its own 30 seconds, and at most 8 at once (more answer \`operation.sandbox_busy\`). Needs a permission on the App (\`read\` for a query,
   * \`write\` otherwise), granted by an admin. Answers the result as data:
   * \`{ result: { ok: true, value } | { ok: false, error }, fingerprint, manifestHash }\`.
   */
  call(app: string, request: ReadableStream<Uint8Array>): Promise<{
    result:
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string; category: string; retryable: boolean; requestId: string; details?: unknown } };
    fingerprint: string | null;
    manifestHash: string | null;
  }>;
  /** An App's versions, newest first, at most 100 before \`before\`. Only for Apps the person builds. */
  versions(app: string, before?: number): Promise<{
    version: number;
    parent: number | null;
    files: number;
    author: string;
    message: string;
    createdAt: string;
  }[]>;
};`;

/** `env.apps`. */
export const appsApi: AgentApi = {
  name: "apps",
  declaration: appsDeclaration,
  stub: (scope) => exports.AppsApi({ props: scope }),
};
