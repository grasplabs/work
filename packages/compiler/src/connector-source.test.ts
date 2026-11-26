import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vite-plus/test";

import { mcpConnectorSource } from "./connector-source.ts";
import type { McpConnectorFields } from "./connector-source.ts";

// The source of a connector made from a URL, as pure logic: fields in,
// one `defineConnector` out. What can go wrong, first: a name, a title, a
// URL or a header written to end its string and go on as code, or to read
// as something else than it is (a line break, U+2028, a template, an HTML
// tag around a script).

/**
 * The value of an expression of plain object literals and strings, and
 * nothing else: anything else in the source fails the test.
 */
const plain = (node: unknown): unknown => {
  if (typeof node !== "object" || node === null || !("type" in node)) {
    throw new Error("Not a node");
  }
  if (
    node.type === "Literal" &&
    "value" in node &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  if (
    node.type === "ObjectExpression" &&
    "properties" in node &&
    Array.isArray(node.properties)
  ) {
    return Object.fromEntries(
      node.properties.map((property: unknown) => {
        if (
          typeof property !== "object" ||
          property === null ||
          !("key" in property) ||
          !("value" in property) ||
          !("computed" in property) ||
          property.computed !== false ||
          typeof property.key !== "object" ||
          property.key === null ||
          !("name" in property.key)
        ) {
          throw new Error("Not a plain property");
        }
        return [property.key.name, plain(property.value)];
      })
    );
  }
  throw new Error(`Not a plain value: ${String(node.type)}`);
};

/**
 * What `source` is, as written: its import and the one connector it
 * exports, by the plain fields it is defined with.
 */
const definedIn = (source: string) => {
  const { program, errors } = parseSync("connector.ts", source);
  const [imported, exported, ...rest] = program.body;
  if (
    imported?.type !== "ImportDeclaration" ||
    exported?.type !== "ExportDefaultDeclaration" ||
    exported.declaration.type !== "CallExpression" ||
    exported.declaration.callee.type !== "Identifier"
  ) {
    throw new Error("Not one import and one exported call");
  }
  return {
    errors,
    rest: rest.length,
    from: imported.source.value,
    imports: imported.specifiers.map(({ local }) => local.name),
    calls: exported.declaration.callee.name,
    fields: exported.declaration.arguments.map(plain),
  };
};

const hostile = [
  'Linear" }); globalThis.taken = true; ({ "',
  "Linear\n}); globalThis.taken = true; //",
  "Linear\u2028globalThis.taken = true\u2029",
  // A template's placeholder, which a template literal would run.
  ["Linear $", "{globalThis.taken = true} `tick` \\"].join(""),
  "</script><script>globalThis.taken = true</script>",
];

/** A connector made from the URL of a server inside the company's network. */
const orders = (): McpConnectorFields => ({
  name: `mcp_${"a".repeat(32)}`,
  title: "Orders",
  mcp: {
    url: "http://10.0.0.8:8080/mcp",
    registration: { header: "X-Api-Key" },
  },
});

describe("a connector made from a URL", () => {
  it("is defined by its fields alone, each a string whatever it holds, and its URL as the parser writes it", () => {
    const made = hostile.map((title, at) => {
      const fields: McpConnectorFields = {
        name: `mcp_${String(at).repeat(32)}`,
        title,
        mcp: {
          url: `https://mcp.example.test/${title}`,
          registration: at % 2 === 0 ? "dcr" : { header: title },
        },
      };
      return { fields, defined: definedIn(mcpConnectorSource(fields)) };
    });
    expect(made.map(({ defined }) => defined)).toStrictEqual(
      made.map(({ fields }) => ({
        errors: [],
        rest: 0,
        from: "@grasp-os/sdk/connector",
        imports: ["defineConnector"],
        calls: "defineConnector",
        fields: [
          {
            ...fields,
            mcp: { ...fields.mcp, url: new URL(fields.mcp.url).href },
          },
        ],
      }))
    );
  });

  it("says its server is inside the company's network in its own words alone, whatever value it was given", () => {
    // A value no checked field holds, as one that slipped past them would.
    const definedWith = (network: unknown) => {
      const fields = orders();
      Reflect.set(fields.mcp, "network", network);
      return definedIn(mcpConnectorSource(fields)).fields;
    };
    expect({
      company: definedWith("company"),
      none: definedIn(mcpConnectorSource(orders())).fields,
      hostile: hostile.map((value) => definedWith(`company" ${value}`)),
      object: definedWith({ toString: () => "company" }),
    }).toStrictEqual({
      company: [
        {
          name: `mcp_${"a".repeat(32)}`,
          title: "Orders",
          mcp: {
            url: "http://10.0.0.8:8080/mcp",
            registration: { header: "X-Api-Key" },
            network: "company",
          },
        },
      ],
      none: [
        {
          name: `mcp_${"a".repeat(32)}`,
          title: "Orders",
          mcp: {
            url: "http://10.0.0.8:8080/mcp",
            registration: { header: "X-Api-Key" },
          },
        },
      ],
      hostile: hostile.map(() => [
        {
          name: `mcp_${"a".repeat(32)}`,
          title: "Orders",
          mcp: {
            url: "http://10.0.0.8:8080/mcp",
            registration: { header: "X-Api-Key" },
          },
        },
      ]),
      object: [
        {
          name: `mcp_${"a".repeat(32)}`,
          title: "Orders",
          mcp: {
            url: "http://10.0.0.8:8080/mcp",
            registration: { header: "X-Api-Key" },
          },
        },
      ],
    });
  });
});
