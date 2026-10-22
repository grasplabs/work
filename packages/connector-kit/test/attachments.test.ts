import { attachmentLimits } from "@grasp-os/shared/connector-attachments";
import { sha256HexOfBytes, toBase64 } from "@grasp-os/shared/encoding";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  attachedFiles,
  attachmentsInput,
  defineConnector,
  defineTool,
} from "../src/connector.ts";
import { attachmentsMetaKey } from "../src/manifest.ts";
import type { Route } from "../src/manifest.ts";

// A write that takes files (GRA-887), as a connector defines it and
// connect calls it. The ways it can fail come first: bytes beside the
// input that aren't the files it names (a part missing, one extra, one
// that hashes to another digest or is another length), files given to a
// tool that takes none, entries that break a limit or put a path or
// control character in a name, and a tool that declares files with a
// schema of its own, whose limits would then be its own.

const route: Route = {
  method: "POST",
  host: "api.example.test",
  path: "/v1/send",
};

/** What the sending tool received: each file's name, type and content. */
const received: { name: string; type: string; text: string }[][] = [];

const sendTool = defineTool({
  name: "mail.send",
  description: "Sends a message",
  input: z.strictObject({
    mailbox: z.string(),
    attachments: attachmentsInput,
  }),
  output: z.strictObject({ sent: z.literal(true) }),
  readOnly: false,
  takesFiles: true,
  resource: "mailbox",
  routes: [route],
  run: async (input, effect) => {
    received.push(
      attachedFiles(input.attachments, effect).map(({ name, type, bytes }) => ({
        name,
        type,
        text: new TextDecoder().decode(bytes),
      }))
    );
    return await Promise.resolve({ output: { sent: true as const } });
  },
});

const plainTool = defineTool({
  name: "mail.note",
  description: "Writes a note",
  input: z.strictObject({ text: z.string() }),
  output: z.strictObject({ done: z.literal(true) }),
  readOnly: false,
  routes: [route],
  run: async () => await Promise.resolve({ output: { done: true as const } }),
});

const connector = defineConnector({
  name: "example",
  version: "1.0.0",
  provider: "microsoft",
  scopes: [],
  hosts: ["api.example.test"],
  tools: [sendTool, plainTool],
});

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A file's entry, as an input names it. */
const entryOf = async (name: string, text: string, size?: number) => ({
  name,
  type: "text/plain" as const,
  size: size ?? bytesOf(text).length,
  sha256: await sha256HexOfBytes(bytesOf(text)),
});

/** The files' bytes as connect sends them: base64 by digest. */
const sentOf = async (...texts: string[]): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      texts.map(async (text): Promise<[string, string]> => [
        await sha256HexOfBytes(bytesOf(text)),
        toBase64(bytesOf(text)),
      ])
    )
  );

interface CallResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { text?: string }[];
}

/** A tool call over MCP, as connect makes it. */
const call = async (
  tool: string,
  args: unknown,
  files?: Record<string, string>
): Promise<CallResult> => {
  const response = await connector.fetch(
    new Request("https://connector.internal/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: tool,
          arguments: args,
          ...(files === undefined
            ? {}
            : { _meta: { [attachmentsMetaKey]: files } }),
        },
      }),
    })
  );
  const body = z
    .object({ result: z.unknown() })
    .parse(await response.json()).result;
  return z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z.array(z.object({ text: z.string().optional() })).optional(),
    })
    .parse(body);
};

describe("a tool that takes files", () => {
  it("is a write whose contract names run files by ID, and whose own input names them by digest", () => {
    const { takesFiles, input, contract } = connector.manifest.actions[
      "mail.send"
    ] ?? { input: [], contract: { input: {} } };
    expect(takesFiles).toBeTruthy();
    expect(input).toContain("attachments");
    const { properties } = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(contract.input);
    // The workflow-facing form: an array of `{ file }`, an ID and nothing else.
    expect(properties.attachments).toMatchObject({
      type: "array",
      maxItems: attachmentLimits.files,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
      },
    });
    expect(JSON.stringify(properties.attachments)).not.toContain("sha256");
    expect(connector.manifest.actions["mail.note"]?.takesFiles).toBeUndefined();
  });

  it("can't be read-only, and can't declare its attachments any other way", () => {
    const base = {
      name: "mail.send",
      description: "Sends",
      output: z.strictObject({}),
      routes: [route],
      takesFiles: true as const,
      run: async () => await Promise.resolve({ output: {} }),
    };
    expect(() =>
      defineTool({
        ...base,
        input: z.strictObject({ attachments: attachmentsInput }),
        readOnly: true,
      })
    ).toThrow(/only a write takes files/u);
    // No `attachments` input at all.
    expect(() =>
      defineTool({
        ...base,
        input: z.strictObject({ text: z.string() }),
        readOnly: false,
      })
    ).toThrow(/attachments/u);
    // A schema of its own: looser limits than the platform's would be its own.
    expect(() =>
      defineTool({
        ...base,
        input: z.strictObject({
          attachments: z
            .array(
              z.strictObject({
                name: z.string(),
                type: z.string(),
                size: z.int(),
                sha256: z.string(),
              })
            )
            .optional(),
        }),
        readOnly: false,
      })
    ).toThrow(/attachments/u);
  });

  it("is given exactly the files its input names, whatever order they come in and however often one is named", async () => {
    received.length = 0;
    const twice = await entryOf("a.txt", "same");
    const result = await call(
      "mail.send",
      {
        mailbox: "ana@acme.test",
        attachments: [
          await entryOf("one.txt", "first"),
          twice,
          { ...twice, name: "b.txt" },
        ],
      },
      await sentOf("same", "first")
    );
    expect(result.isError).toBeFalsy();
    expect(received).toStrictEqual([
      [
        { name: "one.txt", type: "text/plain", text: "first" },
        { name: "a.txt", type: "text/plain", text: "same" },
        { name: "b.txt", type: "text/plain", text: "same" },
      ],
    ]);
  });

  it("is sent nothing without attachments, and runs with no files", async () => {
    received.length = 0;
    const result = await call("mail.send", { mailbox: "ana@acme.test" });
    expect(result.isError).toBeFalsy();
    expect(received).toStrictEqual([[]]);
  });

  it("refuses bytes that aren't the files its input names, before running", async () => {
    received.length = 0;
    const named = [await entryOf("a.txt", "alpha")];
    const input = { mailbox: "ana@acme.test", attachments: named };
    const [alpha] = Object.entries(await sentOf("alpha"));
    const key = alpha?.[0] ?? "";
    const refused = [
      // Missing: the input names a file, no bytes come.
      await call("mail.send", input),
      await call("mail.send", input, {}),
      // Extra: a part no entry names.
      await call("mail.send", input, await sentOf("alpha", "beta")),
      // Another file's content under the right digest.
      await call("mail.send", input, { [key]: toBase64(bytesOf("omega")) }),
      // The right content, another length than its entry says.
      await call(
        "mail.send",
        {
          ...input,
          attachments: [await entryOf("a.txt", "alpha", 4)],
        },
        await sentOf("alpha")
      ),
      // Bytes with no files named at all.
      await call(
        "mail.send",
        { mailbox: "ana@acme.test" },
        await sentOf("alpha")
      ),
      // Not base64, and not an object of parts.
      await call("mail.send", input, { [key]: "not base64!" }),
    ];
    expect(refused.map(({ isError }) => isError)).toStrictEqual(
      refused.map(() => true)
    );
    expect(received).toStrictEqual([]);
  });

  it("refuses files for a tool that takes none", async () => {
    const result = await call(
      "mail.note",
      { text: "hi" },
      await sentOf("alpha")
    );
    expect(result.isError).toBeTruthy();
  });

  it("refuses entries that break a limit or put a path or a control character in a name", async () => {
    received.length = 0;
    const ok = await entryOf("a.txt", "alpha");
    const files = await sentOf("alpha");
    const inputs = [
      // Names a run file can't have.
      [{ ...ok, name: "../a.txt" }],
      [{ ...ok, name: "a\r\nBcc: x@evil.test" }],
      [{ ...ok, name: `a${String.fromCodePoint(0x20_2e)}txt.exe` }],
      [{ ...ok, name: " a.txt" }],
      // A type no run file has.
      [{ ...ok, type: "text/html" }],
      // Past the files of one write.
      Array.from({ length: attachmentLimits.files + 1 }, () => ok),
      // Past one file's, and all of a write's, bytes.
      [{ ...ok, size: attachmentLimits.fileBytes + 1 }],
      Array.from({ length: 3 }, () => ({
        ...ok,
        size: attachmentLimits.fileBytes,
      })),
      // An entry with more than its four fields.
      [{ ...ok, path: "/etc/passwd" }],
    ];
    for (const attachments of inputs) {
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      const result = await call(
        "mail.send",
        { mailbox: "ana@acme.test", attachments },
        files
      );
      expect(result.isError).toBeTruthy();
    }
    expect(received).toStrictEqual([]);
  });
});
