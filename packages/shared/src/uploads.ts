import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Uploads: a file whose text core extracts (core's files/extract.ts): into
// the Brain (brain-uploads.ts), into a chat (chat-files.ts) or into the
// onboarding's documents. A PDF, a Word, Excel or PowerPoint file, WebVTT
// captions, a web page, and text in any of the forms people keep it in.

/**
 * The file types an upload may be, by the extension its name ends in:
 * each one core has a reader for (files/extractor/formats.ts).
 */
export const uploadTypes = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  vtt: "text/vtt",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
} as const;
export type UploadExtension = keyof typeof uploadTypes;
export type UploadMediaType = (typeof uploadTypes)[UploadExtension];

/** Largest file one upload takes, in bytes: 10 MB. */
export const uploadMaxBytes = 10 * 1024 * 1024;

/**
 * Longest file name, in characters: the document's title is the name
 * without its extension, and a title has at most 200.
 */
export const uploadNameMaxLength = 200;

const extensionPattern = /\.(?<extension>[A-Za-z]+)$/u;

const isExtension = (value: string): value is UploadExtension =>
  Object.hasOwn(uploadTypes, value);

/** The upload type of a file name, by its extension; `undefined` for none. */
export const uploadExtensionOf = (
  name: string
): UploadExtension | undefined => {
  const extension = extensionPattern
    .exec(name)
    ?.groups?.extension?.toLowerCase();
  return extension !== undefined && isExtension(extension)
    ? extension
    : undefined;
};

// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const notInFileName = /[\u0000-\u001F\u007F/\\[\]#|]/u;

/**
 * A file's name, which is also the path of its document: no folders, and
 * none of the characters links use.
 */
export const uploadNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(uploadNameMaxLength)
  .refine((name) => !notInFileName.test(name), {
    message: "A file name has no /, \\, [, ], #, | or control characters",
  })
  .refine((name) => name !== "." && name !== "..", {
    message: "A file name isn't . or ..",
  });

export const uploadErrors = defineErrorFamily({
  "upload.invalid": "That isn't a valid upload.",
  "upload.too_large": "This file is over the upload limit of 10 MB.",
  "upload.unsupported":
    "That kind of file can't be uploaded. Upload a PDF, a Word (.docx), Excel (.xlsx) or PowerPoint (.pptx) file, a web page (.html), WebVTT captions (.vtt), or a text file (.txt, .md, .csv, .tsv, .json, .xml, .yaml).",
  "upload.unreadable":
    "The file's text couldn't be read. Check that it opens, then upload it again.",
  "upload.text_too_large": "This document is too large to save.",
  "upload.too_complex":
    "The file takes more work to read than an upload may take: it may be damaged, or built to be. Check that it opens, or save it again as a simpler file, then upload it again.",
  "upload.no_text":
    "The file has no text to read: a scan without a text layer has none.",
});
