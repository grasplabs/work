import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runtimeBoundaryViolations } from "./check-runtime-boundary.ts";

// A small workspace (testdata/runtime-boundary) of the shape the check
// reads: the runtime with its connector entry, the SDK, one connector and
// connect. Each test copies it and changes one file. What the connector
// entry reaches, the connector reaches too, through the SDK.

const fixture = path.join(import.meta.dirname, "testdata/runtime-boundary");

const copies: string[] = [];

/** The violations in a copy of the fixture with `changes` written over it. */
const violationsWith = (
  changes: Record<string, string>
): { rule: string; chain: string[] }[] => {
  const copy = mkdtempSync(path.join(tmpdir(), "runtime-boundary-"));
  copies.push(copy);
  cpSync(fixture, copy, { recursive: true });
  for (const [file, source] of Object.entries(changes)) {
    writeFileSync(path.join(copy, file), source);
  }
  return runtimeBoundaryViolations(copy);
};

describe(runtimeBoundaryViolations, () => {
  afterEach(() => {
    for (const copy of copies.splice(0)) {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("passes a workspace that keeps its boundaries", () => {
    expect(runtimeBoundaryViolations(fixture)).toStrictEqual([]);
  });

  it("refuses App code the connector entry reaches through another module", () => {
    expect(
      violationsWith({
        "packages/runtime/src/values.js":
          'export { defineTable } from "./define-table.js";\nexport const v = {};\n',
      })
    ).toContainEqual({
      rule: "connector-entry",
      chain: [
        "packages/runtime/src/connector/connector.js",
        "packages/runtime/src/values.js",
        "packages/runtime/src/define-table.js",
      ],
    });
  });

  it("refuses React reached from the connector entry through a package import", () => {
    expect(
      violationsWith({
        "packages/runtime/src/parse.js":
          'import { createRoot } from "react-dom/client";\nexport const parse = createRoot;\n',
      })
    ).toContainEqual({
      rule: "connector-entry",
      chain: [
        "packages/runtime/src/connector/connector.js",
        "packages/runtime/src/connector/define.js",
        "packages/runtime/src/parse.js",
        "react-dom/client",
      ],
    });
  });

  it("refuses a dynamic import of App code from the connector entry", () => {
    expect(
      violationsWith({
        "packages/runtime/src/values.js":
          'export const v = {};\nexport const table = () => import("./define-table.js");\n',
      }).map(({ rule }) => rule)
    ).toContain("connector-entry");
  });

  it("refuses an import() it can't follow from the connector entry", () => {
    expect(
      violationsWith({
        "packages/runtime/src/values.js":
          "export const v = {};\nexport const load = (name) => import(name);\n",
      })
    ).toContainEqual({
      rule: "connector-entry",
      chain: [
        "packages/runtime/src/connector/connector.js",
        "packages/runtime/src/values.js",
        "import() of a computed value in packages/runtime/src/values.js",
      ],
    });
  });

  it("lets a type-only import of App code through", () => {
    expect(
      violationsWith({
        "packages/runtime/src/values.ts":
          'import type { Table } from "./define-table.ts";\nexport type { Host } from "./host.ts";\nexport const v: Table = {};\n',
        "packages/runtime/src/values.js": 'export * from "./values.ts";\n',
      })
    ).toStrictEqual([]);
  });

  it("refuses the App host reached from a connector's own file", () => {
    expect(
      violationsWith({
        "packages/connectors/sample/src/list.js":
          'import { host } from "@grasp-os/runtime/host";\nexport const list = { host };\n',
      })
    ).toStrictEqual([
      {
        rule: "connector-package",
        chain: [
          "packages/connectors/sample/src/index.js",
          "packages/connectors/sample/src/list.js",
          "packages/runtime/src/host.js",
        ],
      },
    ]);
  });

  it("refuses App code a connector reaches through the SDK", () => {
    expect(
      violationsWith({
        "packages/connectors/sample/src/list.js":
          'export { defineTable as list } from "@grasp-os/sdk/server";\n',
      })
    ).toStrictEqual([
      {
        rule: "connector-package",
        chain: [
          "packages/connectors/sample/src/index.js",
          "packages/connectors/sample/src/list.js",
          "packages/sdk/src/server.js",
          "packages/runtime/src/server.js",
        ],
      },
    ]);
  });

  it.each(["@grasp-os/runtime/server", "@grasp-os/sdk/connector"])(
    "refuses connect's import of %s",
    (specifier) => {
      expect(
        violationsWith({
          "apps/connect/src/index.js": `export { v } from "${specifier}";\n`,
        })
      ).toStrictEqual([
        {
          rule: "connect-imports",
          chain: ["apps/connect/src/index.js", specifier],
        },
      ]);
    }
  );
});
