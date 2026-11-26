import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vite-plus/test";

import grasp from "./grasp-plugin.ts";

// grasp/no-unexplained-json as oxlint runs it, over a connector's values:
// what it refuses and what it lets through. What the OpenAPI generator
// writes (`tools.gen.ts`) is in the lint's ignore patterns (vite.config.ts),
// so no rule reads it.

// Its cases as Vitest's own: RuleTester takes them through its static
// `describe` and `it`.
Object.assign(RuleTester, { describe, it });

const tester = new RuleTester();

const imports = 'import { tool, v } from "@grasp-os/sdk/connector";\n';

/** A connector's `code`, refused `count` times. */
const free = (name: string, code: string, count = 1) => ({
  name,
  code,
  filename: "connector.ts",
  errors: Array.from({ length: count }, () => ({ messageId: "free" })),
});

/** A connector's `code`, let through. */
const typed = (name: string, code: string) => ({
  name,
  code,
  filename: "connector.ts",
});

/**
 * Whether `value` is a rule as RuleTester takes it. The plugin is written
 * to oxlint's rule API, but its own types name only the parts of a node and
 * a context it reads, so they don't line up with oxlint's.
 */
const isRule = (value: unknown): value is Parameters<RuleTester["run"]>[1] =>
  typeof value === "object" && value !== null && "create" in value;

const rule = grasp.rules["no-unexplained-json"];
if (!isRule(rule)) {
  throw new Error("grasp/no-unexplained-json isn't a rule");
}

tester.run("grasp/no-unexplained-json", rule, {
  invalid: [
    free(
      "a tool's argument",
      `${imports}tool({ args: { filter: v.json() }, returns: v.string() });`
    ),
    free(
      "a tool's answer, nested",
      `${imports}tool({ args: {}, returns: v.object({ item: v.record(v.json()) }) });`
    ),
    free(
      "a schema the tool takes from a const",
      `${imports}const Fields = v.record(v.json());\ntool({ args: { fields: Fields }, returns: v.string() });`
    ),
    free(
      "the SDK's v under another name",
      'import { v as s } from "@grasp-os/sdk/connector";\nconst Any = s.json();'
    ),
    free(
      "v read off a namespace import",
      'import * as sdk from "@grasp-os/sdk/connector";\nconst Any = sdk.v.json();'
    ),
    free(
      "v from the connector's own file",
      'import { v } from "./schemas.ts";\nconst Any = v.json();'
    ),
    free(
      "a comment before the object that holds its property",
      `${imports}tool({\n  // The deal as the vendor answers it.\n  returns: v.object({ deal: v.json() }),\n});`
    ),
    free(
      "a comment that only turns another rule off",
      `${imports}const Deal = v.object({\n  // oxlint-disable-next-line no-console\n  fields: v.json(),\n});`
    ),
    free(
      "a comment for TypeScript",
      `${imports}const Deal = v.object({\n  // @ts-expect-error -- not a shape\n  fields: v.json(),\n});`
    ),
    free(
      "a comment for the formatter",
      `${imports}const Deal = v.object({\n  // prettier-ignore\n  fields: v.json(),\n});`
    ),
    free(
      "a comment with no words",
      `${imports}const Deal = v.object({\n  /** */\n  fields: v.json(),\n});`
    ),
    free(
      "the next property after a comment that ends a line",
      `${imports}const Deal = v.object({\n  fields: v.json(), // Each company names its own.\n  owner: v.json(),\n});`,
      2
    ),
    free(
      "the next statement after a comment that ends a line",
      `${imports}const Fields = v.json(); // Each company names its own.\nconst Owner = v.json();`,
      2
    ),
    free(
      "a comment before it on its statement's line",
      `${imports}/* Each company names its own custom fields. */ const Fields = v.json();`
    ),
    free(
      "a comment a blank line away",
      `${imports}const Deal = v.object({\n  // Each company names its own custom fields.\n\n  fields: v.json(),\n});`
    ),
    free(
      "a comment ending its property's line",
      `${imports}const Deal = v.object({\n  fields: v.json(), // Each company names its own.\n});`
    ),
    free(
      "a comment before it on its line",
      `${imports}const Value = v.union(v.string(), /* The vendor's own. */ v.json());`
    ),
    free(
      "the properties after an explained one",
      `${imports}const Deal = v.object({\n  // Each company names its own custom fields.\n  fields: v.json(),\n  owner: v.json(),\n  item: v.json(),\n});`,
      2
    ),
  ],
  valid: [
    typed(
      "a comment before its property",
      `${imports}tool({\n  args: {},\n  returns: v.object({\n    // Each company names its own custom fields.\n    custom_fields: v.record(v.json()).optional(),\n  }),\n});`
    ),
    typed(
      "a comment on the line before it among arguments",
      `${imports}const Value = v.union(\n  v.string(),\n  // Any of the vendor's own.\n  v.json()\n);`
    ),
    typed(
      "a comment before its declaration",
      `${imports}/** Each company names its own custom fields. */\nconst Fields = v.record(v.json());`
    ),
    typed(
      "a comment before its exported declaration",
      `${imports}// Each company names its own custom fields.\nexport const Fields = v.record(v.json());`
    ),
    typed(
      "a typed schema",
      `${imports}tool({ args: { id: v.string() }, returns: v.object({ ok: v.boolean() }) });`
    ),
    typed(
      "a response's json()",
      `${imports}const read = async (response) => await response.json();`
    ),
    typed(
      "json() on a v the SDK didn't give",
      "const v = { json: () => ({}) };\nconst Any = v.json();"
    ),
    typed(
      "json() on a parameter that hides the imported v",
      `${imports}const read = (v) => v.json();`
    ),
  ],
});
