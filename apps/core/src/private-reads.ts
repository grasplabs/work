import { agentErrors } from "@grasp-os/shared/agent";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";

import { chatAuthority } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { workspace } from "./durable-objects.ts";

// What a chat wrote for others after it used something only its person
// may read (GRA-1843; the threat model is on the issue). Decided on 15
// November 2026: confirm, don't block. A chat that handed its model or its
// code something only its person may read is marked, for good; from then
// on what its agent writes where others read waits for the person, who
// sees exactly what will be sent before it goes. What it writes to their
// own space (their own memory, their own dashboard, their own connection's
// request) goes on as before.
//
// What marks a chat is what it handed over, never where it is:
// - the recall before a question that hands over a passage or a memory
//   of the person's own store (turn-recall.ts), where everything only
//   they may read is kept;
// - the person's own instruction file, their own agent's instructions or
//   documents, or one of their own skills, in a turn or read by its code
//   (workspace.ts, agent-skills.ts);
// - a file attached to a chat nobody else shares, read by its code
//   (agent-apis.ts).
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
//   (held-app-calls.ts) while the chat is marked.
// - A request for a shared connection (`env.connections.request`): its
//   reason is read by admins, and nothing holds it, so it is refused
//   while the chat is marked (chat-connections.ts).
// - A connection's side effects (mail, posts, invites, files) and a
//   workflow's starts are held for the person from every chat already
//   (connect's call.ts, held-starts.ts), a stricter rule than this one.
// - Building an App or a workflow writes a draft its builders read:
//   GRA-1918.

/** What a chat handed over that only its person may read. */
export type PrivateRead = "recall" | "instructions" | "skill" | "file";

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
