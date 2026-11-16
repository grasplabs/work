import { agentErrors } from "@grasp-os/shared/agent";
import type { App, AppFiles, AppVersion } from "@grasp-os/shared/apps";
import { functionErrors } from "@grasp-os/shared/functions";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import { asPerson, readDenied } from "./agent-person.ts";
import { admitEffect, chatAuthority, recordRunReads } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { callAppFunction } from "./app-functions.ts";
import type { FunctionAnswer } from "./app-functions.ts";
import { sourcesOf } from "./app-provenance.ts";
import { cancelRequest, requestText } from "./app-requests.ts";
import { appFor, listApps, listVersions, readFiles } from "./apps.ts";
import {
  callsApp,
  carryAppRestricted,
  carryChatRestricted,
  holdAppCall,
} from "./held-app-calls.ts";
import type { Held } from "./held-app-calls.ts";
import { appRead } from "./history-access.ts";
import { grantedPermissions } from "./permissions.ts";
import { markPrivateRead, mustConfirmForOthers } from "./private-reads.ts";
import { inTurn, runSessionOf } from "./run-sessions.ts";

// Apps for a chat's code: `await env.apps.list()`. What the chat's person
// sees of Apps themselves (agent-person.ts): the Apps the person has a
// role in, and the files and versions of those they build. These are the
// person's own, read as them, as `env.build` changes them (agent-builds.ts),
// so they need no permission of the agent's own; calling an App's
// functions, which reaches its data, does (`call`). Every call is audited
// as the chat's agent acting for them.

/**
 * How long a chat's code waits for one of an App's functions: as long as a
 * page does.
 */
const functionCallMs = 30_000;

/** What a call's kind needs of the agent's permission on the App. */
const actionFor = (kind: string): "read" | "write" =>
  kind === "query" ? "read" : "write";

/** The kind a request names, read only for the permission it needs. */
const requestKindSchema = z.looseObject({
  reference: z.looseObject({ kind: z.enum(["query", "mutation", "action"]) }),
});

/**
 * Marks the chat of `scope` (private-reads.ts) before App `app`'s answer is
 * handed over when the App may read through a person's own connection
 * (their mailbox, their drive: `sourcesOf`, through what it calls too),
 * as connect lets it for the person it acts for; or through anything
 * `sourcesOf` can't place (a connection connect no longer names, an App
 * past the walk's bounds, a kind of source no longer served), failing
 * closed. A chat marked already is left as it is, without the walk.
 */
const markIfReadsPrivate = async (
  env: Env,
  scope: AgentScope,
  app: AppId
): Promise<void> => {
  if (await mustConfirmForOthers(env, scope)) {
    return;
  }
  const { connections, unresolved } = await sourcesOf(env, app);
  if (
    connections.some(({ ownerUserId }) => ownerUserId !== null) ||
    unresolved.length > 0
  ) {
    await markPrivateRead(env, scope, "connection");
  }
};

/** Apps, as a chat's code reads them. */
export class AppsApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The Apps the person has a role in, oldest first. */
  async list(): Promise<App[]> {
    return await asPerson(this.env, this.ctx.props, {
      method: "apps.list",
      read: async (person) => await listApps(this.env, person),
      detail: (listed) => ({ apps: listed.length }),
    });
  }

  /** An App's files at `version`, or at its latest: for its builders. */
  async files(app: unknown, version?: unknown): Promise<AppFiles> {
    return await asPerson(this.env, this.ctx.props, {
      method: "apps.files",
      read: async (person) => {
        const files = await readFiles(this.env, person, app, version);
        await this.#recorded("build", app);
        return files;
      },
      detail: (files) => ({
        app: typeof app === "string" ? app : null,
        version: typeof version === "number" ? version : null,
        files: Object.keys(files).length,
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
   * is handed over. In a chat that used something only its person may
   * read (private-reads.ts), a write is held for that person instead
   * (held-app-calls.ts) and answers `{ held }`, nothing run. Every call,
   * refused, held or not, is audited as `agent.call`.
   */
  async call(app: unknown, request: unknown): Promise<FunctionAnswer | Held> {
    const id = appIdSchema.safeParse(app);
    const scope = this.ctx.props;
    let kind: string | null = null;
    let heldId: string | null = null;
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
                throw functionErrors.create("contract.invalid_request");
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
                // A chat that used something only its person may read
                // writes where the App's members read only once that
                // person confirms it (private-reads.ts): held, nothing run.
                if (await mustConfirmForOthers(this.env, scope)) {
                  // Only Grasp's own chat shows the hold to confirm: in a
                  // chat app's conversation it is refused, as a workflow's
                  // start is, so nothing waits where nobody can decide it
                  // (GRA-1929 adds the card that lifts this).
                  if (scope.via !== undefined && scope.via !== "web") {
                    throw agentErrors.create("agent.held_call_in_chat_app");
                  }
                  await admitEffect(this.env, scope);
                  const held = await holdAppCall(
                    this.env,
                    scope,
                    appId,
                    text,
                    kind ?? "mutation"
                  );
                  heldId = held.held.id;
                  return held;
                }
                await carryChatRestricted(this.env, scope, appId);
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
                  // A read changes nothing, so a turn nobody was there for
                  // may make it; a write of its is refused.
                  await admitEffect(this.env, scope, undefined, {
                    unattended: action !== "write",
                  });
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
              await carryAppRestricted(this.env, scope, appId, answer);
              // An App that may read through its person's own connection
              // (their mailbox: app-provenance.ts) hands over what only
              // they may read: the chat is marked first (private-reads.ts).
              if (answer.manifestHash !== null) {
                await markIfReadsPrivate(this.env, scope, appId);
              }
              // Recorded with the run before it is handed over: withheld
              // from the model once the agent or the person loses the App.
              // A refusal of the platform's own (no such App, no role, no
              // release, a call not allowed: `refusalOf`) hands over nothing
              // of the App, and no release answered it, so it isn't: the
              // model may explain it or try elsewhere. A failure the App's
              // release answered may carry its data, and is.
              const refusedByPlatform =
                !answer.result.ok && answer.manifestHash === null;
              if (!refusedByPlatform) {
                await recordRunReads(this.env, scope, [
                  appRead(action === "read" ? "query" : "write", appId),
                ]);
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
        ...(heldId === null ? {} : { held: heldId }),
      }),
      ended: (answer) =>
        "held" in answer || answer.result.ok
          ? undefined
          : {
              outcome:
                answer.result.error.code === "internal.unexpected"
                  ? "failed"
                  : "refused",
              reason: answer.result.error.code,
            },
    });
  }

  /**
   * Records with the run that it read App `app` so (history-access.ts),
   * before the read is handed over. `app` was found, so it is an App ID.
   */
  async #recorded(
    read: Parameters<typeof appRead>[0],
    app: unknown
  ): Promise<void> {
    await recordRunReads(this.env, this.ctx.props, [
      appRead(read, appIdSchema.parse(app)),
    ]);
  }

  /** An App's versions, newest first: for its builders. */
  async versions(app: unknown, before?: unknown): Promise<AppVersion[]> {
    return await asPerson(this.env, this.ctx.props, {
      method: "apps.versions",
      read: async (person) => {
        const listed = await listVersions(this.env, person, app, before);
        await this.#recorded("build", app);
        return listed;
      },
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
 * they build. Before suggesting a new App, list them here for one that
 * already does it.
 */
apps: {
  /** The Apps the person has a role in, oldest first. */
  list(): Promise<{
    id: string;
    name: string;
    description: string;
    owner: string;
    /** The live version, the one that runs; null until its first publish. */
    currentVersion: number | null;
    createdAt: string;
  }[]>;
  /** An App's files by path, at \`version\`, or at its latest version without one. Only for Apps the person builds. */
  files(app: string, version?: number): Promise<Record<string, string>>;
  /**
   * Calls a public function (query, mutation or action) of an App's current
   * version for the person, by its reference, its name and kind: \`request\` is the
   * call as JSON text, \`{ reference, args, idempotencyKey? }\`, sent as a
   * stream: \`env.apps.call(app, new Blob([JSON.stringify(call)]).stream())\`.
   * At most 132 KiB, sent in full within 5 seconds. Calls made at once may run one at a time, in
   * the order made, each within its own 30 seconds, and at most 8 at once (more answer \`function.sandbox_busy\`). Needs a permission on the App (\`read\` for a query,
   * \`write\` otherwise), granted by an admin. Answers the result as data:
   * \`{ result: { ok: true, value } | { ok: false, error }, manifestHash }\`.
   * Once this chat has used something only the person can read, a mutation
   * or an action is held for them to confirm in the chat instead, as the
   * App's members would read what it writes: it answers \`{ held }\` and
   * has not run. Tell them it waits for them, and end your turn; you are
   * told how they decided.
   */
  call(app: string, request: ReadableStream<Uint8Array>): Promise<
    | {
        result:
          | { ok: true; value: unknown }
          | { ok: false; error: { code: string; message: string; category: string; retryable: boolean; requestId: string; details?: unknown } };
        manifestHash: string | null;
      }
    | { held: { id: string; expiresAt: string } }
  >;
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
  summary:
    "The company's Apps the person has a role in, and the code of those they build.",
  declaration: appsDeclaration,
  stub: (scope) => exports.AppsApi({ props: scope }),
};
