import { agentErrors } from "@grasp-os/shared/agent";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";

import { chatAuthority } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { workspace } from "./durable-objects.ts";

// What a chat wrote for others after it used something only its person
// may read (GRA-1843; the threat model and the decisions are on the
// issue). Confirm, don't block: a chat that handed its model or its code
// something only its person may read is marked, for good; from then on
// what its agent writes where others read waits for the person, who sees
// exactly what will be sent before it goes. What it writes to their own
// space (their own memory, their own dashboard, their own connection's
// request) goes on as before.
//
// What marks a chat is what it handed over that the person may not have
// in mind, never where it is, nor what they wrote or brought in
// themselves:
// - the recall before a question that hands over a passage or a memory
//   of the person's own store (turn-recall.ts), where everything only
//   they may read is kept;
// - an answer read through the person's own personal connection (their
//   mailbox, their drive: agent-connections.ts), a call's or a confirmed
//   held call's;
// - an App's answer, when the App may read through a person's own
//   connection (app-provenance.ts `sourcesOf`), as connect lets it for
//   the person the chat acts for (agent-apps.ts).
// Rows of an App's table only the person may read (an `owner` table, a
// read row rule) don't mark yet: GRA-1932.
// Their own instruction file, their own agent's instructions and
// documents, their own skills and a file they attached mark nothing:
// like their typed message, they are theirs, and nobody else can write
// into them. So an App's answer that steers the agent can still have it
// copy one of them into App data unasked (a gap the issue names).
//
// The mark is set, and audited once (`chat.private_read`), before what
// marks it is handed over: nothing that holds it runs unmarked. It lasts
// for good, the strictest option there is: the model's own replies quote
// what it read, and its summaries carry it, for as long as the chat goes
// on. A new chat starts unmarked.
//
// `mustConfirmForOthers` is the one rule, read fresh on every call that
// would write for others. Which writes those are, from the code:
// - A write to an App (`env.apps.call`, a mutation or an action): its
//   data is read by the App's members. Held in the chat for its person
//   (held-app-calls.ts) while the chat is marked; refused in a chat app's
//   conversation, which can't show the hold yet (GRA-1929).
// - A request for a shared connection (`env.connections.request`): its
//   reason is read by admins, and nothing holds it, so it is refused
//   while the chat is marked (chat-connections.ts).
// - A connection's side effects (mail, posts, invites, files) and a
//   workflow's starts are held for the person from every chat already
//   (connect's call.ts, held-starts.ts). A connection's reads are not:
//   in a marked chat, what a read on a shared connection is asked with
//   (a CRM search for recalled text) still leaves Grasp at once, allowed
//   and audited by connect: GRA-1928.
// - A query of an App (`env.apps.call`, a query) runs at once: what it is
//   asked with can reach the App's error log (a live App's `console`
//   lines and thrown errors that quote it: server-logs.ts,
//   app-error-log.ts), which its builders and their agents read. Like a
//   read on a shared connection, allowed: GRA-1928.
// - Building an App or a workflow writes a draft its builders read, and
//   asking for an App's npm packages (`env.build.resolveDependencies`)
//   keeps a `purpose` they read: GRA-1918.

/** What a chat handed over that only its person may read. */
export type PrivateRead = "recall" | "connection";

/** The chat a scope names, as its Workspace keeps it. */
type ChatScope = Pick<
  AgentScope,
  "workspaceId" | "chatId" | "agentId" | "personId"
>;

/** The audit entry of the chat of `scope` marked by `read`. */
export const privateReadEntry = (
  scope: ChatScope,
  read: PrivateRead
): AuditEntry => ({
  actor: delegateActorOf(chatAuthority(scope)),
  action: "chat.private_read",
  target: { type: "chat", id: scope.chatId },
  detail: { workspace: scope.workspaceId, read },
});

/**
 * Marks the chat of `scope`, for good, as having handed over something
 * only its person may read (`read`), audited in the same write the first
 * time. Throws `agent.chat_not_found` for a chat its Workspace doesn't
 * have: there is nowhere to keep the mark, so nothing may be handed over.
 */
export const markPrivateRead = async (
  env: Env,
  scope: ChatScope,
  read: PrivateRead
): Promise<void> => {
  const marked = await workspace(env, scope.workspaceId).markChatPrivateRead(
    scope.chatId,
    privateReadEntry(scope, read)
  );
  if (marked === undefined) {
    throw agentErrors.create("agent.chat_not_found");
  }
};

/**
 * Whether what the chat of `scope` writes where others read waits for its
 * person to confirm it: once it handed over something only they may read,
 * for good. Read fresh, from the chat's Workspace. A chat that can't be
 * found answers as marked, so nothing is let through for want of it.
 */
export const mustConfirmForOthers = async (
  env: Env,
  scope: Pick<AgentScope, "workspaceId" | "chatId">
): Promise<boolean> =>
  (await workspace(env, scope.workspaceId).isChatPrivateRead(scope.chatId)) !==
  false;
