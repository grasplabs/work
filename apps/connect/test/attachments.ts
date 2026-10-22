/**
 * Files a write attaches, as the tests of the native mail connectors make
 * them: each with the entry an input names it by, and its bytes.
 */
import type {
  AttachmentBytes,
  AttachmentEntry,
} from "@grasp-os/shared/connector-attachments";
import { sha256HexOfBytes } from "@grasp-os/shared/encoding";

/** A file a write attaches: its entry, and its bytes. */
export interface Attached {
  entry: AttachmentEntry;
  bytes: Uint8Array<ArrayBuffer>;
}

export const attach = async (
  name: string,
  type: AttachmentEntry["type"],
  content: string | Uint8Array<ArrayBuffer>
): Promise<Attached> => {
  const bytes =
    typeof content === "string"
      ? Uint8Array.from(new TextEncoder().encode(content))
      : content;
  return {
    entry: {
      name,
      type,
      size: bytes.length,
      sha256: await sha256HexOfBytes(bytes),
    },
    bytes,
  };
};

/** The bytes of `files`, by SHA-256, as a call carries them. */
export const bytesOf = (files: readonly Attached[]): AttachmentBytes =>
  Object.fromEntries(files.map(({ entry, bytes }) => [entry.sha256, bytes]));
