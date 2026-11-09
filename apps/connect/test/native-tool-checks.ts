import { describe, expect, it } from "vite-plus/test";

import { filePart } from "../../../scripts/test-file-parts.ts";
import { nativeConnector } from "../src/bundled-connectors.ts";
import { outcome } from "./connect.ts";
import { api, connectionOf, tools } from "./connectors-harness.ts";
import { callTool as call, toolError } from "./tool-calls.ts";

// The check of every native tool's input, which
// native-tools-<part>-of-<parts>.test.ts share out: it took longer than
// one file may, so each file checks the part of the tools its name says
// (scripts/test-file-parts.ts), every `parts`-th from its `part`th, each
// part a mix of connectors. connectors.test.ts reads every such file's
// name and checks that together they check every tool once.

/**
 * The native tools the file `file` (a path or URL) checks, from its own
 * name: `native-tools-<part>-of-<parts>.test.ts`, every `parts`-th tool
 * from the `part`th.
 */
export const nativeToolsOf = (file: string): typeof tools => {
  const { run, part, parts } = filePart(file);
  if (run !== "native-tools") {
    throw new Error(
      `${run} checks no native tools: native-tools-<part>-of-<parts>.test.ts`
    );
  }
  return tools.filter((_, index) => index % parts === part - 1);
};

/**
 * The native tools the file `file` (its `import.meta.url`) names
 * (`nativeToolsOf`), each refusing a second resource selector.
 */
export const everyNativeTool = (file: string): void => {
  const checked = nativeToolsOf(file);
  // Each tool makes several calls at once, each in a fresh isolate: on a
  // loaded CI runner the slowest took a third of Vitest's default five
  // seconds. The calls go out together and nothing polls or sleeps, so
  // sixty seconds is room for a slow runner, as in connectors.test.ts.
  describe("every native tool", { timeout: 60_000 }, () => {
    it.each(checked)(
      "$connector $action refuses a second resource selector",
      async ({ connector, provider, action }) => {
        const connection = await connectionOf(connector, provider);
        const manifest = nativeConnector(connector)?.manifest;
        const tool = manifest?.actions[action];
        const field = tool?.resource ?? "mailbox";
        const declared = new Set(tool?.input);
        const extra = [`shared${field}`, "target", "userId"].filter(
          (key) => !declared.has(key)
        );
        const undeclared = [
          { [field]: "a@acme.test", [extra[0] ?? "x"]: "b@acme.test" },
          {
            [field]: "a@acme.test",
            [extra[1] ?? "y"]: { [field]: "b@acme.test" },
          },
          { [field]: "a@acme.test", [extra[2] ?? "z"]: "b@acme.test" },
        ];
        // Nor nested under a property it does declare. Connect itself refuses
        // a nested selector under the attachments of a tool that takes files
        // (GRA-887), before the tool: checked apart below.
        const filesField =
          tool?.takesFiles === true ? "attachments" : undefined;
        const nested = [...declared]
          .filter((other) => other !== field && other !== filesField)
          .map((other) => ({
            [field]: "a@acme.test",
            [other]: { [field]: "b@acme.test" },
          }));
        const refusals = await Promise.all(
          [...undeclared, ...nested].map(
            async (input) =>
              await toolError(
                call(connection, action, input, {
                  idempotencyKey: crypto.randomUUID(),
                })
              )
          )
        );
        expect(
          refusals
            .slice(0, undeclared.length)
            .every((text) => String(text).includes("unrecognized_keys"))
        ).toBeTruthy();
        expect(
          refusals
            .slice(undeclared.length)
            .every((text) => String(text).includes("Invalid input"))
        ).toBeTruthy();
        const refusedByConnect =
          filesField === undefined
            ? undefined
            : await outcome(
                call(
                  connection,
                  action,
                  {
                    [field]: "a@acme.test",
                    [filesField]: { [field]: "b@acme.test" },
                  },
                  { idempotencyKey: crypto.randomUUID() }
                )
              );
        expect(refusedByConnect).toBe(
          filesField === undefined ? undefined : "connect.invalid"
        );
        expect(api.sent).toStrictEqual([]);
      }
    );
  });
};
