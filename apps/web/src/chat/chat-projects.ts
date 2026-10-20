import type { ChatProject, ChatSummary } from "@grasp-os/shared/chat";
import {
  projectDocumentMaxBytes,
  projectDocumentNameSchema,
  projectDocumentsMax,
  projectDocumentTypes,
} from "@grasp-os/shared/chat";

// Projects in the chat list (grasplabs/prototype `lib/chat-projects.ts`):
// a person groups their chats, and gives each project a goal and a few
// text documents its chats' agent reads. Core checks every limit again;
// these say why before a file is sent.

/** Why a file can't be added to a project. */
export type DocumentProblem = "type" | "size" | "count";

/** What the file picker offers: the extensions core takes. */
export const documentAccept = projectDocumentTypes
  .map((extension) => `.${extension}`)
  .join(",");

/**
 * Why `file` can't be added to a project that holds `count` documents
 * already, or null when it can: not a .md, .txt, .csv or .json file, past
 * {@link projectDocumentMaxBytes}, or one past {@link projectDocumentsMax}.
 */
export const documentProblem = (
  file: { readonly name: string; readonly size: number },
  count: number
): DocumentProblem | null => {
  if (!projectDocumentNameSchema.safeParse(file.name).success) {
    return "type";
  }
  if (file.size > projectDocumentMaxBytes) {
    return "size";
  }
  return count >= projectDocumentsMax ? "count" : null;
};

/**
 * The chats each project holds, in the order core lists them, and the
 * chats in none: a chat whose project is gone is in none.
 */
export const chatsByProject = (
  chats: readonly ChatSummary[],
  projects: readonly Pick<ChatProject, "id">[]
): { inProject: Map<string, ChatSummary[]>; outside: ChatSummary[] } => {
  const inProject = new Map<string, ChatSummary[]>(
    projects.map(({ id }) => [id, []])
  );
  const outside: ChatSummary[] = [];
  for (const chat of chats) {
    const held =
      chat.projectId === null ? undefined : inProject.get(chat.projectId);
    if (held === undefined) {
      outside.push(chat);
    } else {
      held.push(chat);
    }
  }
  return { inProject, outside };
};
