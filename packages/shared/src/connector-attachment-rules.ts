import { sha256HexOfBytes } from "./encoding.ts";

// What a connector's attachments are held to (GRA-887) that needs no
// schema: the limits, the property, the digest and run file ID forms, the
// contract's shape of a run file reference, and how bytes are checked
// against their entries. Kept apart from connector-attachments.ts, and free
// of Zod, so a connector's isolate checks a call's files without loading it.

const mib = 1024 * 1024;

/**
 * What one write attaches, at most (GRA-887): inside the provider's
 * request bound for a message that carries its files inline. Microsoft
 * Graph's `sendMail` takes a JSON body of about 4 MB, where each file is
 * base64 (4 bytes for every 3): 2.75 MiB of files is about 3.67 MiB of
 * base64, which leaves room for the message itself. A larger file needs
 * an upload session, a later path.
 */
export const attachmentLimits = {
  /** Files in one write. */
  files: 10,
  /** One file's bytes. */
  fileBytes: 2.75 * mib,
  /** All of one write's files' bytes together. */
  totalBytes: 2.75 * mib,
} as const;

/** A SHA-256 as lowercase hex. */
export const sha256Pattern = /^[0-9a-f]{64}$/u;

/** The name of an input property that carries a write's attachments. */
export const attachmentsProperty = "attachments";

/** Run file IDs are random UUIDs, lowercase as `crypto.randomUUID` writes them. */
export const runFileIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The contract's `attachments` property of a tool that takes files, as
 * JSON Schema: `attachmentRefsSchema` (connector-attachments.ts), which a
 * workflow's action names its run files by.
 */
export const attachmentRefsJsonSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      file: { type: "string", pattern: runFileIdPattern.source },
    },
    required: ["file"],
    additionalProperties: false,
  },
  maxItems: attachmentLimits.files,
};

/**
 * Whether `bytes` are exactly the files `entries` name: a part for each
 * digest and no other, each as long as its entries say and hashing to its
 * key. Equal files (the same digest) are one part; their entries must all
 * give its length.
 */
export const attachmentsMatch = async (
  entries: readonly { sha256: string; size: number }[],
  bytes: Readonly<Record<string, Uint8Array>>
): Promise<boolean> => {
  const wanted = new Map<string, number>();
  for (const { sha256, size } of entries) {
    if ((wanted.get(sha256) ?? size) !== size) {
      return false;
    }
    wanted.set(sha256, size);
  }
  const supplied = Object.keys(bytes);
  if (
    supplied.length !== wanted.size ||
    !supplied.every((sha256) => wanted.has(sha256))
  ) {
    return false;
  }
  const checks = await Promise.all(
    [...wanted].map(async ([sha256, size]) => {
      const part = bytes[sha256];
      return (
        part !== undefined &&
        part.byteLength === size &&
        (await sha256HexOfBytes(part)) === sha256
      );
    })
  );
  return checks.every(Boolean);
};
