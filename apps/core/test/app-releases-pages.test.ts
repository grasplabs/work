import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { buildPages } from "../src/pages.ts";
import { withFiles } from "./app-definitions.ts";
import {
  errorsOf,
  notesFiles,
  pageShowingProps,
  saidSchema,
} from "./app-releases-harness.ts";

// Sealing an App's release (spec 8, 16) through the real compiler, Loader
// isolates, R2 and D1: what a seal pins, that what it pins can't change
// under it, and the ways App code and storage could try to make it seal
// or run something else. Running a sealed release is
// app-functions.test.ts. Gone with App workflows: the types an App's own
// workflow may name, as its build reads them.

describe("pages", { timeout: 120_000 }, () => {
  it("import a component kept in a folder whose name has a dot", async () => {
    const built = await buildPages(
      env,
      withFiles(notesFiles(), {
        "src/components/v1.0/title.tsx":
          "export function Title() {\n  return <h1>Notes</h1>;\n}\n",
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Title } from "../components/v1.0/title.tsx";

function Notes() {
  return <Title />;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
      }).files,
      "app-test"
    );
    expect(errorsOf(built)).toStrictEqual([]);
  });

  it("can't keep anything but the front end's TypeScript under src/: each is refused by name", async () => {
    const strays = [
      "src/components/styles.css",
      "src/components/data.json",
      // Never saved (a save refuses each), never a component.
      "src/components/.hidden/title.tsx",
      "src/components/../app.tsx",
      "src/components//title.tsx",
    ];
    const built = await buildPages(
      env,
      withFiles(notesFiles(), {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
        ...Object.fromEntries(strays.map((path) => [path, "export {};\n"])),
      }).files,
      "app-test"
    );
    expect(
      new Set(
        saidSchema
          .parse(built)
          .diagnostics.filter(({ message }) =>
            message.includes("which holds only the App's front end")
          )
          .map(({ file }) => file)
      )
    ).toStrictEqual(new Set(strays));
  });

  it("name for their types the App's own declarations, a folder's index among them", async () => {
    const declarations = {
      "src/components/types/index.d.ts":
        "export interface Props {\n  title: string;\n}\n",
      "src/components/named.d.ts":
        "export interface Props {\n  title: string;\n}\n",
    };
    const [folder, extension, outside] = await Promise.all(
      [
        'import type { Props } from "../components/types";',
        'import type { Props } from "../components/named.js";',
        // A folder whose index would be the kit's, never an App file.
        'import type { Props } from "../node_modules/@grasp-os/runtime/src";',
      ].map(
        async (line) =>
          await buildPages(
            env,
            withFiles(notesFiles(), {
              ...declarations,
              "src/routes/index.tsx": pageShowingProps(line),
            }).files,
            "app-test"
          )
      )
    );
    expect({
      folder: errorsOf(folder ?? {}),
      extension: errorsOf(extension ?? {}),
      outside: errorsOf(outside ?? {}),
    }).toStrictEqual({
      folder: [],
      extension: [],
      outside: [
        '"../node_modules/@grasp-os/runtime/src" is not a file of this App\'s pages.',
      ],
    });
  });

  it("refuse a page's declaration naming a module by import() in a namespace", async () => {
    // The declaration's import check refuses it before any type check;
    // the type check's resolution, which holds it as well, is tested on its
    // own (packages/compiler, type-check.test.ts).
    const files = withFiles(notesFiles(), {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
      "probe.d.ts":
        'declare namespace Probe {\n  type Server = typeof import("@grasp-os/runtime/server");\n}\n',
    });
    const built = await buildPages(env, files.files, "app-test");
    expect(
      (built.ok ? [] : built.diagnostics)
        .filter(({ file }) => file === "probe.d.ts")
        .map(({ rule }) => rule)
    ).toStrictEqual(["imports"]);
  });

  it.each([
    [
      "imports inside it, in a declaration file",
      "leak.d.ts",
      'declare module "x-probe" {\n  import type { runPage } from "@grasp-os/runtime/page-runtime";\n  import type { serverModule } from "@grasp-os/runtime/server";\n  global {\n    type Leak = [typeof runPage, typeof serverModule];\n  }\n}\n',
    ],
    [
      "imports inside it, in a component's declarations",
      "src/components/leak.d.ts",
      'declare module "x-probe" {\n  import type { runPage } from "@grasp-os/runtime/page-runtime";\n  global {\n    type Leak = [typeof runPage];\n  }\n}\n',
    ],
    [
      "one that shadows a kit module",
      "shadow.d.ts",
      'declare module "@grasp-os/runtime/react" {\n  export const useQuery: (reference: unknown) => unknown;\n}\n',
    ],
  ])("never declare a module by name: %s", async (_case, file, source) => {
    const built = await buildPages(
      env,
      withFiles(notesFiles(), {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
export type Reached = unknown;
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
        [file]: source,
      }).files,
      "app-test"
    );
    expect({
      ok: built.ok,
      refused: saidSchema
        .parse(built)
        .diagnostics.filter(
          (diagnostic) =>
            diagnostic.file === file &&
            diagnostic.message.startsWith("declare module")
        ).length,
    }).toStrictEqual({ ok: false, refused: 1 });
  });

  it.each([
    [
      "a declaration file",
      "globals.d.ts",
      "export {};\ndeclare global {\n  var leak: number;\n}\n",
    ],
    [
      "a page",
      "src/routes/globals.tsx",
      "export {};\ndeclare global {\n  interface Window {\n    leak: number;\n  }\n}\n",
    ],
  ])("never declare globals, in %s", async (_case, file, source) => {
    const built = await buildPages(
      env,
      withFiles(notesFiles(), {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
        [file]: source,
      }).files,
      "app-test"
    );
    expect({
      ok: built.ok,
      refused: saidSchema
        .parse(built)
        .diagnostics.filter(
          (diagnostic) =>
            diagnostic.file === file &&
            diagnostic.message.startsWith("declare global")
        ).length,
    }).toStrictEqual({ ok: false, refused: 1 });
  });

  it("read a declaration file as declarations: a const needs no value", async () => {
    const built = await buildPages(
      env,
      withFiles(notesFiles(), {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import type { Limit } from "../../limits";
export type Shown = Limit;
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
        "limits.d.ts":
          "export const limit: number;\nexport type Limit = typeof limit;\n",
      }).files,
      "app-test"
    );
    expect(built.ok ? [] : errorsOf(built)).toStrictEqual([]);
  });

  it.each([
    ["a page", "src/routes/index.tsx", "../"],
    ["a declaration file", "notes.d.ts", "./"],
  ])(
    "never name the kit's own files for their types in %s, by any path",
    async (_case, file, up) => {
      const lines = [
        `/// <reference path="${up}node_modules/@grasp-os/runtime/src/client.ts" />`,
        '/// <reference types="node" />',
        `export type R = typeof import("${up}node_modules/@grasp-os/runtime/src/page-runtime.ts");`,
        'import type * as C from "/node_modules/@grasp-os/runtime/src/client-core.ts";',
        `import type { serverModule } from "${up}node_modules/@grasp-os/runtime/src/server.ts";`,
        `import type { Doc } from "${up}node_modules/@grasp-os/runtime/src/query-types.ts";`,
        "export type Reached = typeof C | typeof serverModule | Doc<never>;",
      ].join("\n");
      const page =
        'import { createFileRoute } from "@tanstack/react-router";\n\nfunction Notes() {\n  return null;\n}\n\nexport const Route = createFileRoute("/")({ component: Notes });\n';
      const built = await buildPages(
        env,
        withFiles(notesFiles(), {
          "src/routes/index.tsx":
            file === "src/routes/index.tsx" ? `${lines}\n${page}` : page,
          ...(file === "notes.d.ts" ? { [file]: lines } : {}),
        }).files,
        "app-test"
      );
      const refused = saidSchema
        .parse(built)
        .diagnostics.filter(
          (diagnostic) =>
            diagnostic.file === file && diagnostic.rule === "imports"
        );
      expect({
        ok: built.ok,
        // The four imports, as the import check refuses them, and the two
        // directives, as the type check refuses them, all at once.
        imports: refused.length,
      }).toStrictEqual({ ok: false, imports: 6 });
      const directives = await buildPages(
        env,
        withFiles(notesFiles(), {
          "src/routes/index.tsx":
            file === "src/routes/index.tsx"
              ? `${lines.split("\n").slice(0, 2).join("\n")}\n${page}`
              : page,
          ...(file === "notes.d.ts"
            ? { [file]: lines.split("\n").slice(0, 2).join("\n") }
            : {}),
        }).files,
        "app-test"
      );
      expect({
        ok: directives.ok,
        directives: saidSchema
          .parse(directives)
          .diagnostics.filter(
            (diagnostic) =>
              diagnostic.file === file && diagnostic.rule === "imports"
          ).length,
      }).toStrictEqual({ ok: false, directives: 2 });
    }
  );

  it.each([
    ["a page", "src/routes/index.tsx"],
    ["a declaration file", "notes.d.ts"],
  ])(
    "never name the App's server code for its types in %s",
    async (_case, file) => {
      const typeLines = [
        'import type { query } from "@server/_generated/server";',
        'import type { internal } from "@server/_generated/internal";',
        'export type { create } from "../../server/notes.ts";',
        'export type Schema = typeof import("../../server/schema.ts");',
      ];
      const page =
        'import { createFileRoute } from "@tanstack/react-router";\n\nfunction Notes() {\n  return null;\n}\n\nexport const Route = createFileRoute("/")({ component: Notes });\n';
      const built = await buildPages(
        env,
        withFiles(notesFiles(), {
          "src/routes/index.tsx":
            file === "src/routes/index.tsx"
              ? `${typeLines.join("\n")}\nexport type Q = typeof query | typeof internal;\n${page}`
              : page,
          ...(file === "notes.d.ts"
            ? {
                [file]: typeLines
                  .map((line) => line.replace("../../", "./"))
                  .join("\n"),
              }
            : {}),
        }).files,
        "app-test"
      );
      expect({
        ok: built.ok,
        refused: saidSchema
          .parse(built)
          .diagnostics.filter((diagnostic) => diagnostic.file === file)
          .map(({ message }) =>
            message.includes(
              "is the App's server code, which pages never import"
            )
          ),
      }).toStrictEqual({ ok: false, refused: [true, true, true, true] });
    }
  );

  it.each([
    [
      "the server constructors",
      'import { query } from "@server/_generated/server";',
    ],
    [
      "the internal references",
      'import { internal } from "@server/_generated/internal";',
    ],
    ["the schema", 'import schema from "../../server/schema.ts";'],
    ["the config", 'import notes from "../../grasp.config";'],
    ["an operation", 'import { create } from "../../server/notes.ts";'],
    [
      "an operation in a dotted folder",
      'import { create } from "../../server/v1.0/notes.ts";',
    ],
    [
      "a migration in a dotted folder",
      'import derive from "../../server/migrations/v1.0/derive.ts";',
    ],
    ["the host's SDK", 'import { inspectApp } from "@grasp-os/runtime/host";'],
  ])(
    "never import %s: the build fails before it starts",
    async (_case, line) => {
      const build = await buildPages(
        env,
        withFiles(notesFiles(), {
          "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
${line}\nfunction Notes() {\n  return null;\n}\n

export const Route = createFileRoute("/")({ component: Notes });
`,
        }).files,
        "app-test"
      );
      expect(build.ok).toBeFalsy();
      expect(build.diagnostics.map(({ message }) => message)).toStrictEqual([
        expect.stringContaining(
          "is the App's server code, which pages never import"
        ),
      ]);
    }
  );

  it.each([
    [
      "import type",
      'import type { Doc, Id } from "@server/_generated/dataModel";',
      [],
    ],
    [
      "type specifiers",
      'import { type Doc, type Id } from "@server/_generated/dataModel";',
      [],
    ],
    [
      "a value import",
      'import { Doc, Id } from "@server/_generated/dataModel";',
      [expect.stringContaining("import them with import type")],
    ],
    [
      "a value beside its types",
      'import { type Doc, type Id, default as model } from "@server/_generated/dataModel";',
      [expect.stringContaining("import them with import type")],
    ],
  ])(
    "take the data model's types by %s only, checked against the schema",
    async (_case, line, refused) => {
      const build = await buildPages(
        env,
        withFiles(notesFiles(), {
          "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
${line}

export const titleOf = (note: Doc<"notes">): string => note.title;
export const idOf = (note: Doc<"notes">): Id<"notes"> => note._id;

function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
        }).files,
        "app-test"
      );
      expect({
        ok: build.ok,
        said: build.diagnostics?.map(({ message }) => message) ?? [],
      }).toStrictEqual({ ok: refused.length === 0, said: refused });
    }
  );

  it("type-check a page's use of the data model against the App's own tables", async () => {
    const build = await buildPages(
      env,
      withFiles(notesFiles(), {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import type { Doc } from "@server/_generated/dataModel";

export const stray: Doc<"tasks"> | undefined = undefined;

function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
      }).files,
      "app-test"
    );
    expect({
      ok: build.ok,
      rules: build.diagnostics?.map(({ file, rule }) => `${file} ${rule}`),
    }).toStrictEqual({ ok: false, rules: ["src/routes/index.tsx TS2344"] });
  });
});
