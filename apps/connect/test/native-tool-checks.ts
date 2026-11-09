import { describe, expect, it } from "vite-plus/test";

import { nativeConnector } from "../src/bundled-connectors.ts";
import { outcome } from "./connect.ts";
import { api, connectionOf, tools } from "./connectors-harness.ts";
import { callTool as call, toolError } from "./tool-calls.ts";

// The check of every native tool's input, which native-tools-*.test.ts
// share out: it took longer than one file may, so each file checks a part
// of the tools, every `parts`-th from `part`, each part a mix of
// connectors.

/**
 * Part `part` (from 0) of `parts` of every native tool, each refusing a
 * second resource selector.
 */
export const everyNativeTool = (part: number, parts: number): void => {
  // Each tool makes several calls at once, each in a fresh isolate: on a
  // loaded CI runner the slowest took a third of Vitest's default five
  // seconds. The calls go out together and nothing polls or sleeps, so
  // sixty seconds is room for a slow runner, as in connectors.test.ts.
  describe("every native tool", { timeout: 60_000 }, () => {
    it.each(tools.filter((_, index) => index % parts === part))(
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
