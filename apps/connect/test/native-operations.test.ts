import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { nativeConnector } from "../src/bundled-connectors.ts";
import { outcome } from "./connect.ts";

// Which JSON Schemas connect confirms are a native action's (GRA-982): what
// lets a host catalog contract carry patterns core then runs. Threat model
// on GRA-982; the ways it can go wrong come first:
// - a schema like a connector's, its pattern swapped for a backtracking one;
// - a schema loosened, or a keyword added, anywhere in it;
// - a native action's schemas under another tool's name;
// - a Composio tool, or a request that isn't one.

/** `microsoft-365`'s action `tool`, as its manifest declares it. */
const declaredOf = (tool: string) => {
  const action = nativeConnector("microsoft-365")?.manifest.actions[tool];
  if (action === undefined) {
    throw new Error(`No action ${tool}`);
  }
  return action;
};

const confirm = async (tool: string, input: unknown, output: unknown) =>
  await exports.default.nativeOperation({
    tool,
    input: JSON.stringify(input),
    output: JSON.stringify(output),
  });

/** `value` with each object's keys in reverse order, at every depth. */
const reordered = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => reordered(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, item]) => [key, reordered(item)])
  );
};

/** `schema` with every `pattern` in it replaced by `pattern`. */
const withPattern = (schema: unknown, pattern: string): unknown =>
  JSON.parse(
    JSON.stringify(schema, (key, value: unknown) =>
      key === "pattern" ? pattern : value
    )
  );

describe("a native operation's schemas", () => {
  it("are confirmed only when exactly a native action's, under its own tool", async () => {
    const { contract } = declaredOf("mail.readAttachment");
    const send = declaredOf("mail.send");
    expect(JSON.stringify(contract.input)).toContain('"pattern"');
    expect({
      exact: await confirm(
        "mail.readAttachment",
        contract.input,
        contract.output
      ),
      reordered: await confirm(
        "mail.readAttachment",
        reordered(contract.input),
        reordered(contract.output)
      ),
      write: await confirm(
        "mail.send",
        send.contract.input,
        send.contract.output
      ),
      backtracking: await outcome(
        confirm(
          "mail.readAttachment",
          withPattern(contract.input, "^(a+)+$"),
          contract.output
        )
      ),
      loosened: await outcome(
        confirm(
          "mail.readAttachment",
          withPattern(contract.input, ".*"),
          contract.output
        )
      ),
      keywordAdded: await outcome(
        confirm(
          "mail.readAttachment",
          { ...contract.input, multipleOf: 2 },
          contract.output
        )
      ),
      otherTool: await outcome(
        confirm("mail.send", contract.input, contract.output)
      ),
      composio: await outcome(
        confirm("HUBSPOT_LIST_CONTACTS", { type: "object" }, { type: "object" })
      ),
      notJson: await outcome(
        exports.default.nativeOperation({
          tool: "mail.readAttachment",
          input: "{",
          output: "{}",
        })
      ),
      invalid: await outcome(
        exports.default.nativeOperation({ tool: "mail.readAttachment" })
      ),
    }).toStrictEqual({
      exact: {
        contract: "microsoft-365.mail@1",
        readOnly: true,
        answersFile: true,
      },
      reordered: {
        contract: "microsoft-365.mail@1",
        readOnly: true,
        answersFile: true,
      },
      write: { contract: "microsoft-365.mail@1", readOnly: false },
      backtracking: "connect.contract_not_found",
      loosened: "connect.contract_not_found",
      keywordAdded: "connect.contract_not_found",
      otherTool: "connect.contract_not_found",
      composio: "connect.contract_not_found",
      notJson: "connect.contract_not_found",
      invalid: "connect.invalid",
    });
  });
});
