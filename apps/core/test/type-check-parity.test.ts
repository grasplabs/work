import { typeCheckerName } from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import { generateModules } from "@grasp-os/runtime/host";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { loadBuiltinRelease } from "../src/builtins.ts";
import { inspectDraft, withDraftReferences } from "../src/draft-references.ts";
import { buildPages, checkAppCode } from "../src/pages.ts";

// The type check is a gate: what it passes is sealed and run. These tests
// hold the checker to what the platform's previous one (TypeScript 6's
// compiler API) said of the same files, recorded as it said it: the
// built-in blueprints, which pass every target, and a corpus of mistakes
// added to one of them, each in a file of its own so its lines don't move
// as the blueprint changes. A mistake that passes is the failure to
// prevent; one refused that passed before blocks a builder.

/** A blueprint's files with the modules the host generates for them, as a seal and a draft's check have them. */
const blueprintApp = async (
  id: string
): Promise<{ app: AppId; files: Record<string, string> }> => {
  const release = await loadBuiltinRelease();
  const blueprint = release.blueprints.find((found) => found.id === id);
  if (blueprint === undefined) {
    throw new Error(`No built-in blueprint ${id}`);
  }
  const app = appIdSchema.parse(crypto.randomUUID());
  const { files, standIn } = await withDraftReferences(env, app, 1, {
    ...blueprint.files,
  });
  if (standIn) {
    throw new Error(`The server code of ${id} doesn't register`);
  }
  return { app, files };
};

/** `files`' server code with the modules a seal generates for it. */
const sealedServer = async (
  app: AppId,
  files: Record<string, string>
): Promise<Record<string, string>> => {
  const inspected = await inspectDraft(env, app, files);
  if (!("manifest" in inspected)) {
    throw inspected.failed;
  }
  return {
    ...files,
    ...(await generateModules(
      inspected.manifest,
      { resourceId: app, resourceVersion: 1 },
      []
    )),
  };
};

/** A build's type diagnostics (`TS<code>`), as `file:line:column rule severity`, sorted. */
const typeDiagnostics = (
  built:
    | { ok: true; diagnostics?: Diagnostic[] }
    | { ok: false; diagnostics: Diagnostic[] }
): string[] =>
  (built.diagnostics ?? [])
    .filter(({ rule }) => rule.startsWith("TS"))
    .map(
      ({ file, line, column, rule, severity }) =>
        `${file ?? "(App)"}:${line ?? 0}:${column ?? 0} ${rule} ${severity}`
    )
    .toSorted();

/** The release's built-ins, the example Apps among them: not the tests' own. */
const { blueprints: builtins } = await loadBuiltinRelease();
const blueprints = builtins.map(({ id }) => id).filter((id) => id !== "hello");

/** Mistakes in a page's files, each a component of its own. */
const pageMistakes: Record<string, string> = {
  "src/components/m-assign.tsx": 'export const wrong: number = "x";\n',
  "src/components/m-prop.tsx":
    'import { Button } from "@grasp-os/ui/components/button";\n\nexport const Wrong = () => <Button nope={1}>x</Button>;\n',
  "src/components/m-hook.tsx":
    'import { useQuery } from "@grasp-os/sdk/react";\n\nexport const wrong: number = useQuery;\n',
  "src/components/m-export.tsx":
    'import { notThere } from "@grasp-os/sdk/react";\n\nexport const wrong = notThere;\n',
  "src/components/m-implicit.tsx": "export const wrong = (x) => x;\n",
  "src/components/m-undefined.tsx":
    "export const wrong = (a?: { b: number }) => a.b;\n",
  "src/components/m-excess.tsx":
    "export const wrong: { a: number } = { a: 1, b: 2 };\n",
  "src/components/m-expected.tsx":
    "// @ts-expect-error\nexport const fine = 1;\n",
  "src/components/m-state.tsx":
    'import { useState } from "react";\n\nexport const Wrong = () => {\n  const [value, set] = useState(0);\n  set("x");\n  return value;\n};\n',
  "src/components/m-error.tsx":
    'import { GraspError } from "@grasp-os/sdk/react";\n\nexport const wrong: string = new GraspError("x").nope;\n',
  "src/components/m-dom.tsx":
    'export const wrong: HTMLInputElement = document.createElement("div");\n',
  "src/components/m-api.tsx":
    'import { useQuery } from "@grasp-os/sdk/react";\n\nimport { api } from "@server/_generated/api";\n\nexport const Wrong = () => useQuery(api, 42 as unknown as { nope: true });\n',
  "src/components/m-callback.tsx":
    'import { useCallback } from "react";\n\nexport const useWrong = () => useCallback((event) => event, []);\n',
  "src/components/m-null.tsx":
    'export const wrong = (): string => document.querySelector("a").href;\n',
  "src/components/m-utf16.tsx":
    'const face = "😀😀"; export const wrong: number = face;\n',
  "src/components/m-child.tsx":
    'import { Button } from "@grasp-os/ui/components/button";\n\nexport const Wrong = () => <Button>{{ a: 1 }}</Button>;\n',
  "src/components/m-declared.d.ts":
    "export interface Wrong {\n  field: Missing;\n}\n",
  // Modules the kit holds but doesn't give a page, by name and by path.
  "src/components/m-hidden.tsx":
    'import type { ZodType } from "zod";\n\nexport type Wrong = ZodType;\n',
  "src/components/m-hidden-path.tsx":
    'import type { useQuery } from "../node_modules/@grasp-os/sdk/src/react";\n\nexport type Wrong = typeof useQuery;\n',
};

/** Mistakes in an App's server code, each a server module of its own. */
const serverMistakes: Record<string, string> = {
  "server/m-assign.ts": 'export const wrong: number = "x";\n',
  "server/m-returns.ts":
    'import { v } from "@grasp-os/sdk";\nimport { query } from "@server/_generated/server";\n\nexport const wrong = query({ args: {}, returns: v.string(), handler: () => 1 });\n',
  "server/m-dom.ts": "export const wrong = (): string => document.title;\n",
  "server/m-implicit.ts": "export const wrong = (x) => x;\n",
  "server/m-undefined.ts": "export const wrong = (a?: { b: number }) => a.b;\n",
  // Modules the kit holds but doesn't give server code: a page's, a
  // library's, and the kit's files by path, relative, absolute and bare.
  "server/m-page-module.ts":
    'import type { useQuery } from "@grasp-os/sdk/react";\n\nexport type Wrong = typeof useQuery;\n',
  "server/m-react.ts":
    'import type { ReactNode } from "react";\n\nexport type Wrong = ReactNode;\n',
  "server/m-library.ts":
    'import type { ZodType } from "zod";\n\nexport type Wrong = ZodType;\n',
  "server/m-kit-path.ts":
    'import type { useQuery } from "../node_modules/@grasp-os/sdk/src/react.d.ts";\n\nexport type Wrong = typeof useQuery;\n',
  "server/m-kit-absolute.ts":
    'import type { useQuery } from "/node_modules/@grasp-os/sdk/src/react.d.ts";\n\nexport type Wrong = typeof useQuery;\n',
  "server/m-hidden-relative.ts":
    'import type { useQuery } from "../.kit/node_modules/@grasp-os/sdk/src/react.d.ts";\n\nexport type Wrong = typeof useQuery;\n',
  "server/m-hidden-absolute.ts":
    'import type { useQuery } from "/.kit/node_modules/@grasp-os/sdk/src/react.d.ts";\n\nexport type Wrong = typeof useQuery;\n',
  "server/m-hidden-bare.ts":
    'import type { useQuery } from ".kit/node_modules/@grasp-os/sdk/src/react.d.ts";\n\nexport type Wrong = typeof useQuery;\n',
};

/**
 * What TypeScript 6's compiler API said of each corpus, the platform's
 * check before tsrs (recorded 2026-11-04 on #1939's type chunks): every
 * error, by file, line, column and code. Messages aren't held: TypeScript
 * 7 prints a type's union members and properties in another order, and
 * its DOM lib is newer ("and 55 more" for "and 54 more").
 */
const said: Record<string, string[]> = {
  pages: [
    "src/components/m-api.tsx:5:37 TS2345 error",
    "src/components/m-assign.tsx:1:14 TS2322 error",
    "src/components/m-callback.tsx:3:44 TS7006 error",
    "src/components/m-child.tsx:3:39 TS2353 error",
    "src/components/m-declared.d.ts:2:10 TS2304 error",
    "src/components/m-dom.tsx:1:14 TS2740 error",
    "src/components/m-error.tsx:3:45 TS2345 error",
    "src/components/m-error.tsx:3:50 TS2339 error",
    "src/components/m-excess.tsx:1:45 TS2353 error",
    "src/components/m-expected.tsx:1:1 TS2578 error",
    "src/components/m-export.tsx:1:10 TS2305 error",
    "src/components/m-hook.tsx:3:14 TS2322 error",
    "src/components/m-implicit.tsx:1:23 TS7006 error",
    "src/components/m-null.tsx:1:36 TS2531 error",
    "src/components/m-prop.tsx:3:36 TS2322 error",
    "src/components/m-undefined.tsx:1:45 TS18048 error",
    "src/components/m-utf16.tsx:1:35 TS2322 error",
  ],
  server: [
    "server/m-assign.ts:1:14 TS2322 error",
    "server/m-dom.ts:1:36 TS2584 error",
    "server/m-hidden-absolute.ts:1:31 TS2307 error",
    "server/m-hidden-bare.ts:1:31 TS2307 error",
    "server/m-hidden-relative.ts:1:31 TS2307 error",
    "server/m-implicit.ts:1:23 TS7006 error",
    "server/m-kit-absolute.ts:1:31 TS2307 error",
    "server/m-kit-path.ts:1:31 TS2307 error",
    "server/m-library.ts:1:30 TS2307 error",
    "server/m-page-module.ts:1:31 TS2307 error",
    "server/m-react.ts:1:32 TS2307 error",
    "server/m-returns.ts:4:76 TS2322 error",
    "server/m-undefined.ts:1:45 TS18048 error",
  ],
};

/**
 * Where a build now refuses an import before its type check counts, which
 * TypeScript 6 refused by resolution alone: a type's path into the kit,
 * relative or absolute (imports.ts `typeFileError`). The type check hides
 * the kit from an App file's lookup by name, not from a path to it.
 */
const refusedFirst: Record<string, string[]> = {
  server: [
    "server/m-hidden-absolute.ts:1",
    "server/m-hidden-relative.ts:1",
    "server/m-kit-absolute.ts:1",
    "server/m-kit-path.ts:1",
  ],
};

/** The lines a build refuses an import on, as `file:line`. */
const importRefusals = (built: {
  ok: boolean;
  diagnostics?: Diagnostic[];
}): string[] =>
  (built.diagnostics ?? [])
    .filter(({ rule, severity }) => rule === "imports" && severity === "error")
    .map(({ file, line }) => `${file ?? "(App)"}:${line ?? 0}`)
    .toSorted();

/**
 * What `built` says of `corpus` (`found`), and what it must say to hold to
 * what TypeScript 6 said (`said`): every error it gave, at the same place
 * with the same code, but where the build refuses the line's import
 * first (`refusedFirst`), and none it didn't give.
 */
const parity = (
  corpus: string,
  built:
    | { ok: true; diagnostics?: Diagnostic[] }
    | { ok: false; diagnostics: Diagnostic[] }
) => {
  const refused = refusedFirst[corpus] ?? [];
  return {
    found: {
      ok: built.ok,
      checked: typeDiagnostics(built),
      refused: importRefusals(built).filter((line) => refused.includes(line)),
    },
    said: {
      ok: false,
      checked: (said[corpus] ?? []).filter(
        (diagnostic) =>
          !refused.some((line) => diagnostic.startsWith(`${line}:`))
      ),
      refused,
    },
  };
};

describe(
  "the type check, against what TypeScript 6 said",
  { timeout: 300_000 },
  () => {
    it.each(blueprints)(
      "passes the %s blueprint's pages and server code, as it did",
      async (id) => {
        const { app, files } = await blueprintApp(id);
        const pages = await buildPages(env, files, app);
        const server = await checkAppCode(
          env,
          await sealedServer(app, files),
          app
        );
        expect({ pages, server: server.ok }).toMatchObject({
          pages: { ok: true, diagnostics: [] },
          server: true,
        });
      }
    );

    it("gives a page's mistakes, and refuses its paths into the kit before the check", async () => {
      const { app, files } = await blueprintApp("intake");
      const built = await buildPages(env, { ...files, ...pageMistakes }, app);
      const { found, said: was } = parity("pages", built);
      expect(found).toStrictEqual(was);
      expect(
        importRefusals(built).filter((line) => line.includes("m-hidden"))
      ).toStrictEqual([
        "src/components/m-hidden-path.tsx:1",
        "src/components/m-hidden.tsx:1",
      ]);
    });

    it("refuses every triple-slash directive in a page's files but a reference path to one of the App's, however it is written", async () => {
      // TypeScript reads a directive's tag and attributes in any case and
      // order, so a gate that matched one spelling let the others reach
      // the kit the check hides, or a lib the page doesn't have.
      const kitFile = "../.kit/node_modules/@grasp-os/sdk/src/server.d.ts";
      const directives: Record<string, string> = {
        "src/components/d-upper.tsx": `/// <REFERENCE path="${kitFile}" />\nexport const a = 1;\n`,
        "src/components/d-upper-path.tsx": `/// <reference PATH="${kitFile}" />\nexport const b = 1;\n`,
        "src/components/d-reordered.tsx": `/// <reference preserve="true" path="${kitFile}" />\nexport const c = 1;\n`,
        "src/components/d-lib.tsx":
          '/// <reference lib="webworker" />\nexport const d = 1;\n',
        "src/components/d-types.tsx":
          '/// <reference types="node" />\nexport const e = 1;\n',
        "src/components/d-amd.tsx":
          '/// <amd-dependency path="x" />\nexport const f = 1;\n',
        "d-declared.d.ts": `/// <Reference Path="${kitFile}" />\nexport type G = 1;\n`,
        // The one directive a page's files may hold.
        "src/components/d-own.tsx":
          '/// <reference path="./d-own-types.d.ts" />\nexport const h: Own = 1;\n',
        "src/components/d-own-types.d.ts": "type Own = 1;\n",
      };
      const { app, files } = await blueprintApp("intake");
      const built = await buildPages(env, { ...files, ...directives }, app);
      expect(
        importRefusals(built).filter((line) => /d-/u.test(line))
      ).toStrictEqual([
        "d-declared.d.ts:1",
        "src/components/d-amd.tsx:1",
        "src/components/d-lib.tsx:1",
        "src/components/d-reordered.tsx:1",
        "src/components/d-types.tsx:1",
        "src/components/d-upper-path.tsx:1",
        "src/components/d-upper.tsx:1",
      ]);
    });

    it("gives server code's mistakes, and refuses its paths into the kit before the check", async () => {
      const { app, files } = await blueprintApp("intake");
      const { found, said: was } = parity(
        "server",
        await checkAppCode(
          env,
          { ...(await sealedServer(app, files)), ...serverMistakes },
          app
        )
      );
      expect(found).toStrictEqual(was);
    });
  }
);

describe("the type checker's isolate", { timeout: 120_000 }, () => {
  it("is one per release, its name holding no App's ID and none of its code, whichever App checks", async () => {
    // Every name a check starts an isolate under: Cloudflare bills a
    // Dynamic Worker per name a day, and a name that held an App's ID or
    // code would be one per App, or per change.
    const names: string[] = [];
    const loader: WorkerLoader = {
      get: (name, code) => {
        names.push(name ?? "(unnamed)");
        return env.LOADER.get(name, code);
      },
      load: (code) => {
        names.push("(unnamed)");
        return env.LOADER.load(code);
      },
    };
    const spied = { ...env, LOADER: loader, RUNTIME_PROFILE: "cloudflare" };
    const marks = [crypto.randomUUID(), crypto.randomUUID()];
    const apps: AppId[] = [];
    for (const mark of marks) {
      // oxlint-disable-next-line no-await-in-loop -- one App after another
      const { app, files } = await blueprintApp("intake");
      apps.push(app);
      // oxlint-disable-next-line no-await-in-loop -- one App after another
      const built = await buildPages(
        spied,
        {
          ...files,
          "src/components/m-mark.tsx": `// ${mark}\nexport const wrong: number = "${mark}";\n`,
        },
        app
      );
      expect(built.ok).toBeFalsy();
    }
    const checks = names.filter((name) => name.startsWith("check:"));
    expect({
      // Each under the release's name, less what the quiet Loader adds.
      checks: [...new Set(checks.map((name) => name.split("\u0000")[0]))],
      checked: checks.length,
      unnamed: names.includes("(unnamed)"),
      // The compiler's isolate is the App's own, by design (`appCompilerName`);
      // the checker's is every App's, and holds neither.
      leaked: checks.filter((name) =>
        [...marks, ...apps].some((secret) => name.includes(secret))
      ),
    }).toStrictEqual({
      checks: [typeCheckerName],
      checked: 2,
      unnamed: false,
      leaked: [],
    });
  });
});
