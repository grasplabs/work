import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { apps, workflowResourceRuns } from "./db/core/schema.ts";
import { appHost, workspace } from "./durable-objects.ts";

// Restricted mode. Once a chat or an App reads restricted data (in
// Knowledge: what a sensitive collection holds), it is restricted for good,
// and from then on takes no action in outside systems unless the person it
// acts for confirms it, warned that it may carry what was read. The flag
// is kept where the chat or App lives (its workspace's or its own Durable
// Object), so it survives restarts, and it is set before the data is
// returned, so nothing that holds the data runs unrestricted. It is read
// in the places core lets data out: where it makes the capability for
// connect (bindings.ts), which carries it, and in the model gateway, whose
// data rules decide which models a restricted context may use
// (model-rules.ts).
//
// Only connect knows which actions write, so connect enforces it: a
// restricted context may still call a native connector's reads (as its
// manifest declares them, never a server's own word), and every other
// call, a Composio toolkit's reads too (their input leaves for a third
// party), is held there for the person (a workflow run waits for their
// decision). Knowledge, which stays in the deployment, can be read too.
//
// The flag is only as good as the boundaries between contexts: it must
// follow every way data moves from one to another. State shared across a
// workspace's chats would need a flag on the workspace, not on each chat.
// Whatever adds such a flow adds the flag with it: an independent
// workflow's run started by a restricted App, or from a restricted chat,
// is restricted for good, its receipt and row pinning it
// (workflow-starts.ts), and restricts any App it calls before its input
// reaches it (workflows/resource-calls.ts). Such a run shares nothing
// with the workflow's other runs, so none of them is restricted by it.
//
// Entering restricted mode is audited, with the collections whose read
// entered it as provenance: before the flag is set, so it's never set
// unrecorded. A read whose event can't be stored fails before anything is
// restricted or returned, and the next restricted read records it again.
// It can be recorded twice: by two first restricted reads of one context
// at once, or when setting the flag fails after its event was stored, and
// the next restricted read records it again.

/**
 * Where an App, agent or workflow works, and keeps its restricted mode
 * (`workContextSchema`): a chat, an App, or a run of an independent
 * workflow. The host sets it, like the authority.
 */
export type { WorkContext } from "@grasp-os/shared/permissions";

/** What reading a context's restricted mode needs of core's env. */
export type RestrictedEnv = Pick<
  Env,
  "DB" | "APPS" | "WORKSPACES" | "DURABLE_OBJECT_JURISDICTION"
>;

const contextInvalid = () =>
  permissionErrors.create("permission.context_invalid");

/**
 * Refuses an App context that isn't the App `authority` names, or an App
 * that isn't in the registry, so no App can read or set another's flag.
 */
const requireOwnApp = async (
  env: RestrictedEnv,
  authority: Authority,
  context: Extract<WorkContext, { type: "app" }>
): Promise<void> => {
  const { subject } = authority;
  const { appId } = context;
  if (subject.type !== "app" || subject.appId !== appId) {
    throw contextInvalid();
  }
  const found = await drizzle(env.DB)
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.id, appId))
    .get();
  if (!found) {
    throw contextInvalid();
  }
};

/**
 * Refuses a run of an independent workflow that isn't one of the workflow
 * `authority` names, or doesn't exist. Answers whether it runs in
 * restricted mode, as its row pins it.
 */
const requireOwnResourceRun = async (
  env: RestrictedEnv,
  authority: Authority,
  context: Extract<WorkContext, { type: "workflowRun" }>
): Promise<boolean> => {
  const { subject } = authority;
  if (
    subject.type !== "workflow" ||
    subject.workflowId !== context.workflowId
  ) {
    throw contextInvalid();
  }
  const found = await drizzle(env.DB)
    .select({ restricted: workflowResourceRuns.restricted })
    .from(workflowResourceRuns)
    .where(
      and(
        eq(workflowResourceRuns.id, context.runId),
        eq(workflowResourceRuns.workflowResourceId, context.workflowId)
      )
    )
    .get();
  if (found === undefined) {
    throw contextInvalid();
  }
  return found.restricted;
};

/**
 * Whether `context` has read restricted data. Throws
 * `permission.context_invalid` for a context `authority` can't work in, or
 * one that doesn't exist: it has nowhere to keep the flag.
 */
const restrictedState = async (
  env: RestrictedEnv,
  authority: Authority,
  context: WorkContext
): Promise<boolean> => {
  if (context.type === "workflowRun") {
    // As its start decided, pinned on its row (`restrict`).
    return await requireOwnResourceRun(env, authority, context);
  }
  if (context.type === "app") {
    await requireOwnApp(env, authority, context);
    return await appHost(env, context.appId).isRestricted();
  }
  // A chat is the organization's agent's to work in, as the chat stored it,
  // and no one else's, whichever object holds it (a person's own, say).
  const { subject } = authority;
  if (subject.type !== "agent") {
    throw contextInvalid();
  }
  const chat = await workspace(env, context.workspaceId).chatState(
    context.chatId
  );
  if (chat === undefined || chat.agentId !== subject.agentId) {
    throw contextInvalid();
  }
  return chat.restricted;
};

/**
 * The audit entry of `context` entering restricted mode, by `authority`,
 * after reading from `sources`.
 */
const restrictedEntry = (
  authority: Authority,
  context: WorkContext,
  sources: string[]
): AuditEntry => {
  const provenance = [...new Set(sources)];
  if (context.type === "workflowRun") {
    // `restrict` refuses such a run before it is recorded.
    throw contextInvalid();
  }
  if (context.type === "chat") {
    return {
      actor: delegateActorOf(authority),
      action: "context.restricted",
      target: { type: "chat", id: context.chatId },
      provenance,
      detail: { workspace: context.workspaceId },
    };
  }
  return {
    actor: delegateActorOf(authority),
    action: "context.restricted",
    target: { type: "app", id: context.appId },
    provenance,
  };
};

/**
 * Puts `context` in restricted mode, for good, after reading from
 * `sources` (collection IDs); audited when it wasn't yet. Throws
 * `permission.context_invalid` as `restrictedState` does.
 *
 * A run of an independent workflow never enters it after it starts: it
 * starts restricted or not, as its start decided (workflow-starts.ts,
 * `restrictedStart`), and keeps that. It reads no Knowledge, and what it
 * calls answers an unrestricted one nothing restricted (a function of
 * an App in restricted mode is refused, before and after:
 * workflows/resource-calls.ts). Anything that would restrict an
 * unrestricted one is refused instead, `permission.restricted`, so
 * restricted data fails closed rather than reaching a run that would pass
 * it on unrestricted. A restricted one already is.
 */
export const restrict = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  sources: string[]
): Promise<void> => {
  if (await restrictedState(env, authority, context)) {
    return;
  }
  if (context.type === "workflowRun") {
    throw permissionErrors.create("permission.restricted");
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, restrictedEntry(authority, context, sources)),
  ]);
  if (context.type === "app") {
    await appHost(env, context.appId).restrict();
    return;
  }
  const found = await workspace(env, context.workspaceId).restrictChat(
    context.chatId
  );
  if (!found) {
    throw contextInvalid();
  }
};

/** Whether `context` has read restricted data, as `restrictedState` says. */
export const isRestricted = async (
  env: RestrictedEnv,
  authority: Authority,
  context: WorkContext
): Promise<boolean> => await restrictedState(env, authority, context);
