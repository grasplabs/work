import { useNavigate } from "@tanstack/react-router";

// Where a chat is: its own page, `/chats/$chatId`
// (routes/_shell.chats.$chatId.tsx). Every way to a chat (the sidebar's
// chats, search, a link from an App's workspace) goes there through these:
// `chatLink` for a Link, `useGoToChat` for a press that isn't one.

/** The chat's page, for a Link: `<Link {...chatLink(chatId)}>`. */
export const chatLink = (chatId: string) =>
  ({ to: "/chats/$chatId", params: { chatId } }) as const;

/** Goes to the chat's page; with none, to a new chat (Chat's start). */
export const useGoToChat = (): ((chatId?: string) => void) => {
  const navigate = useNavigate();
  return (chatId) => {
    void navigate(chatId === undefined ? { to: "/" } : chatLink(chatId));
  };
};
