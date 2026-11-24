import { chatFilesPrefix, chatPictureTypes } from "@grasp-os/shared/chat";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";

import { identify } from "./auth/identity.ts";
import { workspace } from "./durable-objects.ts";
import { errorResponse } from "./errors.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { routeMember } from "./staff-audit.ts";

// A picture attached to a chat's question (chat-files.ts), for the page to
// show it again after a reload (`chatFilePath`).
//
// How it can go wrong, and what stops it:
// - Someone but the chat's person reading it, by guessing its address or
//   knowing it: the route reads only from the signed-in person's own
//   Workspace, where only their chats are, and only a chat of theirs in
//   Grasp (`ownChatPicture`): any other chat or file is not found, the
//   same as one that never was. A guest is nobody to `identify`; Grasp
//   staff are refused, and their asking is in the audit log
//   (`routeMember`).
// - A browser running it: it is served only as the picture type core told
//   by its header when it was attached, never SVG, with `nosniff` and a
//   policy that runs and loads nothing (security-headers.ts).
// - It outliving the chat or the person: it is read from the chat as it is
//   now, and the browser keeps no copy.

/** `/api/chat-files/<chat>/<file>`: a picture of a chat. */
const chatFilePattern = new RegExp(
  `^${chatFilesPrefix}(?<chat>[^/]+)/(?<file>[^/]+)$`,
  "u"
);

/** `part` decoded from a path; `undefined` for one that isn't encoded right. */
const decoded = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
};

/**
 * A picture of the signed-in member's own chat, as its type, never kept
 * by the browser. Anyone not signed in is told to; any other chat or file
 * is not found. Undefined for any other path.
 */
export const chatFileResponse = async (
  pathname: string,
  request: Request,
  env: Env,
  requestId: string
): Promise<Response | undefined> => {
  const match = chatFilePattern.exec(pathname)?.groups;
  if (match === undefined) {
    return undefined;
  }
  const notFound = () =>
    errorResponse(404, requestErrors.create("request.not_found"), requestId);
  const chatId = decoded(match.chat ?? "");
  const fileId = decoded(match.file ?? "");
  if (
    request.method !== "GET" ||
    chatId === undefined ||
    fileId === undefined
  ) {
    return notFound();
  }
  const person = await routeMember(
    env,
    await identify(env, request.headers),
    "chat.file",
    { chat: chatId, file: fileId }
  );
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  const picture = await workspace(
    env,
    personalWorkspaceId(person.userId)
  ).ownChatPicture(chatId, person.userId, fileId);
  if (picture === undefined) {
    return notFound();
  }
  // `nosniff` and a policy that runs nothing come with every answer on
  // this path (security-headers.ts).
  return new Response(picture.bytes, {
    headers: {
      "content-type": chatPictureTypes[picture.type],
      "content-length": String(picture.bytes.byteLength),
      "cache-control": "private, no-store",
    },
  });
};
