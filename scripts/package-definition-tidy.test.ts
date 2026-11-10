import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { designCases, designFindings } from "../apps/core/test/design-cases.ts";
import {
  made,
  scratch,
  packaged,
  installIn,
  tidy,
  run,
  designFinding,
  rulesOf,
  graspRulesOf,
  unusedNames,
  blueprintFiles,
  appDefinition,
} from "./package-definition-fixtures.ts";

// Packaging a definition package into a standalone project
// (package-definition-lib.ts). The package is the SDK's Notes fixture, an
// App as the product lays it out, and a workflow generated as a version
// seals it; the project is checked as written, and every refusal leaves
// nothing behind.
//
// Here, the App's code held to what Grasp holds it to, by the project's
// own tools; the rest is package-definition.test.ts.

describe(
  "packaging a definition as a standalone project",
  { timeout: 60_000 },
  () => {
    afterEach(() => {
      for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
      vi.unstubAllGlobals();
    }, 60_000);

    it("holds the App's code to what Grasp holds it to: what Grasp's tidy wrote passes its typecheck, lint, format and build, and its lint finds what Grasp's finds", async () => {
      const { out } = scratch();
      // A blueprint's App as Grasp saves an agent's writes (`tidy`): a
      // component with imports out of order, which oxfmt sorts, and
      // classes Tailwind's sorter would reorder, which neither sorts; and
      // a GraphQL template, whose query both leave as written.
      const written = tidy({
        ...blueprintFiles("workflow-map"),
        "src/components/count.tsx": `import type { ReactNode } from "react";
import { Badge } from "@grasp-os/ui/components/badge";
import { api } from "@server/_generated/api";

export const Count = ({ children }: { children: ReactNode }) => (
  <p className="p-2 flex text-sm bg-primary">
    <Badge>{children}</Badge>
    {Object.keys(api).length}
  </p>
);
`,
        "src/components/query.ts": `const gql = String.raw;

export const query = gql\`
  query{ teams { name   } }
\`;
`,
      });
      await packaged(await appDefinition(written), out);
      const install = await installIn(out, ["--frozen-lockfile", "--offline"]);
      const fresh = {
        typecheck: run(out, "typecheck"),
        lint: run(out, "lint"),
        format: run(out, "format:check"),
        build: run(out, "build"),
      };
      // What each lint says of the App as it was saved, by file.
      const saved = {
        grasp: graspRulesOf(written),
        project: rulesOf(run(out, "lint", "--format=json").stdout),
      };

      // What Grasp's lint finds, the project's finds, no more: a debugger,
      // a forEach, a spread in an accumulator, a comparison that is always
      // false, a function declaration, and in a test what a preset's
      // override turns on (vitest's rules). A disable comment holds
      // whatever plugin it names a rule by (`@typescript-eslint/…`), and
      // an inline config comment, which oxlint doesn't read, turns nothing
      // on.
      const findings = `export const stop = (): void => {
  debugger;
};

export const byKey = (pairs: [string, number][]): Record<string, number> => {
  let all: Record<string, number> = {};
  for (const [key, value] of pairs) {
    all = { ...all, [key]: value };
  }
  return all;
};

export const each = (items: number[], seen: number[]): void => {
  items.forEach((item) => {
    seen.push(item);
  });
};

export const never = (n: number): boolean => n < 1 && n > 2;

export function zero(a: number): number {
  return a - a;
}
`;
      const found = {
        "src/components/findings.ts": findings,
        "src/components/comments.ts": `/* eslint no-ternary: "error" */
export const label = (on: boolean): string => (on ? "On" : "Off");

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export const anything = (value: any): unknown => value;
`,
        // An inline config comment over several lines keeps them: the
        // disable comment above it covers its first line, not the code.
        "src/components/spanning.ts": `export const stop = (): void => {
  // oxlint-disable-next-line no-debugger
  /* eslint
    no-console: "off"
  */ debugger;
};
`,
        "tests/count.test.ts": `import { expect, test } from "vitest";

test("counts", () => {
  expect([1].length).toEqual(1);
});
`,
        // Unused names: an import, a local and a parameter after the last
        // one used, but not one before it, nor a name a type reads.
        "src/components/unused.ts": unusedNames,
        // What only the App's other files say (a default or a name they
        // lack, a file importing itself), which Grasp's lint, a file at a
        // time, can't read: neither finds it (`leftOut`).
        "src/components/imports.ts": `import comments from "./comments";
import * as spanning from "./spanning";
import * as imports from "./imports";

export const imported = [comments, spanning.missing, imports];
`,
      };
      const write = (file: string, source: string): void => {
        mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
        writeFileSync(path.join(out, file), source);
      };
      for (const [file, source] of Object.entries(found)) {
        write(`app/${file}`, source);
      }
      const projectFound = run(out, "lint", "--format=json");
      for (const file of Object.keys(found)) {
        rmSync(path.join(out, "app", file));
      }
      // Unused names are the lint's, never the typecheck's, as Grasp's
      // builds pass them: in pages and components, and in server code.
      const unusedFiles = {
        "src/components/unused.ts": unusedNames,
        "server/unused.ts": `import { v } from "@grasp-os/sdk";

export const later = (): number => {
  const spare = 1;
  return 2;
};
`,
      };
      for (const [file, source] of Object.entries(unusedFiles)) {
        write(`app/${file}`, source);
      }
      const unusedChecked = run(out, "typecheck");
      for (const file of Object.keys(unusedFiles)) {
        rmSync(path.join(out, "app", file));
      }
      // And the pages' own rules, as Grasp's lint runs them
      // (apps/core/test/page-checks.test.ts, on the same files): a plain
      // form, an inline style, WebRTC, and its cases (design-cases.ts).
      const off = `import { Button } from "@grasp-os/ui/components/button";

export const Off = () => (
  <form>
    <Button style={{ margin: 0 }}>{typeof RTCPeerConnection}</Button>
  </form>
);
`;
      write("app/src/components/off.tsx", off);
      const design = run(out, "lint", "--format=json");
      rmSync(path.join(out, "app/src/components/off.tsx"));
      for (const [file, source] of Object.entries(designCases)) {
        write(`app/${file}`, source);
      }
      const casesFound = rulesOf(run(out, "lint", "--format=json").stdout);
      const cases = {
        design: casesFound
          .filter((finding) => designFinding(finding))
          .map((finding) => {
            const [file, , rule] = finding.split(" ");
            return `${file?.slice("app/".length)} ${rule}`;
          }),
        // And Grasp's lint of them, the pages' rules among Ultracite's.
        grasp: graspRulesOf(designCases),
        project: casesFound.filter((finding) => !designFinding(finding)),
      };
      for (const file of Object.keys(designCases)) {
        rmSync(path.join(out, "app", file));
      }
      // And the format: what isn't formatted fails its check.
      write("app/src/components/spaced.ts", "export const  spaced = 1\n");
      const unformatted = run(out, "format:check");

      const foundRules = [
        "app/src/components/findings.ts error func-style",
        "app/src/components/findings.ts error no-debugger",
        "app/src/components/findings.ts error oxc/const-comparisons",
        "app/src/components/findings.ts error oxc/no-accumulating-spread",
        "app/src/components/findings.ts error unicorn/no-array-for-each",
        "app/src/components/spanning.ts error no-debugger",
        "app/src/components/spanning.ts error no-inline-comments",
        "app/src/components/unused.ts error no-unused-vars",
        "app/src/components/unused.ts error no-unused-vars",
        "app/src/components/unused.ts error no-unused-vars",
        "app/src/components/unused.ts error no-unused-vars",
        "app/tests/count.test.ts error vitest/prefer-strict-equal",
        "app/tests/count.test.ts error vitest/prefer-to-be",
        "app/tests/count.test.ts error vitest/prefer-to-have-length",
        "app/tests/count.test.ts error vitest/require-top-level-describe",
      ];
      expect({
        install: install.status,
        fresh: Object.fromEntries(
          Object.entries(fresh).map(([script, { status, output }]) => [
            script,
            status === 0 ? "ok" : output,
          ])
        ),
        saved,
        found: {
          grasp: graspRulesOf(found),
          project: {
            status: projectFound.status,
            rules: rulesOf(projectFound.stdout),
          },
        },
        design: { status: design.status, rules: rulesOf(design.stdout) },
        cases,
        unformatted: unformatted.status,
        unused:
          unusedChecked.status === 0 ? "typechecks" : unusedChecked.output,
      }).toStrictEqual({
        install: 0,
        fresh: { typecheck: "ok", lint: "ok", format: "ok", build: "ok" },
        // Clean in both, as the blueprint passes Grasp's lint.
        saved: { grasp: [], project: [] },
        found: {
          grasp: foundRules,
          project: { status: 1, rules: foundRules },
        },
        design: {
          status: 1,
          rules: [
            "app/src/components/off.tsx error no-restricted-globals",
            "app/src/components/off.tsx error react/forbid-component-props",
            "app/src/components/off.tsx error react/forbid-elements",
          ],
        },
        cases: {
          design: designFindings,
          // Grasp's lint finds what the project's does, by the same rules.
          grasp: designFindings.map((finding) => {
            const [file, rule] = finding.split(" ");
            return `app/${file} error ${rule}`;
          }),
          project: [],
        },
        unformatted: 1,
        unused: "typechecks",
      });
    });
  }
);
