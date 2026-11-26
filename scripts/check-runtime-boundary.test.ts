import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runtimeBoundaryViolations } from "./check-runtime-boundary.ts";

// A small workspace (testdata/runtime-boundary) of the shape the check
// reads: the runtime in its folders (app, workflow, connector, common),
// the SDK and one connector. Each test copies it and changes one file.
// What the connector entry reaches, the connector reaches too, through the
// SDK.

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
        "packages/runtime/src/common/values.js":
          'export { defineTable } from "../app/define-table.js";\nexport const v = {};\n',
      })
    ).toContainEqual({
      rule: "connector-entry",
      chain: [
        "packages/runtime/src/connector/connector.js",
        "packages/runtime/src/common/values.js",
        "packages/runtime/src/app/define-table.js",
      ],
    });
  });

  it("refuses workflow code the connector entry reaches", () => {
    expect(
      violationsWith({
        "packages/runtime/src/connector/define.js":
          'import { step } from "../workflow/workflow.js";\nexport const tool = () => step;\n',
      })
    ).toContainEqual({
      rule: "connector-entry",
      chain: [
        "packages/runtime/src/connector/connector.js",
        "packages/runtime/src/connector/define.js",
        "packages/runtime/src/workflow/workflow.js",
      ],
    });
  });

  it("refuses React reached from the connector entry through a package import", () => {
    expect(
      violationsWith({
        "packages/runtime/src/common/parse.js":
          'import { createRoot } from "react-dom/client";\nexport const parse = createRoot;\n',
      })
    ).toContainEqual({
      rule: "connector-entry",
      chain: [
        "packages/runtime/src/connector/connector.js",
        "packages/runtime/src/connector/define.js",
        "packages/runtime/src/common/parse.js",
        "react-dom/client",
      ],
    });
  });

  it("refuses a dynamic import of App code from the connector entry", () => {
    expect(
      violationsWith({
        "packages/runtime/src/common/values.js":
          'export const v = {};\nexport const table = () => import("../app/define-table.js");\n',
      }).map(({ rule }) => rule)
    ).toContain("connector-entry");
  });

  it("refuses an import() it can't follow from the connector entry", () => {
    expect(
      violationsWith({
        "packages/runtime/src/common/values.js":
          "export const v = {};\nexport const load = (name) => import(name);\n",
      })
    ).toContainEqual({
      rule: "connector-entry",
      chain: [
        "packages/runtime/src/connector/connector.js",
        "packages/runtime/src/common/values.js",
        "import() of a computed value in packages/runtime/src/common/values.js",
      ],
    });
  });

  it("lets a type-only import of App code through", () => {
    expect(
      violationsWith({
        "packages/runtime/src/common/values.ts":
          'import type { Table } from "../app/define-table.ts";\nexport type { Host } from "../app/host.ts";\nexport const v: Table = {};\n',
        "packages/runtime/src/common/values.js":
          'export * from "./values.ts";\n',
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
          "packages/runtime/src/app/host.js",
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
          "packages/runtime/src/app/server.js",
        ],
      },
    ]);
  });

  it.each([
    ["common", "common/table.js", "../app/host.js", "app/host.js"],
    [
      "workflow",
      "workflow/tool.js",
      "../connector/define.js",
      "connector/define.js",
    ],
    [
      "connector",
      "connector/step.js",
      "../workflow/workflow.js",
      "workflow/workflow.js",
    ],
    [
      "app",
      "app/step.js",
      "@grasp-os/runtime/workflow",
      "workflow/workflow.js",
    ],
  ])(
    "refuses %s code's value import of another kind's",
    (_folder, file, specifier, reached) => {
      expect(
        violationsWith({
          [`packages/runtime/src/${file}`]: `export { v } from "${specifier}";\n`,
        })
      ).toStrictEqual([
        {
          rule: "runtime-folders",
          chain: [
            `packages/runtime/src/${file}`,
            `packages/runtime/src/${reached}`,
          ],
        },
      ]);
    }
  );
});
