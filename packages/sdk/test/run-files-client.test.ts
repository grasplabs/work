import { describe, expect, test } from "vite-plus/test";

import {
  callBytes,
  filesResource,
  fromBase64,
  piecesOf,
  toBase64,
} from "../src/run-files-client.ts";

/** Field `key` of `value`, as data. */
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

// The client of a run's files in an action (GRA-724): a write goes as an
// open, its pieces of at most `callBytes`, and a finish; a read gathers
// its pieces back; bytes survive base64 both ways.

describe("a files use's client", () => {
  test("keeps every byte through base64", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, at) => at % 256);
    expect(fromBase64(toBase64(bytes))).toStrictEqual(bytes);
  });

  test("writes in pieces of at most a call's bytes, then reads them back", async () => {
    const stored: Uint8Array[] = [];
    const calls: string[] = [];
    const callHost = async (alias: string, call: unknown): Promise<unknown> => {
      const operation = String(fieldOf(call, "operation"));
      const args: unknown = fieldOf(call, "arguments");
      calls.push(`${alias}:${operation}`);
      await Promise.resolve();
      if (operation === "append") {
        stored.push(fromBase64(String(fieldOf(args, "content"))));
      }
      if (operation === "read") {
        const all = new Uint8Array(stored.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const piece of stored) {
          all.set(piece, at);
          at += piece.length;
        }
        const offset = Number(fieldOf(args, "offset"));
        const length = Number(fieldOf(args, "length"));
        return {
          content: toBase64(all.subarray(offset, offset + length)),
          size: all.length,
        };
      }
      return { file: "f" };
    };
    const files = filesResource("files", callHost);
    const text = "é".repeat(callBytes);
    await Reflect.apply(Reflect.get(files, "write"), files, [
      { name: "a.txt", type: "text/plain", content: text },
    ]);
    const read: unknown = await Reflect.apply(
      Reflect.get(files, "read"),
      files,
      [{ file: "f" }]
    );
    expect({
      pieces: stored.map(({ length }) => length <= callBytes),
      piecesOfEmpty: piecesOf(new Uint8Array()).length,
      calls,
      same: read === text,
    }).toStrictEqual({
      // "é" is two bytes: two full pieces.
      pieces: [true, true],
      piecesOfEmpty: 0,
      calls: [
        "files:open",
        ...Array.from({ length: 2 }, () => "files:append"),
        "files:finish",
        ...Array.from({ length: 2 }, () => "files:read"),
      ],
      same: true,
    });
  });
});
