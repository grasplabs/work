import { agentErrors } from "@grasp-os/shared/agent";
import {
  chatFileMaxBytes,
  chatFileTypeOf,
  chatFileTypes,
  chatPictureMaxBytes,
  chatPictureMaxPixels,
} from "@grasp-os/shared/chat";
import type { ChatFileType, ChatPictureType } from "@grasp-os/shared/chat";
import { isExpectedError } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import { uploadErrors, uploadNameSchema } from "@grasp-os/shared/uploads";
import { z } from "zod";

import { ExtractorUnavailableError, localExtractor } from "./files/extract.ts";
import type { LocalExtractorEnv } from "./files/extract.ts";
import { imageEnded, imageHeaderOf } from "./files/image-header.ts";
import type { ImageHeader } from "./files/image-header.ts";
import { hasText, signatures } from "./files/upload-checks.ts";

// Reading a file attached to a chat's question (`chats.attachFile`): its
// text, as the agent reads it. Checked as a Knowledge upload is, by what
// arrived (its size, and that a PDF or Office file starts as its type
// does), and read with core's local extractor, in a sandbox of its
// own (files/extract.ts). Never Workers AI's conversion: a chat file
// is the person's own, and Workers AI isn't pinned to the EU, so its
// content never leaves the deployment's own Workers. Text files are read
// as UTF-8, here. Only the text is kept (workspace.ts): no original.
//
// A picture (a pasted screenshot) is the one file kept whole, for the
// model to see and the page to show again (`chatFilePath`). How that can
// go wrong, and what stops it:
// - A file a browser would run: an SVG with script, HTML named .png. A
//   picture is told by its header alone (files/image-header.ts), never by
//   its name: PNG, JPEG, WebP and GIF, never SVG. Anything else is read as
//   a file by its name, which no picture's extension is.
// - A picture large enough to hurt: refused past 5 MB, or past 8000 pixels
//   a side, what the model providers take of one image.
// - Someone else reading it: it is kept with the chat, in its person's own
//   Workspace, which only they reach, and goes with the chat and with
//   them (workspace.ts).

/** Most text a chat file keeps, in bytes of UTF-8: what the extractor gives. */
export const chatFileTextMaxBytes = 1024 * 1024;

/** A file to attach, as the page sends it: a name and its bytes. */
const chatFileInputSchema = z.strictObject({
  name: uploadNameSchema,
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});

/** The picture types, by the type an image's header says. */
const pictureTypes: Readonly<Record<ImageHeader["type"], ChatPictureType>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** The types the extractor reads; the rest are text. */
type ExtractedType = Extract<ChatFileType, "pdf" | "docx" | "xlsx">;

const isExtracted = (type: ChatFileType): type is ExtractedType =>
  type === "pdf" || type === "docx" || type === "xlsx";

/** A text file's content: UTF-8, without a byte order mark. */
const textOf = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes
    );
  } catch {
    throw uploadErrors.create("upload.unreadable");
  }
};

/** What the extractor made of a PDF or Office file, its errors as the person reads them. */
const extractedText = async (
  env: LocalExtractorEnv,
  name: string,
  type: ExtractedType,
  bytes: Uint8Array
): Promise<string> => {
  try {
    const { markdown } = await localExtractor(env)({
      name,
      mediaType: chatFileTypes[type],
      bytes,
    });
    return markdown;
  } catch (error) {
    if (error instanceof ExtractorUnavailableError) {
      throw agentErrors.create("agent.file_busy");
    }
    if (uploadErrors.codeOf(error) === "upload.text_too_large") {
      throw agentErrors.create("agent.file_too_large");
    }
    if (isExpectedError(error)) {
      throw error;
    }
    // The error's name only: a parser's message may quote the file.
    log.warn("chat.file_unreadable", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw uploadErrors.create("upload.unreadable");
  }
};

/**
 * The file `input` names, checked, with its text: refused as unsupported
 * when its name has no type a chat file takes or it doesn't start as its
 * type does, as too large past {@link chatFileMaxBytes} (or with text past
 * {@link chatFileTextMaxBytes}), and as unreadable or without text when
 * its text can't be read.
 */
export const readChatFile = async (
  env: LocalExtractorEnv,
  input: unknown
): Promise<{
  name: string;
  type: ChatFileType;
  bytes: number;
  text: string;
}> => {
  const parsed = chatFileInputSchema.safeParse(input);
  if (!parsed.success) {
    throw agentErrors.create("agent.file_unsupported");
  }
  const { name, bytes } = parsed.data;
  const type = chatFileTypeOf(name);
  if (type === undefined) {
    throw agentErrors.create("agent.file_unsupported");
  }
  // By the bytes that arrived, never by a size anyone reported.
  if (bytes.byteLength > chatFileMaxBytes) {
    throw agentErrors.create("agent.file_too_large");
  }
  let text: string;
  if (isExtracted(type)) {
    if (!signatures[type](bytes)) {
      throw agentErrors.create("agent.file_unsupported");
    }
    text = await extractedText(env, name, type, bytes);
  } else {
    text = textOf(bytes);
  }
  if (new TextEncoder().encode(text).byteLength > chatFileTextMaxBytes) {
    throw agentErrors.create("agent.file_too_large");
  }
  if (!hasText(text)) {
    throw uploadErrors.create("upload.no_text");
  }
  return { name, type, bytes: bytes.byteLength, text };
};

/**
 * The picture `input` holds, by its bytes alone, whatever its name says;
 * `undefined` for anything that isn't one, to be read as a file by its
 * name (`readChatFile`). Refused as too large past
 * {@link chatPictureMaxBytes} or {@link chatPictureMaxPixels} a side, and
 * as unsupported when its header says it has no pixels or it stops
 * short of its end.
 */
export const readChatPicture = (
  input: unknown
):
  | { name: string; type: ChatPictureType; bytes: number; picture: Uint8Array }
  | undefined => {
  const parsed = chatFileInputSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  const { name, bytes } = parsed.data;
  const header = imageHeaderOf(bytes);
  if (header === undefined) {
    return undefined;
  }
  if (bytes.byteLength > chatPictureMaxBytes) {
    throw agentErrors.create("agent.file_too_large");
  }
  if (
    header.width < 1 ||
    header.height < 1 ||
    !imageEnded(bytes, header.type)
  ) {
    throw agentErrors.create("agent.file_unsupported");
  }
  if (
    header.width > chatPictureMaxPixels ||
    header.height > chatPictureMaxPixels
  ) {
    throw agentErrors.create("agent.file_too_large");
  }
  return {
    name,
    type: pictureTypes[header.type],
    bytes: bytes.byteLength,
    picture: bytes,
  };
};
