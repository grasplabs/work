import { agentErrors } from "@grasp-os/shared/agent";
import type { HeldAppCall } from "@grasp-os/shared/chat";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Permission } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { readDenied } from "./agent-person.ts";
import { chatAuthority, chatContext } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { callAppFunction } from "./app-functions.ts";
import type { FunctionAnswer } from "./app-functions.ts";
import { appFor, findApp } from "./apps.ts";
import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import { appHost, workspace } from "./durable-objects.ts";
import { grantedPermissions } from "./permissions.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { isRestricted, restrict } from "./restricted.ts";
import type { HeldAppCallRow } from "./workspace.ts";

// Writes to an App that a chat's agent asked for after its chat used
// something only its person may read (private-reads.ts,
// `mustConfirmForOthers`), held for that person (GRA-1843; the threat
// model is on the issue): an App's data is read by its members, so what
// the chat read could reach them. The agent's call only holds; the write
// runs when its person confirms it in Grasp, through their own session.
// How each way it can fail is closed:
//
// - A write without its person: nothing runs until the person confirms
//   it. Nobody else finds it: a hold of another's chat, or another
//   person's, answers exactly as one that doesn't exist
//   (`agent.held_call_not_found`).
// - A confirmation of something other than what was shown: the hold
//   keeps the request exactly as the agent's code sent it, which the
//   card shows whole, and the person confirms its SHA-256; another
//   request is another hold.
// - Confirmed twice, or replayed: it is decided once, in the write that
//   takes it from waiting (the Workspace's), which empties its request, so
//   it runs at most once.
// - Authority lost between asking and confirming: holding checks the
//   agent's grant and the person's role in the App as the call would, so a
//   write that couldn't run is refused at once; confirming checks both
//   again before the call, and the grant again before every protected
//   step of it (`stillAllowed`).
// - A hold waiting for ever, or keeping what it would send: it lapses
//   after a day (`heldStartMs`, as a held start does), and whenever the
//   chat's holds are next read its request is emptied, its end recorded
//   (`chat.app_call.lapsed`) and its agent told; it is neither listed nor
//   confirmable after.
// - Restricted mode (restricted.ts) is carried both ways, as on the
//   agent's own call: a restricted chat restricts the App before the
//   write, and a restricted App's answer restricts the chat.
// - What the App answers never reaches the model: the agent is told
//   how it ended alone (`heldAppCallDecided`), and reads the App again
//   if it needs to, under the checks every read has.
// Holding, confirming and declining are each audited in the write that
// makes them (`chat.app_call.held`, `.confirmed`, `.declined`), and how a
// confirmed one ended once it did (`.ended`, its outcome alone).

/** How long a confirmed write waits for the App's answer: as a chat's code does. */
const functionCallMs = 30_000;

/** Whether `permissions` hold `action` on App `app` (an `app` permission). */
export const callsApp =
  (app: string, action: "read" | "write") =>
  (permissions: Permission[]): boolean =>
    permissions.some(
      ({ object, actions }) =>
        object.type === "app" &&
        object.appId === app &&
        actions.includes(action)
    );

/** The function a request names, read only to show it. */
const referenceSchema = z.looseObject({
  reference: z.looseObject({ name: z.string().min(1).max(256) }),
});

/**
 * Restricts App `app` when the chat of `scope` is restricted, before a
 * write there: its input may carry what the chat read restricted.
 */
export const carryChatRestricted = async (
  env: Env,
  scope: Pick<AgentScope, "workspaceId" | "chatId" | "agentId" | "personId">,
  app: AppId
): Promise<void> => {
  if (!(await isRestricted(env, chatAuthority(scope), chatContext(scope)))) {
    return;
  }
  const { currentVersion } = await findApp(env, app);
  await restrict(
    env,
    {
      subject: { type: "app", appId: app },
      onBehalfOf: scope.personId,
      mode: "interactive",
      appVersion: currentVersion ?? undefined,
    },
    { type: "app", appId: app },
    [`chat:${scope.chatId}`]
  );
};

/**
 * Restricts the chat of `scope` once App `app`, which answered it, is
 * restricted: before the answer goes on.
 */
export const carryAppRestricted = async (
  env: Env,
  scope: Pick<AgentScope, "workspaceId" | "chatId" | "agentId" | "personId">,
  app: AppId,
  answer: FunctionAnswer
): Promise<void> => {
  if (
    answer.manifestHash !== null &&
    (await appHost(env, app).isRestricted())
  ) {
    await restrict(env, chatAuthority(scope), chatContext(scope), [
      `app:${app}`,
    ]);
  }
};

/** What the agent's code is answered for a write held for its person. */
export interface Held {
  held: { id: string; expiresAt: string };
}

/**
 * Holds the write `request` (the call's JSON text, of `kind`) to App
 * `app`, which the agent of `scope` may make and its person may reach, for
 * that person to confirm in the chat.
 */
export const holdAppCall = async (
  env: Env,
  scope: Pick<AgentScope, "workspaceId" | "chatId" | "agentId" | "personId">,
  app: AppId,
  request: string,
  kind: string
): Promise<Held> => {
  const { reference } = referenceSchema.parse(JSON.parse(request));
  const held = await workspace(env, scope.workspaceId).holdAppCall(
    scope.chatId,
    scope.personId,
    {
      agentId: scope.agentId,
      appId: app,
      function: reference.name,
      kind,
      request,
      requestHash: await sha256Hex(request),
    },
    Date.now()
  );
  return {
    held: { id: held.id, expiresAt: new Date(held.expiresAt).toISOString() },
  };
};

/** `row` as the person's page reads it, with the App's name now. */
const shownOf = async (env: Env, row: HeldAppCallRow): Promise<HeldAppCall> => {
  let appName: string | null = null;
  try {
    ({ name: appName } = await findApp(env, row.appId));
  } catch (error) {
    // Removed since: shown by its ID, and refused on confirming.
    if (!isExpectedError(error)) {
      throw error;
    }
  }
  return {
    id: row.id,
    appId: row.appId,
    appName,
    function: row.function,
    kind: row.kind,
    request: row.request,
    requestHash: row.requestHash,
    heldAt: new Date(row.heldAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
};

/** The App writes held for `person` in their chat `chatId`, oldest first. */
export const heldAppCallsOf = async (
  env: Env,
  person: Pick<Identity, "userId">,
  chatId: string
): Promise<HeldAppCall[]> => {
  const rows = await workspace(
    env,
    personalWorkspaceId(person.userId)
  ).heldAppCalls(chatId, person.userId, Date.now());
  return await Promise.all(rows.map(async (row) => await shownOf(env, row)));
};

/** The member `identity` is now, or refused as no longer one. */
const memberNow = async (
  env: Env,
  identity: Pick<Identity, "userId">
): Promise<Member> => {
  const member = await memberOf(env.DB, identity.userId);
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return member;
};

/**
 * Runs held App call `row`, which its person just confirmed, as the
 * chat's agent acting for them, with every check of the agent's own call
 * made again: its answer, or the error that refused it.
 */
const runConfirmed = async (
  env: Env,
  person: Member,
  row: HeldAppCallRow
): Promise<FunctionAnswer> => {
  const scope = {
    workspaceId: personalWorkspaceId(person.userId),
    chatId: chatIdSchema.parse(row.chatId),
    agentId: row.agentId,
    personId: person.userId,
  };
  const app = appIdSchema.parse(row.appId);
  const authority = chatAuthority(scope);
  const stillAllowed = async () => {
    if (!callsApp(app, "write")(await grantedPermissions(env, authority))) {
      throw readDenied("write");
    }
  };
  await stillAllowed();
  await appFor(env, person, app, "user");
  await carryChatRestricted(env, scope, app);
  // The App's current version runs, as for any call: a hold names the App
  // and its request, never a version, so one published since takes it,
  // checking its arguments again.
  const answer = await callAppFunction(
    env,
    person,
    app,
    row.request,
    Date.now() + functionCallMs,
    stillAllowed,
    undefined,
    {
      agentId: row.agentId,
      workspaceId: scope.workspaceId,
      chatId: scope.chatId,
    }
  );
  await carryAppRestricted(env, scope, app, answer);
  return answer;
};

/**
 * Confirms held App call `id` of `identity`'s chat `chatId` for exactly
 * the request whose SHA-256 is `requestHash`, and runs it, once. Throws
 * `agent.held_call_not_found` for one that doesn't wait for them so, and
 * the call's refusal or failure as it came; the chat's agent is told how
 * it ended.
 */
export const confirmHeldAppCall = async (
  env: Env,
  identity: Pick<Identity, "userId">,
  chatId: string,
  id: string,
  requestHash: string
): Promise<void> => {
  const person = await memberNow(env, identity);
  const chats = workspace(env, personalWorkspaceId(person.userId));
  const row = await chats.decideHeldAppCall(
    chatId,
    person.userId,
    id,
    { confirm: true, requestHash },
    Date.now()
  );
  let ok = false;
  try {
    const { result } = await runConfirmed(env, person, row);
    ({ ok } = result);
    if (!result.ok) {
      throw agentErrors.create("agent.held_call_failed", {
        code: result.error.code,
      });
    }
  } finally {
    try {
      await chats.heldAppCallDecided(
        row.chatId,
        person.userId,
        row,
        ok ? "confirmed" : "failed"
      );
    } catch (error) {
      // The write stands either way; the agent learns of it from the App.
      // Its outcome may then be unrecorded: a confirmation alone never
      // says it ran.
      log.warn("chat.held_app_call_note_failed", errorFields(error));
    }
  }
};

/**
 * Declines held App call `id` of `identity`'s chat `chatId`: it never
 * runs. Throws `agent.held_call_not_found` for one that doesn't wait for
 * them.
 */
export const declineHeldAppCall = async (
  env: Env,
  identity: Pick<Identity, "userId">,
  chatId: string,
  id: string
): Promise<void> => {
  const chats = workspace(env, personalWorkspaceId(identity.userId));
  const row = await chats.decideHeldAppCall(
    chatId,
    identity.userId,
    id,
    { confirm: false },
    Date.now()
  );
  await chats.heldAppCallDecided(row.chatId, identity.userId, row, "declined");
};
