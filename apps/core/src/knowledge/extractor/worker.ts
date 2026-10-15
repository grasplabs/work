import { readWhole } from "@grasp-os/shared/chunks";
import type { ChunkRead } from "@grasp-os/shared/chunks";
import { WorkerEntrypoint } from "cloudflare:workers";

import { extractedPart } from "./asset.ts";
import { formats, TooLargeError } from "./formats.ts";

// The extractor's sandbox: the one module of a Dynamic Worker core starts
// for each extraction (extract.ts), built into core's static assets
// (build-extractor.ts). It gets no bindings, no network and a CPU limit,
// so a file crafted to exhaust a parser (a PDF with a stream that inflates
// to gigabytes, say) exhausts this isolate, never core's.

/**
 * The most Markdown it hands back, in bytes of UTF-8: a document's limit
 * (knowledge/documents.ts). Anything longer couldn't be saved, and isn't
 * sent back to core.
 */
const markdownMaxBytes = 1024 * 1024;

/** What an extraction returns: the Markdown, or why there is none. */
export type Extracted =
  | { ok: true; markdown: string }
  | { ok: false; reason: "unreadable" | "too_large" };

/** Extracts one file's text; started once per extraction. */
export default class Extractor extends WorkerEntrypoint {
  // Cap'n Web-style RPC exposes prototype methods only.
  // oxlint-disable-next-line class-methods-use-this
  async extract(file: {
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<Extracted> {
    const format = formats[file.mediaType];
    if (format === undefined) {
      return { ok: false, reason: "unreadable" };
    }
    let markdown: string;
    try {
      markdown = await format(file.bytes);
    } catch (error) {
      // Only why: a parser's message may quote the file.
      return {
        ok: false,
        reason: error instanceof TooLargeError ? "too_large" : "unreadable",
      };
    }
    if (new TextEncoder().encode(markdown).byteLength > markdownMaxBytes) {
      return { ok: false, reason: "too_large" };
    }
    return { ok: true, markdown };
  }

  /**
   * The same, with the file's `size` bytes read through `read` as part
   * `file`, a chunk at a time: on the on-prem sandbox host (extract.ts),
   * where one message can't carry both this module and an upload. A chunk
   * that isn't bytes, is empty or runs past `size` makes the file
   * unreadable.
   */
  async extractRead(
    mediaType: string,
    size: number,
    read: ChunkRead
  ): Promise<Extracted> {
    let bytes: Uint8Array;
    try {
      bytes = await readWhole(read, extractedPart, size);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    return await this.extract({ mediaType, bytes });
  }
}
