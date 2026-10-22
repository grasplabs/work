// The client of a files binding (the run's own files, GRA-724) in an
// action's isolate: `write` and `read` as one call each to the action, in
// as many host calls as the file needs, each moving at most
// `callBytes`. A convenience, never the boundary: the host checks every
// call against the sealed use, the file's run and the limits.

// `callBytes` and `textTypes` are shared run-files.ts's own, written out:
// the compute runner imports none of the platform's shared modules (and
// with them zod) into an action's isolate. A test holds them equal
// (test/run-files-client.test.ts).

/** Bytes one call moves, as the host takes them: `runFileLimits.callBytes`. */
export const callBytes = 512 * 1024;

/** Characters of a binary string `btoa` and `atob` take at once. */
const pieceChars = 0x80_00;

/** `bytes` as base64. */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let at = 0; at < bytes.length; at += pieceChars) {
    binary += String.fromCodePoint(...bytes.subarray(at, at + pieceChars));
  }
  return btoa(binary);
};

/** The bytes `text`, base64, holds. */
export const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.codePointAt(at) ?? 0;
  }
  return bytes;
};

/** A field of `value`, read as data. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

/** The pieces `bytes` is sent in: at least one, so an empty file is one. */
export const piecesOf = (bytes: Uint8Array): Uint8Array[] => {
  const pieces: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += callBytes) {
    pieces.push(bytes.subarray(at, at + callBytes));
  }
  return pieces;
};

/** The bytes the `content` of a write holds: text as UTF-8. */
const bytesOf = (content: unknown): Uint8Array => {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  throw new TypeError("A file's content is text or bytes.");
};

/** The text types, the only ones a file may be empty of: `runFileTextTypes`. */
export const textTypes: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);

/** What one host call of a files use is: its operation and arguments. */
type CallHost = (alias: string, call: unknown) => Promise<unknown>;

/** A files use's client, its requests as the action passes them. */
export interface FilesClient {
  readonly write: (request: unknown) => Promise<unknown>;
  readonly read: (request: unknown) => Promise<unknown>;
  readonly list: () => Promise<unknown>;
  readonly delete: (request: unknown) => Promise<void>;
}

/**
 * A files use's client, as `ctx.resources.<alias>` holds it: every method,
 * as the host refuses one the use didn't declare.
 */
export const filesResource = (
  alias: string,
  callHost: CallHost
): FilesClient => {
  const call = async (operation: string, args: object): Promise<unknown> =>
    await callHost(alias, { operation, arguments: args });
  return {
    write: async (request: unknown): Promise<unknown> => {
      const bytes = bytesOf(field(request, "content"));
      // A binary type shows itself by its first bytes: an empty file of
      // one is never what it says, so it isn't sent at all.
      if (
        bytes.length === 0 &&
        !textTypes.has(String(field(request, "type")))
      ) {
        throw new TypeError(
          "A file of this type isn't empty: give it content."
        );
      }
      const opened = await call("open", {
        name: field(request, "name"),
        type: field(request, "type"),
      });
      const file = field(opened, "file");
      for (const piece of piecesOf(bytes)) {
        // oxlint-disable-next-line no-await-in-loop -- in order: each piece follows the last
        await call("append", { file, content: toBase64(piece) });
      }
      return await call("finish", { file });
    },
    read: async (request: unknown): Promise<unknown> => {
      const file = field(request, "file");
      const pieces: Uint8Array[] = [];
      let offset = 0;
      let size = 0;
      do {
        // oxlint-disable-next-line no-await-in-loop -- in order: each piece follows the last
        const read = await call("read", { file, offset, length: callBytes });
        const piece = fromBase64(String(field(read, "content")));
        size = Number(field(read, "size"));
        pieces.push(piece);
        offset += piece.length;
        if (piece.length === 0) {
          break;
        }
      } while (offset < size);
      const bytes = new Uint8Array(offset);
      let at = 0;
      for (const piece of pieces) {
        bytes.set(piece, at);
        at += piece.length;
      }
      return field(request, "as") === "bytes"
        ? bytes
        : new TextDecoder().decode(bytes);
    },
    list: async (): Promise<unknown> => await call("list", {}),
    delete: async (request: unknown): Promise<void> => {
      await call("delete", { file: field(request, "file") });
    },
  };
};
