import { describe, expect, it } from "vite-plus/test";

import { declarationOf, searchTools } from "../src/tool-search.ts";
import type { SearchableTool } from "../src/tool-search.ts";

// A tool's types, as the chat's agent reads them, from a schema a vendor's
// server lists: untrusted, so however it nests, what is written of it
// stays small and is written at once.

/** A tool of `input`'s schema, otherwise plain. */
const toolOf = (input: unknown): SearchableTool => ({
  connection: "CRM",
  action: "deals.find",
  tag: "crm deals",
  toolClass: "read-company",
  ask: false,
  description: "Finds deals.",
  input: JSON.stringify(input),
  output: JSON.stringify(input),
});

/** A schema each level of which lists its type twice, `levels` deep. */
const doubled = (levels: number): unknown => {
  let schema: unknown = { type: "string" };
  for (let level = 0; level < levels; level += 1) {
    schema = { type: ["array", "array"], items: schema };
  }
  return { type: "object", properties: { deal: schema } };
};

describe("a tool's types", () => {
  it("stay small however a schema nests, repeats its types or widens", async () => {
    const wide = {
      type: Array.from({ length: 3000 }, () => "object"),
      properties: Object.fromEntries(
        Array.from({ length: 3000 }, (_, index) => [`field${index}`, {}])
      ),
    };
    // Long names and values, each property a long enum and note.
    const long = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `${"field".repeat(100)}${index}`,
          {
            enum: Array.from(
              { length: 20 },
              (__, value) => `${"v".repeat(98)}${value}`
            ),
            description: "n".repeat(200),
          },
        ])
      ),
    };
    const tools = [toolOf(doubled(30)), toolOf(wide), toolOf(long)];

    const [found] = await searchTools(tools, ["deals"]);

    expect({
      declared: tools.map((tool) => declarationOf(tool).length < 20_000),
      inputs: found?.matches.map(({ input }) => input.length < 2000),
    }).toStrictEqual({
      declared: [true, true, true],
      inputs: [true, true, true],
    });
  });

  it("are written in full for a plain schema", () => {
    const tool = toolOf({
      type: "object",
      properties: {
        stage: { enum: ["open", "won"], description: "Where it stands." },
        owner: { type: ["string", "null"] },
        "close-date": { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" } },
            required: ["sku"],
          },
        },
      },
      required: ["stage"],
    });

    expect(declarationOf(tool).split("\n").slice(4, 13)).toStrictEqual([
      " */",
      'call(name: "CRM", action: "deals.find", input: {',
      "  /** Where it stands. */",
      '  stage: "open" | "won";',
      "  owner?: string | null;",
      '  "close-date"?: string;',
      "  lines?: {",
      "    sku: string;",
      "  }[];",
    ]);
  });

  it("write an object that takes no properties as one", () => {
    const tool = toolOf({ type: "object", additionalProperties: false });

    expect(declarationOf(tool).split("\n").at(-1)).toBe(
      'call(name: "CRM", action: "deals.find", input: {}): Promise<{ output: {} | null; pending: { id: string } | null }>;'
    );
  });

  it('find nothing for a query with no words, or only words as common as "the"', async () => {
    const found = await searchTools(
      [toolOf({ type: "object" })],
      ["?!", "to the"]
    );

    expect(found).toStrictEqual([
      { query: "?!", matches: [], related: [] },
      { query: "to the", matches: [], related: [] },
    ]);
  });

  it('match a query\'s words, never every word that starts with one as common as "a"', async () => {
    const tools = [
      {
        ...toolOf({}),
        action: "deals.archive",
        description: "Archives a deal.",
      },
      {
        ...toolOf({}),
        action: "invoices.refund",
        description: "Refunds a paid invoice.",
      },
    ];

    const [found] = await searchTools(tools, ["refund a paid invoice"]);

    expect(found?.matches.map(({ action }) => action)).toStrictEqual([
      "invoices.refund",
    ]);
  });
});
