import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  dataModelSource,
  generatedPaths,
  generateModules,
  inspectApp,
  readAppManifest,
  registerFunctions,
  serverModuleSource,
  symbolicModules,
} from "@grasp-os/sdk/host";
import type { Code, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vite-plus/test";

import { examplesDir } from "./vite.config.ts";

// Every TypeScript block in the guides is an App's file, checked as Grasp
// checks an App: a block names its file after its language
// (```ts server/tasks.ts), and a page's blocks are one App. Grasp
// generates `server/_generated/` for it as the host does (inspecting
// the App's registration for its references), and TypeScript 7 (tsgo)
// type-checks the whole App against the SDK. A guide whose example no
// longer compiles fails here, in the pull request that broke it.
//
// Pages build on the App of "An App's project" (guides/project.md): their
// blocks replace its files of the same name and add their own, so a guide
// shows only what it changes.

const content = path.join(import.meta.dirname, "content");
const basePage = "guides/project.md";
/** The extension of each TypeScript language's files. */
const typeScript: Readonly<Record<string, string>> = { ts: ".ts", tsx: ".tsx" };

/** The other languages a guide's code may be in, which nothing checks. */
const otherLanguages: ReadonlySet<string> = new Set(["text", "sh", "json"]);

/** A page's App: its files' text, by path. */
type Files = Record<string, string>;

/** Every guide under `content`, by its path there; never the reference. */
const pages = (dir = content): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "reference" ? [] : pages(full);
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
  const app = exportsOf(await import(path.join(dir, "app.ts")));
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
  // SAFETY: registerFunctions checks at run time that it was given an
  // App that `app` registered, as the host relies on.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const registered = app.default as Parameters<typeof registerFunctions>[0];
  const { manifest } = inspectApp(registerFunctions(registered, modules));
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

const tsconfig = {
  extends: path.join(import.meta.dirname, "../../tsconfig.base.json"),
  compilerOptions: {
    lib: ["es2024", "esnext.disposable", "dom", "dom.iterable"],
    jsx: "react-jsx",
    paths: { "@server/_generated/*": ["./server/_generated/*.ts"] },
  },
  include: ["**/*.ts", "**/*.tsx"],
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
    ...symbolicModules(),
    [generatedPaths.server]: serverModuleSource,
    [generatedPaths.dataModel]: dataModelSource,
    "tsconfig.json": JSON.stringify(tsconfig),
  });
  write(dir, await generated(dir, files));
  try {
    execFileSync(tsgo, ["-p", dir, "--pretty", "false"], { encoding: "utf-8" });
    return "";
  } catch (error) {
    // tsgo prints what it found, and exits with an error for it.
    return error instanceof Error && "stdout" in error
      ? String(error.stdout)
      : String(error);
  }
};

const base = filesOf(basePage);

/** The pages with code: the base, and each that shows a file of its own. */
const withCode = pages().filter(
  (page) => page === basePage || Object.keys(filesOf(page)).length > 0
);

describe("the guides' code", () => {
  it.each(withCode)("type-checks in %s", async (page) => {
    const files = page === basePage ? base : { ...base, ...filesOf(page) };
    await expect(typeErrors(page, files)).resolves.toBe("");
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
