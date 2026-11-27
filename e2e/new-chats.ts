import type { ChatQuestion } from "@grasp-os/shared/chat";

import type { apiOf } from "./people.ts";

// New chats as a page starts them (`ChatQuestion.start`): the page names
// the chat, and its first question, or the first file it carries, makes it.

type Api = ReturnType<typeof apiOf>["api"];

/** Asks `question` in a new chat named `title`, which it makes; answers its ID. */
export const askInNewChat = async (
  api: Api,
  title: string,
  question: Omit<ChatQuestion, "key" | "start">
): Promise<string> => {
  const id = crypto.randomUUID();
  const key = crypto.randomUUID();
  await api.chats.send(id, { ...question, key, start: { key, title } });
  return id;
};

/**
 * A new chat named `title` with nothing in it yet, as a file attached under
 * its start makes it, then taken out again; answers its ID.
 */
export const emptyChat = async (api: Api, title: string): Promise<string> => {
  const id = crypto.randomUUID();
  const key = crypto.randomUUID();
  const file = await api.chats.attachFile(
    id,
    { name: "start.txt", bytes: new TextEncoder().encode("Start.") },
    key,
    { key, title }
  );
  await api.chats.removeFile(id, file.id);
  return id;
};
