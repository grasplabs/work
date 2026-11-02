import { agentErrors } from "@grasp-os/shared/agent";
import {
  chatFileMaxBytes,
  chatFileTypeOf,
  chatFileTypes,
} from "@grasp-os/shared/chat";
import type { ChatFileType } from "@grasp-os/shared/chat";
import { isExpectedError } from "@grasp-os/shared/errors";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { log } from "@grasp-os/shared/log";
import { uploadErrors, uploadNameSchema } from "@grasp-os/shared/uploads";
import { z } from "zod";

import {
  ExtractorUnavailableError,
  localExtractor,
} from "./knowledge/extract.ts";
import type { LocalExtractorEnv } from "./knowledge/extract.ts";
import { hasText, signatures } from "./knowledge/uploads.ts";

// Reading a file attached to a chat's question (`chats.attachFile`): its
// text, as the agent reads it. Checked as a Knowledge upload is, by what
// arrived (its size, and that a PDF or Office file starts as its type
// does), and read with Knowledge's local extractor, in a sandbox of its
// own (knowledge/extract.ts). Never Workers AI's conversion: a chat file
// is the person's own, and Workers AI isn't pinned to the EU, so its
// content never leaves the deployment's own Workers. Text files are read
// as UTF-8, here. Only the text is kept (workspace.ts): no original.

/** Most text a chat file keeps, in bytes of UTF-8: what the extractor gives. */
export const chatFileTextMaxBytes = 1024 * 1024;

/** A file to attach, as the page sends it: a name and its bytes. */
const chatFileInputSchema = z.strictObject({
  name: uploadNameSchema,
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});

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
    if (knowledgeErrors.codeOf(error) === "knowledge.too_large") {
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
