import type { UploadExtension } from "@grasp-os/shared/uploads";

// What a file is checked by before its text is kept, wherever it came in:
// a Knowledge upload (uploads.ts), a file attached to a chat
// (chat-files.ts), a document given to an agent (agent-documents.ts). By
// the bytes that arrived, never by what anyone said of them.

/** Bytes, as the first bytes of a file are compared. */
const bytesOf = (text: string): number[] => [...new TextEncoder().encode(text)];

/** Whether `bytes` start with `prefix`. */
const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((byte, index) => bytes[index] === byte);

/** UTF-8's byte order mark. */
const byteOrderMark = [0xef, 0xbb, 0xbf];

/** What ends WebVTT's signature: a space, a tab, a line break, or the file. */
const afterVttSignature: ReadonlySet<number | undefined> = new Set([
  0x20,
  0x09,
  0x0a,
  0x0d,
  undefined,
]);

const vttSignature = bytesOf("WEBVTT");

/**
 * Whether a file starts as its type does: a PDF's header, a ZIP's for
 * Office files, and WebVTT's signature (after a byte order mark, if any)
 * as the WebVTT spec defines it.
 */
export const signatures: Readonly<
  Record<UploadExtension, (bytes: Uint8Array) => boolean>
> = {
  pdf: (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  docx: (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]),
  xlsx: (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]),
  vtt: (bytes) => {
    const text = startsWith(bytes, byteOrderMark)
      ? bytes.subarray(byteOrderMark.length)
      : bytes;
    return (
      startsWith(text, vttSignature) &&
      afterVttSignature.has(text[vttSignature.length])
    );
  },
};

const headingMarks = /^#{1,6}\s/gmu;
const tableSyntax = /[\s|-]/gu;
const pageHeading = /^#{1,6} Page \d+$/gmu;

/**
 * Whether Markdown holds any text: a heading's counts, table rules and
 * the page headings a PDF's sections get don't.
 */
export const hasText = (markdown: string): boolean =>
  markdown
    .replaceAll(pageHeading, "")
    .replaceAll(headingMarks, "")
    .replaceAll(tableSyntax, "") !== "";
