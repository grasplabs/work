import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { buildFiles, routeTreePath } from "@grasp-os/compiler/inputs";
import { startOxc } from "@grasp-os/compiler/oxc";
import { oxcWasmModule } from "@grasp-os/compiler/oxc-wasm";
import { pageServerImports } from "@grasp-os/compiler/page-imports";
import { routeTree } from "@grasp-os/compiler/route-tree";
import {
  dataModelSource,
  generatedPaths,
  generateModules,
  inspectApp,
  readAppManifest,
  registerApp,
  serverModuleSource,
  symbolicModules,
} from "@grasp-os/runtime/host";
import type { Code, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vite-plus/test";

import { examplesDir } from "./vite.config.ts";

// Every TypeScript block in the guides is an App's file, checked as Grasp
// checks an App: a block names its file after its language
// (```ts server/tasks.ts), and a page's blocks are one App. Grasp
// generates `server/_generated/` for it as the host does (inspecting
// the App's registration for its references), and its pages' route tree
// as the compiler does, and TypeScript 7 (tsgo) type-checks the whole App
// against the SDK. Its pages' imports are held to what a pages build
// refuses them for (the App's server code, the platform's own modules),
// so a guide never shows an import the build turns down. A guide whose
// example no longer compiles fails here, in the pull request that broke
// it.
//
// Pages build on the App of "An App's project" (guides/project.md): their
// blocks replace its files of the same name and add their own, so a guide
// shows only what it changes.

// The route tree reads the pages' syntax with oxc, as the compiler's
// isolate does.
startOxc(await oxcWasmModule());

const content = path.join(import.meta.dirname, "content");
const basePage = "guides/project.md";
/** The extension of each TypeScript language's files. */
const typeScript: Readonly<Record<string, string>> = { ts: ".ts", tsx: ".tsx" };

/** The other languages a guide's code may be in, which nothing checks. */
const otherLanguages: ReadonlySet<string> = new Set(["text", "sh", "json"]);

/** A page's App: its files' text, by path. */
type Files = Record<string, string>;

/**
 * Every guide under `content`, by its path there; never the reference
 * nor the example Apps, generated from what core's tests build.
 */
const pages = (dir = content): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["reference", "examples"].includes(entry.name) ? [] : pages(full);
    }
    return /\.mdx?$/u.test(entry.name) ? [path.relative(content, full)] : [];
  });

const codeBlocks = (node: Nodes): Code[] => {
  if (node.type === "code") {
    return [node];
  }
  return "children" in node ? node.children.flatMap(codeBlocks) : [];
};

/**
 * The TypeScript blocks of `markdown` (the page `page`), as the files they
 * name. Every block is tagged with one of `languages`, so none escapes
 * the check under another name, and a TypeScript block names its file
 * with the extension its language has.
 */
const filesIn = (page: string, markdown: string): Files => {
  const files: Files = {};
  for (const block of codeBlocks(fromMarkdown(markdown))) {
    const language = block.lang ?? "";
    const extension = typeScript[language];
    if (!(extension !== undefined || otherLanguages.has(language))) {
      throw new Error(
        `${page}: tag each code block with its language, one of ts, tsx, ${[...otherLanguages].join(", ")}; not "${language}".`
      );
    }
    if (extension === undefined) {
      continue;
    }
    const [file = ""] = (block.meta ?? "").split(/\s+/u);
    if (!file.endsWith(extension)) {
      throw new Error(
        `${page}: name the file of each ${language} block after its language, ending in ${extension}: \`\`\`${language} server/tasks${extension}`
      );
    }
    if (file in files) {
      throw new Error(`${page}: ${file} is shown twice.`);
    }
    files[file] = `${block.value}\n`;
  }
  return files;
};

const filesOf = (page: string): Files =>
  filesIn(page, readFileSync(path.join(content, page), "utf-8"));

const write = (dir: string, files: Files): void => {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(dir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
};

/** Whether `file` is one of the App's server modules, as the host reads it. */
const isServerModule = (file: string): boolean =>
  file.startsWith("server/") &&
  file !== "server/schema.ts" &&
  !file.startsWith("server/_generated/") &&
  !file.startsWith("server/migrations/") &&
  file.endsWith(".ts");

/** What an imported module exports, by name. */
const exportsOf = (module: unknown): Record<string, unknown> =>
  typeof module === "object" && module !== null
    ? Object.fromEntries(Object.entries(module))
    : {};

/**
 * The modules Grasp generates for the App in `dir`: its server modules
 * imported, registered and inspected, as the host's inspection does, and
 * its references generated from the manifest that gives.
 */
const generated = async (dir: string, files: Files): Promise<Files> => {
  const config = exportsOf(await import(path.join(dir, "grasp.config.ts")));
  const schema = exportsOf(await import(path.join(dir, "server/schema.ts")));
  // Each by its path under server/, without `.ts`, as the host's entry
  // registers them.
  const modules = Object.fromEntries(
    await Promise.all(
      Object.keys(files)
        .filter(isServerModule)
        .map(async (file): Promise<[string, Record<string, unknown>]> => [
          file.slice("server/".length, -".ts".length),
          exportsOf(await import(path.join(dir, file))),
        ])
    )
  );
  // SAFETY: registerApp checks at run time that it was given a config
  // `defineApp` made and a schema `defineSchema` made, as the host's
  // entry relies on.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const parts = {
    config: config.default,
    schema: schema.default,
    modules,
    migrations: [],
  } as Parameters<typeof registerApp>[0];
  const { manifest } = inspectApp(registerApp(parts));
  return await generateModules(readAppManifest(JSON.stringify(manifest)), {
    resourceId: "docs",
    resourceVersion: 1,
  });
};

/** The repo's TypeScript: 7, tsgo (this package has 6, for TypeDoc). */
const tsgo = path.join(
  path.dirname(
    createRequire(path.join(import.meta.dirname, "../../package.json")).resolve(
      "typescript/package.json"
    )
  ),
  "bin/tsc"
);

/**
 * How tsc ends when it found type errors, with or without writing
 * output; any other unsuccessful end checked nothing.
 */
const typeErrorsFound: ReadonlySet<number> = new Set([1, 2]);

/** One of tsc's diagnostics, as `--pretty false` prints it. */
const diagnostic = /\berror TS\d+:/u;

const tsconfig = {
  extends: path.join(import.meta.dirname, "../../tsconfig.base.json"),
  compilerOptions: {
    lib: ["es2024", "esnext.disposable", "dom", "dom.iterable"],
    jsx: "react-jsx",
    paths: { "@server/_generated/*": ["./server/_generated/*.ts"] },
  },
  include: ["**/*.ts", "**/*.tsx"],
};

/**
 * The type errors tsgo finds in the project in `dir`: none when it exits
 * 0, its diagnostics when it exits for having found some. Any other end
 * (a crash, a signal, a refused config, an error exit that prints no
 * diagnostic) throws: it checked nothing.
 */
const typeCheck = (dir: string, compiler = tsgo): string => {
  const run = spawnSync(compiler, ["-p", dir, "--pretty", "false"], {
    encoding: "utf-8",
  });
  if (run.status === 0) {
    return "";
  }
  if (
    run.status !== null &&
    typeErrorsFound.has(run.status) &&
    diagnostic.test(run.stdout)
  ) {
    return run.stdout;
  }
  throw new Error(
    `tsgo didn't finish its check (${run.error?.message ?? `exit ${String(run.status ?? run.signal)}`}): ${run.stderr}${run.stdout}`
  );
};

/**
 * The App's pages as the compiler routes them: its route files as the
 * route generator leaves them, the root route it adds when there is none,
 * and the route tree, which types their routes. Nothing for an App with
 * no pages.
 */
const routed = async (files: Files): Promise<Files> => {
  const built = buildFiles(files);
  const tree = await routeTree(built);
  if (tree.diagnostics.length > 0) {
    throw new Error(
      `The pages don't route: ${tree.diagnostics.map(({ message }) => message).join("; ")}`
    );
  }
  return tree.source === undefined
    ? {}
    : { ...tree.routes, [routeTreePath]: tree.source };
};

/** The App `files` builds into, with what Grasp generates for it. */
const typeErrors = async (page: string, files: Files): Promise<string> => {
  // One folder per page, side by side (vite.config.ts resolves each
  // App's generated modules by its folder).
  const dir = path.join(
    examplesDir,
    page.replace(/\.mdx?$/u, "").replaceAll("/", "-")
  );
  rmSync(dir, { force: true, recursive: true });
  write(dir, {
    ...files,
    ...(await routed(files)),
    ...symbolicModules(),
    [generatedPaths.server]: serverModuleSource,
    [generatedPaths.dataModel]: dataModelSource,
    "tsconfig.json": JSON.stringify(tsconfig),
  });
  write(dir, await generated(dir, files));
  return typeCheck(dir);
};

/** What a pages build refuses of the imports of `files`' front end, as `file:line message`. */
const importRefusals = (files: Files): string[] =>
  Object.entries(files)
    .filter(([file]) => file.startsWith("src/"))
    .flatMap(([file, source]) =>
      pageServerImports(file, source).map(
        ({ line, message }) => `${file}:${line ?? 0} ${message}`
      )
    );

const base = filesOf(basePage);

/** The pages with code: the base, and each that shows a file of its own. */
const withCode = pages().filter(
  (page) => page === basePage || Object.keys(filesOf(page)).length > 0
);

describe("the guides' code", () => {
  it.each(withCode)(
    "type-checks in %s, importing only what a page build allows",
    async (page) => {
      const files = page === basePage ? base : { ...base, ...filesOf(page) };
      expect(importRefusals(files)).toStrictEqual([]);
      await expect(typeErrors(page, files)).resolves.toBe("");
    }
  );

  it("refuses a page's import the build refuses", () => {
    expect(
      importRefusals({
        "src/routes/index.tsx":
          'import { query } from "@server/_generated/server";\n\nexport const used = query;\n',
      })
    ).toStrictEqual([
      expect.stringContaining(
        'src/routes/index.tsx:1 "@server/_generated/server" is the App\'s server code'
      ),
    ]);
  });

  it("answers the type errors tsgo finds", () => {
    const dir = path.join(examplesDir, "type-error");
    rmSync(dir, { force: true, recursive: true });
    write(dir, {
      "index.ts": 'export const count: number = "one";\n',
      "tsconfig.json": JSON.stringify(tsconfig),
    });

    expect(typeCheck(dir)).toContain("error TS2322:");
  });

  it("fails when the check doesn't finish, whatever it printed", () => {
    // Node runs `-p <dir>` as code, fails on it, and prints only to
    // stderr: as a compiler that crashes does.
    expect(() => typeCheck(examplesDir, process.execPath)).toThrow(
      "tsgo didn't finish its check"
    );
  });

  it("reads a TypeScript block as the file it names", () => {
    expect(
      filesIn("a.md", "```ts schema.ts\nexport {};\n```\n\n```text\nany\n```")
    ).toStrictEqual({ "schema.ts": "export {};\n" });
  });

  it.each([
    ["an untagged block", "```\nexport {};\n```"],
    ["another name for TypeScript", "```typescript schema.ts\nexport {};\n```"],
    ["a title instead of a file", '```ts title="schema.ts"\nexport {};\n```'],
    ["a file without its extension", "```ts schema\nexport {};\n```"],
    ["a file of another kind", "```ts notes.txt\nexport {};\n```"],
    ["a .ts file in a tsx block", "```tsx page.ts\nexport {};\n```"],
  ])("lets no code escape the check: %s", (_, markdown) => {
    expect(() => filesIn("a.md", markdown)).toThrow("a.md: ");
  });
});
