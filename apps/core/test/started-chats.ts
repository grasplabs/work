import { actorOf } from "@grasp-os/shared/audit";
import type {
  ChatMake,
  ChatStart,
  ChatsApi,
  ChatSummary,
} from "@grasp-os/shared/chat";
import { env } from "cloudflare:workers";

import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";

/**
 * A new chat of `someone`'s, named `title`, with nothing asked in it yet:
 * made by their own object as the question a page starts it with makes it
 * (`Workspace.startChat`, `ChatsApi.send` with a `start`), by them, under
 * an ID the page named. With the company's first agent unless `agentId`
 * names another; from "Make something" with `make`. Nothing here checks
 * what the page's start is checked for (chats-rpc.ts): a test of that
 * sends the start itself.
 */
export const startedChat = async (
  someone: { userId: string; staff?: boolean | undefined },
  title: string,
  { agentId = chatAgentId, make }: { agentId?: string; make?: ChatMake } = {}
): Promise<ChatSummary> => {
  const chats = workspace(env, personalWorkspaceId(someone.userId));
  const id = crypto.randomUUID();
  await chats.startChat(id, someone.userId, {
    key: crypto.randomUUID(),
    title,
    agentId,
    make,
    by: actorOf({ userId: someone.userId, staff: someone.staff ?? false }),
  });
  return await chats.chatSummary(id, someone.userId);
};

/**
 * A new chat started through `chats`, the person's own API, as a page
 * starts one, here with a file attached under the start
 * (`ChatsApi.attachFile`), so no model answers anything: checked as any
 * start is (whom the person may talk to, what they may set up).
 */
export const startedThrough = async (
  chats: Pick<ChatsApi, "attachFile" | "summary">,
  title: string,
  { agentId, make }: Omit<ChatStart, "key" | "title"> = {}
): Promise<ChatSummary> => {
  const id = crypto.randomUUID();
  const key = crypto.randomUUID();
  await chats.attachFile(
    id,
    { name: "start.txt", bytes: new TextEncoder().encode("Start.") },
    key,
    {
      key,
      title,
      ...(agentId === undefined ? {} : { agentId }),
      ...(make === undefined ? {} : { make }),
    }
  );
  return await chats.summary(id);
};
