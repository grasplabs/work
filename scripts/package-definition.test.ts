import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectApp, symbolicModules } from "@grasp-os/sdk/host";
import {
  definitionPackageFormatVersion,
  definitionPackageSchema,
} from "@grasp-os/shared/definition-packages";
import type { DefinitionPackage } from "@grasp-os/shared/definition-packages";
import { canonicalText } from "@grasp-os/shared/json";
import { graspLockSchema } from "@grasp-os/shared/packages";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import {
  definitionFormat,
  workflowSchemaUrl,
} from "@grasp-os/workflow-schema/format";
import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { parse } from "yaml";
import { z } from "zod";

import { hostModules } from "../apps/core/src/host-modules.ts";
import { designCases, designFindings } from "../apps/core/test/design-cases.ts";
import { steeringCases } from "../apps/core/test/steering-cases.ts";
import {
  oxcWasmModule,
  oxcWasmPin,
} from "../packages/compiler/oxc-wasm/wasm.ts";
import {
  serverEntryPath,
  serverEntrySource,
} from "../packages/compiler/src/app-code.ts";
import { pageRuleNames } from "../packages/compiler/src/page-rules.ts";
import { ultraciteOf } from "../packages/compiler/src/ultracite.ts";
import { ultraciteConfig } from "../packages/compiler/ultracite-config.ts";
import { notesWorkflows } from "../packages/sdk/test/notes-workflows.ts";
import notes from "../packages/sdk/test/notes/.grasp/app.ts";
import {
  packageProject,
  PackagingError,
  readCatalog,
} from "./package-definition-lib.ts";
import { projectLockfile } from "./package-definition-lockfile.ts";

// Packaging a definition package into a standalone project
// (package-definition-lib.ts). The package is the SDK's Notes fixture, an
// App as the product lays it out, and a workflow generated as a version
// seals it; the project is checked as written, and every refusal leaves
// nothing behind.

const ROOT = path.join(import.meta.dirname, "..");
const notesDir = path.join(ROOT, "packages/sdk/test/notes");
const hash = (digit: string): string => digit.repeat(64);

/**
 * A module of the App's own that reads a workflow's event reference, which
 * types only when the references carry what the seal resolved.
 */
const confirmations = `import { workflows } from "@server/_generated/api";

export const { confirmed } = workflows.archiveNotes.events;
`;

/** A page, which has the DOM as its frame does. */
const notesPage = `import { createFileRoute } from "@tanstack/react-router";

const Notes = () => <p>{window.location.pathname}</p>;

export const Route = createFileRoute("/")({ component: Notes });
`;

/** The Notes fixture's source, as an App version's tree holds it. */
const notesFiles = (): Record<string, string> => ({
  ...Object.fromEntries(
    ["grasp.config.ts", "server/schema.ts", "server/notes.ts"].map((file) => [
      file,
      readFileSync(path.join(notesDir, file), "utf-8"),
    ])
  ),
  "server/confirmations.ts": confirmations,
  "src/routes/index.tsx": notesPage,
});

/**
 * The TypeScript a greeting workflow's version generates, from its
 * grasp-workflow/1 definition, as publication does.
 */
const greetingSource = (() => {
  const checked = checkWorkflow({
    $schema: workflowSchemaUrl,
    input: {
      type: "object",
      properties: { who: { type: "string" } },
      required: ["who"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
      value: { status: { $expr: '"Hello, " + input.who' } },
    },
    steps: [{ id: "pause", type: "wait", for: "1 minute" }],
  });
  if (!checked.ok) {
    throw new Error("The greeting workflow isn't valid");
  }
  return generateWorkflow(checked.workflow, "workflow").source;
})();

/** A greeting workflow's files, as its version seals them. */
const greeting = (): Record<string, string> => ({
  ".grasp/workflow.ts": greetingSource,
  "code/double.ts":
    "export const double = (value: number): number => value * 2;\n",
});

/** A definition package of the Notes App binding the greeting workflow. */
const definitionOf = (
  files: Record<string, string> = notesFiles()
): DefinitionPackage => ({
  formatVersion: definitionPackageFormatVersion,
  app: {
    version: 3,
    provenance: {
      manifestHash: hash("a"),
      sourceTreeHash: hash("b"),
      contractHash: hash("c"),
      schemaHash: hash("d"),
      dependencyLockHash: hash("e"),
      sdkVersion: "sdk-1",
      uiVersion: "ui-1",
      compilerVersion: "compiler-1",
      generated: {},
    },
    files,
    manifest: canonicalText(inspectApp(notes).manifest),
    store: null,
    bindings: {},
    workflows: {
      archiveNotes: "workspace/greet/1.0.0",
      summarizeNote: "workspace/greet/1.0.0",
    },
    // As core packages them: plain JSON, read back by the package schema.
    workflowContracts:
      definitionPackageSchema.shape.app.shape.workflowContracts.parse(
        structuredClone(
          Object.fromEntries(
            notesWorkflows.map(({ alias, events, listens, decisions }) => [
              alias,
              { events, listens, decisions },
            ])
          )
        )
      ),
  },
  workflows: {
    "workspace/greet/1.0.0": {
      provenance: {
        manifestHash: hash("1"),
        definitionHash: hash("2"),
        buildHash: hash("4"),
        profile: definitionFormat,
      },
      files: greeting(),
      bindings: {},
      packages: null,
    },
  },
  unresolved: [],
});

/** A locked package, as an App's lock records it. */
/** The integrity `locked` gives every package. */
const lockedIntegrity = `sha512-${"A".repeat(86)}==`;
const locked = (
  name: string,
  version: string,
  license: string | null,
  dependencies: Record<string, string> = {}
) => ({
  name,
  version,
  integrity: lockedIntegrity,
  license,
  publishedAt: "2026-01-01T00:00:00.000Z",
  dependencies,
  peers: {},
});
const lockOf = (
  direct: Record<string, string>,
  packages: ReturnType<typeof locked>[],
  platformPeers: Record<string, string> = {}
) =>
  JSON.stringify({
    lockfileVersion: 1,
    registry: "https://registry.npmjs.org",
    requested: Object.fromEntries(
      Object.entries(direct).map(([name, version]) => [name, `^${version}`])
    ),
    direct,
    platformPeers,
    targets: {},
    packages: Object.fromEntries(
      packages.map((entry) => [`${entry.name}@${entry.version}`, entry])
    ),
  });

const made: string[] = [];

/** A new empty directory, and where a project would go inside it. */
const scratch = (): { dir: string; out: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-package-"));
  made.push(dir);
  return { dir, out: path.join(dir, "project") };
};

const packaged = async (definition: unknown, out: string) =>
  await packageProject({ definition, out, repo: ROOT, commit: "f".repeat(40) });

/** What packaging refused with, or "ok". */
const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof PackagingError ? "refused" : String(error);
  }
};

const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});

const exactOrPrerelease =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const sha512 = /^sha512-[A-Za-z0-9+/]{86}==$/u;

/** The integrity the checkout's lockfile pins `key` (`name@version`) with. */
const kitIntegrity = (key: string): string =>
  z
    .object({
      packages: z.record(
        z.string(),
        z.object({ resolution: z.object({ integrity: z.string() }) })
      ),
    })
    .parse(parse(readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf-8")))
    .packages[key]?.resolution.integrity ?? "";

/** What a test reads of a project's pnpm-lock.yaml. */
const lockfileOf = (out: string) =>
  z
    .object({
      importers: z.record(
        z.string(),
        z.object({
          dependencies: z
            .record(z.string(), z.object({ version: z.string() }))
            .optional(),
        })
      ),
      packages: z.record(
        z.string(),
        z.object({ resolution: z.object({ integrity: z.string() }) })
      ),
      snapshots: z.record(
        z.string(),
        z.object({ dependencies: z.record(z.string(), z.string()).optional() })
      ),
    })
    .parse(parse(readFileSync(path.join(out, "pnpm-lock.yaml"), "utf-8")));

/** What meets `peer` for the kit's package `name`, at any version. */
const metFor = (
  lockfile: ReturnType<typeof lockfileOf>,
  name: string,
  peer: string
): (string | undefined)[] =>
  Object.entries(lockfile.snapshots)
    .filter(([key]) => key.startsWith(`${name}@`))
    .map(([, snapshot]) => snapshot.dependencies?.[peer]);

/**
 * The store the checkout installed into, as its install recorded it. Named
 * to every install here: unnamed, pnpm takes a store on the project's own
 * file system, so a temporary directory on another file system than the
 * checkout's (as on one CI shard) installs from an empty one.
 */
const checkoutStore = z
  .object({ storeDir: z.string() })
  .parse(
    parse(readFileSync(path.join(ROOT, "node_modules/.modules.yaml"), "utf-8"))
  ).storeDir;

/**
 * The project's install as a developer runs it, by the checkout's own
 * package manager, from the store the checkout installed into; pnpm's
 * re-check of each pin against the registry's publish times is skipped,
 * as it needs the registry: the checkout made those pins.
 */
const installIn = async (
  out: string,
  args: string[]
): Promise<{ status: number | null; output: string }> => {
  // Not a CI run, which pnpm freezes on its own: only the project's own
  // settings may freeze an install here.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.toLowerCase().startsWith("npm_")
      )
    ),
    CI: "false",
  };
  const passed = args.includes("--") ? args : [...args, "--"];
  const child = spawn(
    path.join(ROOT, "node_modules/.bin/vp"),
    ["install", ...passed, "--trust-lockfile", `--store-dir=${checkoutStore}`],
    { cwd: out, env }
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const [status] = z
    .tuple([z.number().nullable()])
    .rest(z.unknown())
    .parse(await once(child, "close"));
  return { status, output };
};

/** The version of `name` installed at `dir` (from the repo's root). */
const installedVersion = (dir: string, name: string): string =>
  z
    .object({ version: z.string() })
    .parse(
      JSON.parse(
        readFileSync(
          path.join(ROOT, dir, "node_modules", name, "package.json"),
          "utf-8"
        )
      )
    ).version;

/** The checker the platform type-checks App code with: the compiler's tsrs. */
const platformChecker = installedVersion("packages/compiler", "@tsrs/wasm");

/**
 * Grasp's own lint and format of App code (ultracite.ts), on the oxc.wasm
 * its isolate runs.
 */
const ultracite = ultraciteOf(await oxcWasmModule(), ultraciteConfig());
const { lintCode } = ultracite;

/** `files` as a write saves them: tidied, or as written where `tidy` keeps them. */
const tidy = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(ultracite.tidy(files)).map(([file, tidied]) => [
      file,
      tidied ?? files[file] ?? "",
    ])
  );

/** The oxc-parser a project's check parses App files with: the oxc of oxc.wasm. */
const platformParser = installedVersion("packages/compiler", "oxc-parser");

const problemLine = /^(?<file>[^(:]+)(?:\(\d+,\d+\))?: error (?<code>\S+):/u;

/**
 * The project's own check (`npm run typecheck`), as a developer runs it:
 * its status, and the codes of what it reported, by file.
 */
const projectCheck = (
  out: string
): { status: number | null; problems: Record<string, string[]> } => {
  const checked = spawnSync(process.execPath, ["grasp/check.ts"], {
    cwd: out,
    encoding: "utf-8",
  });
  const problems: Record<string, string[]> = {};
  for (const line of checked.stderr.split("\n")) {
    const groups = problemLine.exec(line)?.groups;
    if (groups?.file !== undefined && groups.code !== undefined) {
      problems[groups.file] = [...(problems[groups.file] ?? []), groups.code];
    } else if (line.trim() !== "") {
      problems["(output)"] = [...(problems["(output)"] ?? []), line];
    }
  }
  return { status: checked.status, problems };
};

/**
 * The project's own script `name` with `args`, as `pnpm run` runs it: in
 * a shell, with the project's installed bins first on its path.
 */
const run = (
  out: string,
  name: string,
  ...args: string[]
): { status: number | null; output: string; stdout: string } => {
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(path.join(out, "package.json"), "utf-8")));
  const script = scripts[name];
  if (script === undefined) {
    return { status: null, output: `no script ${name}`, stdout: "" };
  }
  const ran = spawnSync([script, ...args].join(" "), {
    cwd: out,
    encoding: "utf-8",
    shell: true,
    // Outside this test run, as a developer's shell has it: under Vite+
    // (`VP_VERSION`), oxlint reads Vite+'s config in place of its own.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([variable]) => !/^(?:vp|npm)_/iu.test(variable)
        )
      ),
      PATH: `${path.join(out, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return {
    status: ran.status,
    output: `${ran.stdout}${ran.stderr}`,
    stdout: ran.stdout,
  };
};

/** A finding of `rulesOf` of the pages' own rules (the compiler's page-rules.ts). */
const designFinding = (finding: string): boolean =>
  pageRuleNames.has(finding.split(" ")[2] ?? "");

/** A rule as oxlint's report codes it: `plugin(rule)`, `eslint(rule)`. */
const reportCode = /^(?<plugin>[^(]+)\((?<rule>[^)]+)\)$/u;

/**
 * What oxlint's JSON report found: each finding's file, severity and
 * rule, by the name Grasp's lint reports it by (`unicorn/no-array-reduce`).
 */
const rulesOf = (report: string): string[] =>
  z
    .object({
      diagnostics: z.array(
        z.object({
          severity: z.string(),
          code: z.string(),
          filename: z.string(),
        })
      ),
    })
    .parse(JSON.parse(report))
    .diagnostics.map(({ severity, code, filename }) => {
      const { plugin = "", rule = code } = reportCode.exec(code)?.groups ?? {};
      const name = plugin === "eslint" ? rule : `${plugin}/${rule}`;
      return `${filename} ${severity === "warning" ? "warning" : "error"} ${name}`;
    })
    .toSorted();

/**
 * What Grasp's lint of App code (ultracite.ts `lintCode`) finds in
 * `files`, by path in the App, as `rulesOf` reads a project's under `app/`.
 */
const graspRulesOf = (files: Record<string, string>): string[] =>
  Object.entries(lintCode(files))
    .flatMap(([file, found]) =>
      found.map(({ severity, rule }) => `app/${file} ${severity} ${rule}`)
    )
    .toSorted();

/**
 * A component with unused names: an import, a local, a trailing
 * parameter, and one only a type predicate reads (oxlint reports it; it
 * passes a name only a type query reads).
 */
const unusedNames = `import { Badge } from "@grasp-os/ui/components/badge";

const row = { id: 1 };
export type Row = typeof row;

export const total = (ctx: number, count: number, spare: number): number => {
  const left = 1;
  return count;
};

export const isNumber = (value: unknown, extra: unknown): extra is number =>
  typeof value === "number";
`;

/** A built-in blueprint's App files, by path. */
const blueprintFiles = (name: string): Record<string, string> => {
  const dir = path.join(ROOT, "apps/core/blueprints", name, "files");
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [
          path.relative(dir, file).split(path.sep).join("/"),
          readFileSync(file, "utf-8"),
        ];
      })
  );
};

/**
 * A definition package of an App of `files` that binds no workflow but
 * packages the greeting's version, as core exports one: its files, and
 * the manifest its seal reads first, inspected as core inspects it
 * (app-inspection.ts): its server entry (`serverEntrySource`) over its
 * code, the host's modules and the stand-in references it lends
 * (`symbolicModules`).
 */
const appDefinition = async (
  files: Record<string, string>
): Promise<DefinitionPackage> => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-blueprint-"));
  made.push(dir);
  const code = {
    ...files,
    ...symbolicModules(),
    ...hostModules,
    [serverEntryPath]: serverEntrySource(Object.keys(files)),
    // `@server/_generated/<module>` resolves, as the compiler aliases it,
    // through a package of that name linked to the folder.
    "server/_generated/package.json": JSON.stringify({
      type: "module",
      exports: { "./*": "./*.ts" },
    }),
  };
  for (const [file, source] of Object.entries(code)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), source);
  }
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }');
  mkdirSync(path.join(dir, "node_modules/@grasp-os"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules/@server"), { recursive: true });
  symlinkSync(
    path.join(ROOT, "packages/sdk"),
    path.join(dir, "node_modules/@grasp-os/sdk")
  );
  symlinkSync(
    path.join(dir, "server/_generated"),
    path.join(dir, "node_modules/@server/_generated")
  );
  const loaded: unknown = await import(
    pathToFileURL(path.join(dir, serverEntryPath)).href
  );
  const registered = z.object({ default: z.unknown() }).parse(loaded).default;
  return {
    ...definitionOf(files),
    app: {
      ...definitionOf(files).app,
      manifest: canonicalText(inspectApp(registered).manifest),
      workflows: {},
      workflowContracts: {},
    },
  };
};

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

    it("writes the App with its references generated anew, the workflow, the vendored kit and notices, pinned exactly and offline", async () => {
      const fetches = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetches);
      const { out } = scratch();
      const definition = definitionOf();
      const written = await packaged(definition, out);
      const read = (file: string) =>
        readFileSync(path.join(out, file), "utf-8");

      const root = packageJsonSchema.parse(JSON.parse(read("package.json")));
      const vendored = ["brain", "sdk", "ui", "shared"].map((name) =>
        packageJsonSchema
          .pick({ dependencies: true })
          .parse(JSON.parse(read(`vendor/@grasp-os/${name}/package.json`)))
      );
      const versions = [
        ...Object.entries(root.dependencies),
        ...Object.entries(root.devDependencies),
        ...vendored.flatMap(({ dependencies }) => Object.entries(dependencies)),
      ].filter(([, version]) => !version.startsWith("link:"));
      const lockfile = lockfileOf(out);
      const lockedKeys = Object.keys(lockfile.packages);
      const notices = read("THIRD-PARTY-NOTICES.md");

      expect({
        app: written.filter((file) => file.startsWith("app/")),
        workflow: written.filter((file) => file.startsWith("workflows/")),
        vendorTests: written.filter(
          (file) => file.startsWith("vendor/") && /\.test|\/test\//u.test(file)
        ),
        sameSource:
          read("app/grasp.config.ts") === notesFiles()["grasp.config.ts"],
        sealedContracts: read("app/server/_generated/api.ts").includes(
          "notes.archive.confirmed"
        ),
        localIdentity:
          read("app/server/_generated/api.ts").includes('"local"') &&
          !read("app/server/_generated/api.ts").includes("app_0000"),
        grasp: Object.keys(root.dependencies).filter((name) =>
          name.startsWith("@grasp-os/")
        ),
        // An exact version, a prerelease's included, never a range.
        notExact: versions.filter(
          ([, version]) => !exactOrPrerelease.test(version)
        ),
        unnoticed: versions
          .map(([name]) => name)
          .filter((name) => !notices.includes(`| ${name} |`)),
        licence:
          read("LICENSES/AGPL-3.0-only.txt") ===
          readFileSync(path.join(ROOT, "LICENSE"), "utf-8"),
        fetched: fetches.mock.calls.length,
        withoutIntegrity: Object.entries(lockfile.packages)
          .filter(([, entry]) => !sha512.test(entry.resolution.integrity))
          .map(([key]) => key),
        notExactlyLocked: lockedKeys.filter(
          (key) => !exactOrPrerelease.test(key.slice(key.lastIndexOf("@") + 1))
        ),
        unlocked: versions
          .map(([name, version]) => `${name}@${version}`)
          .filter((key) => !lockedKeys.includes(key)),
        importers: Object.keys(lockfile.importers).toSorted(),
      }).toStrictEqual({
        app: [
          "app/.grasp/contracts.json",
          "app/grasp.config.ts",
          "app/server/_generated/api.ts",
          "app/server/_generated/dataModel.ts",
          "app/server/_generated/internal.ts",
          "app/server/_generated/server.ts",
          "app/server/confirmations.ts",
          "app/server/notes.ts",
          "app/server/schema.ts",
          // Its pages' route tree and root route, as the platform's build
          // gives them.
          "app/src/routeTree.gen.ts",
          "app/src/routes/__root.tsx",
          "app/src/routes/index.tsx",
          "app/tsconfig.pages.json",
          "app/tsconfig.server.json",
        ],
        workflow: [
          "workflows/greet/1.0.0/.grasp/workflow.ts",
          "workflows/greet/1.0.0/code/double.ts",
          "workflows/greet/1.0.0/tsconfig.generated.json",
          "workflows/greet/1.0.0/tsconfig.json",
        ],
        vendorTests: [],
        sameSource: true,
        sealedContracts: true,
        localIdentity: true,
        grasp: [
          "@grasp-os/brain",
          "@grasp-os/shared",
          "@grasp-os/sdk",
          "@grasp-os/ui",
        ],
        notExact: [],
        unnoticed: [],
        licence: true,
        fetched: 0,
        withoutIntegrity: [],
        notExactlyLocked: [],
        unlocked: [],
        importers: [
          ".",
          "vendor/@grasp-os/brain",
          "vendor/@grasp-os/sdk",
          "vendor/@grasp-os/shared",
          "vendor/@grasp-os/ui",
        ],
      });
    });

    it("type-checks as the platform does: what it accepts passes, with the platform's checker, and what it refuses fails", async () => {
      const { out } = scratch();
      await packaged(definitionOf(), out);
      const install = await installIn(out, ["--frozen-lockfile", "--offline"]);
      const project = packageJsonSchema.parse(
        JSON.parse(readFileSync(path.join(out, "package.json"), "utf-8"))
      );
      // What the platform accepts, read as its parser reads it: a regular
      // expression holding `//` after a `)`, and a `///` comment of prose.
      const valid: Record<string, string> = {
        "workflows/greet/1.0.0/code/pattern.ts":
          "export const check = (text: string): void => {\n  if (text) /[//] @ts-ignore/u.test(text);\n};\n",
        "app/src/components/prose.tsx":
          "/// The notes page.\n/// <summary>Notes</summary>\nexport const notes = 1;\n",
        // A declaration file read as declarations, as the platform reads it.
        "app/declared.d.ts":
          "export const limit: number;\nexport type Limit = typeof limit;\n",
      };
      const write = (files: Record<string, string>): void => {
        for (const [file, source] of Object.entries(files)) {
          mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
          writeFileSync(path.join(out, file), source);
        }
      };
      write(valid);
      const accepted = projectCheck(out);
      for (const file of Object.keys(valid)) {
        rmSync(path.join(out, file));
      }
      const held = {
        lint: run(out, "lint").status,
        format: run(out, "format:check").status,
      };

      // What the platform's check refuses, each in a file of its own: a
      // type error in a page and in a compute module; server code and a
      // compute module reaching the DOM, which their isolate lacks; and a
      // compute module importing what its kind may not.
      const mistyped: Record<string, string> = {
        "app/src/components/typo.tsx": 'export const count: number = "none";\n',
        "workflows/greet/1.0.0/code/typo.ts":
          "export const half = (value: number): string => value / 2;\n",
        "workflows/greet/1.0.0/code/window.ts":
          "export const here = (): string => window.location.href;\n",
        "app/server/document.ts":
          "export const title = (): string => document.title;\n",
        "workflows/greet/1.0.0/code/kit.ts":
          'import { Button } from "@grasp-os/ui/components/button";\n\nexport const button = Button;\n',
        // A package the SDK imports, which a compute module itself may not.
        "workflows/greet/1.0.0/code/zod.ts":
          'import { z } from "zod";\n\nexport const name = z.string();\n',
        // A directive below the top of a page, which TypeScript ignores
        // but the platform refuses wherever it stands.
        "app/src/components/late.tsx":
          'export const late = 1;\n/// <reference types="node" />\n',
      };
      // And what its build refuses before any check: every way a file
      // could steer the check, in server code and a compute module alike.
      const steering: Record<string, string> = {
        // Globals a page declares, which the platform refuses in every
        // kind of App code; and server code the parser refuses, or that
        // names a missing file, each refused once.
        "app/src/components/globals.tsx":
          "export {};\ndeclare global {\n  interface Window {\n    leak: number;\n  }\n}\n",
        "app/server/unparsed.ts": "export const = ;\n",
        "app/server/reference.ts":
          '/// <reference path="./missing.ts" />\nexport const one = 1;\n',
        // A suppression after a division by a non-null value, never a
        // regular expression.
        "workflows/greet/1.0.0/code/non-null.ts":
          "const x: number | undefined = 1;\nexport const y = x! / 2; // @ts-ignore\nexport const b: string = 1;\n",
        "app/server/ambient.ts":
          "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
        "workflows/greet/1.0.0/code/dom.ts":
          '/// <reference lib="dom" />\nexport const title = (): string => document.title;\n',
        ...Object.fromEntries(
          steeringCases("@grasp-os/sdk/compute").map(([, source], index) => [
            `workflows/greet/1.0.0/code/steering-${index}.ts`,
            source,
          ])
        ),
      };
      write(mistyped);
      const failedCheck = projectCheck(out);
      for (const file of Object.keys(mistyped)) {
        rmSync(path.join(out, file));
      }
      // The App's own declarations are checked, as the platform checks
      // them: only the packages' are another's to check.
      write({ "app/declared.d.ts": "export type Count = Missing;\n" });
      const declared = projectCheck(out);
      rmSync(path.join(out, "app/declared.d.ts"));
      write(steering);
      const failedBuild = projectCheck(out);
      const codesOf = (file: string): string[] =>
        failedBuild.problems[file] ?? [];

      expect({
        install: install.status,
        checker: {
          tsrs: project.devDependencies["@tsrs/wasm"],
          // No TypeScript of its own: the check is tsrs's.
          typescript: project.devDependencies.typescript,
          // The parser it reads files with, as the platform's oxc does.
          parser: project.devDependencies["oxc-parser"],
        },
        // Its lint and format: the releases Grasp's isolate runs.
        tools: {
          oxlint: project.devDependencies.oxlint,
          oxfmt: project.devDependencies.oxfmt,
        },
        held,
        declared,
        accepted,
        failedCheck,
        failedBuild: {
          status: failedBuild.status,
          files: Object.keys(failedBuild.problems).toSorted(),
          notSteering: Object.entries(failedBuild.problems)
            .filter(([file]) => file !== "app/server/unparsed.ts")
            .flatMap(([, codes]) => codes)
            .filter((code) => code !== "steering"),
          shared: {
            unparsed: codesOf("app/server/unparsed.ts"),
            reference: codesOf("app/server/reference.ts"),
          },
        },
      }).toStrictEqual({
        install: 0,
        checker: {
          tsrs: platformChecker,
          typescript: undefined,
          parser: platformParser,
        },
        tools: { oxlint: oxcWasmPin.oxlint, oxfmt: oxcWasmPin.oxfmt },
        held: { lint: 0, format: 0 },
        declared: { status: 1, problems: { "app/declared.d.ts": ["TS2304"] } },
        accepted: { status: 0, problems: {} },
        failedCheck: {
          status: 1,
          problems: {
            "app/server/document.ts": ["TS2584"],
            "app/src/components/late.tsx": ["imports"],
            "app/src/components/typo.tsx": ["TS2322"],
            "workflows/greet/1.0.0/code/kit.ts": ["TS2307"],
            "workflows/greet/1.0.0/code/typo.ts": ["TS2322"],
            "workflows/greet/1.0.0/code/window.ts": ["TS2304"],
            "workflows/greet/1.0.0/code/zod.ts": ["TS2307"],
          },
        },
        failedBuild: {
          status: 1,
          files: Object.keys(steering).toSorted(),
          notSteering: [],
          shared: { unparsed: ["compile"], reference: ["steering"] },
        },
      });
    });

    it("installs from its lockfile alone, frozen and offline from what the checkout installed, and refuses a manifest that drifted from it", async () => {
      const { out } = scratch();
      await packaged(definitionOf(), out);
      const install = await installIn(out, ["--frozen-lockfile", "--offline"]);
      // A manifest that names what the lockfile doesn't is refused, not
      // resolved, by a plain install: the project's own settings freeze
      // its installs to its lockfile.
      const manifest = z
        .looseObject({ dependencies: z.record(z.string(), z.string()) })
        .parse(
          JSON.parse(readFileSync(path.join(out, "package.json"), "utf-8"))
        );
      writeFileSync(
        path.join(out, "package.json"),
        JSON.stringify({
          ...manifest,
          dependencies: { ...manifest.dependencies, "left-pad": "1.3.0" },
        })
      );
      const drifted = await installIn(out, ["--offline"]);
      expect({
        install: install.status,
        drifted: {
          status: drifted.status === 0 ? "installed" : "refused",
          why: drifted.output.includes("ERR_PNPM_OUTDATED_LOCKFILE"),
        },
      }).toStrictEqual({
        install: 0,
        drifted: { status: "refused", why: true },
      });
    });

    it("refuses at install a tarball other than the one its lockfile pins", async () => {
      const { out } = scratch();
      await packaged(definitionOf(), out);
      // The registry serves something else for one pinned package: here a
      // registry of the test's own, and a pin to a tarball it doesn't
      // have, so the install fetches it rather than reusing the store.
      const served: string[] = [];
      const registry = createServer((request, response) => {
        served.push(request.url ?? "");
        if (request.url?.endsWith(".tgz") === true) {
          response.end("not the pinned tarball");
        } else {
          response.writeHead(404).end();
        }
      });
      registry.listen(0, "127.0.0.1");
      await once(registry, "listening");
      const address = registry.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      const lockText = readFileSync(path.join(out, "pnpm-lock.yaml"), "utf-8");
      const zodKey = Object.keys(lockfileOf(out).packages).find((key) =>
        key.startsWith("zod@")
      );
      const tampered = lockText.replace(
        new RegExp(
          `("${zodKey}": \\{\\n\\s+"resolution": \\{\\n\\s+"integrity": ")[^"]+`,
          "u"
        ),
        `$1sha512-${"A".repeat(86)}==`
      );
      writeFileSync(path.join(out, "pnpm-lock.yaml"), tampered);
      const install = await installIn(out, [
        "--frozen-lockfile",
        "--",
        `--registry=http://127.0.0.1:${port}/`,
        "--fetch-retries=0",
      ]);
      registry.close();
      expect({
        tampered: tampered !== lockText,
        status: install.status === 0 ? "installed" : "refused",
        why: install.output.includes("ERR_PNPM_TARBALL_INTEGRITY"),
        fetched: served.filter((url) => url.endsWith(".tgz")),
      }).toStrictEqual({
        tampered: true,
        status: "refused",
        why: true,
        fetched: [`/zod/-/${zodKey?.replace("@", "-")}.tgz`],
      });
    });

    it("refuses a path that leaves its directory, collides once folded, a tool reads, or a file system can't hold, and writes nothing", async () => {
      const paths = [
        "../escape.ts",
        "server/../../escape.ts",
        "/etc/passwd",
        "C:/Windows/win.ini",
        "server\\notes.ts",
        "server//notes.ts",
        "./grasp.config.ts",
        "nul\0.ts",
        "GRASP.config.ts",
        "ſerver/notes.ts",
        "server/_generated/server.ts",
        "CON.ts",
        "server/lpt1",
        "notes.ts.",
        "notes.ts ",
        "tab\u0009.ts",
        ".git/config",
        "server/.GIT/hooks/pre-commit",
        ".npmrc",
        ".vscode/settings.json",
        // What a package manager run inside app/ would read or install into.
        "pnpm-workspace.yaml",
        "server/PNPM-LOCK.yaml",
        ".pnpmfile.cjs",
        ".pnpmfile.mjs",
        ".pnpmfile.js",
        "node_modules/left-pad/index.js",
        ".yarnrc",
        ".yarnrc.yml",
        "bunfig.toml",
        `${"a".repeat(256)}.ts`,
      ];
      const outcomes: Record<string, string> = {};
      for (const file of paths) {
        const { dir, out } = scratch();
        const definition = definitionOf({
          ...notesFiles(),
          [file]: "export {};\n",
        });
        // oxlint-disable-next-line no-await-in-loop -- one project at a time
        const outcome = await refusalOf(packaged(definition, out));
        outcomes[file] = `${outcome}, ${readdirSync(dir).length} written`;
      }
      expect(outcomes).toStrictEqual(
        Object.fromEntries(paths.map((file) => [file, "refused, 0 written"]))
      );
    });

    it("pins the App's locked packages and their dependencies exactly, and refuses a lock that would replace what the project pins", async () => {
      const withLock = (lock: string) =>
        definitionOf({
          ...notesFiles(),
          "package.json": JSON.stringify({
            dependencies: { "date-kit": "^1.2.0" },
          }),
          "grasp.lock.json": lock,
        });
      const { out } = scratch();
      await packaged(
        withLock(
          lockOf({ "date-kit": "1.2.0" }, [
            {
              ...locked("date-kit", "1.2.0", "MIT | injected\n| row |", {
                "tz-data": "2.0.1",
              }),
              // A peer the graph meets is pinned like a dependency; one the
              // platform meets is the project's own.
              peers: {
                "tz-rules": { range: "^3.0.0", resolved: "3.1.0", by: "graph" },
                react: { range: "^19.0.0", resolved: "19.3.0", by: "platform" },
              },
            },
            locked("tz-rules", "3.1.0", "MIT"),
            locked("tz-data", "2.0.1", "Apache-2.0"),
          ])
        ),
        out
      );
      const project = z
        .object({ dependencies: z.record(z.string(), z.string()) })
        .parse(
          JSON.parse(readFileSync(path.join(out, "package.json"), "utf-8"))
        );
      const lockfile = lockfileOf(out);
      const notices = readFileSync(
        path.join(out, "THIRD-PARTY-NOTICES.md"),
        "utf-8"
      );
      const zod = readCatalog(
        readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf-8")
      ).get("zod");
      const refused = await Promise.all(
        [
          lockOf({ "@grasp-os/sdk": "9.9.9" }, [
            locked("@grasp-os/sdk", "9.9.9", "MIT"),
          ]),
          lockOf({ react: "18.0.0" }, [locked("react", "18.0.0", "MIT")]),
          lockOf({ oxlint: "1.0.0" }, [locked("oxlint", "1.0.0", "MIT")]),
          lockOf({ "date-kit": "1.2.0" }, [
            locked("date-kit", "1.2.0", "MIT", { react: "18.0.0" }),
            locked("react", "18.0.0", "MIT"),
          ]),
          lockOf({ "date-kit": "1.2.0" }, [
            locked("date-kit", "1.2.0", "MIT", { "@grasp-os/shared": "1.0.0" }),
            locked("@grasp-os/shared", "1.0.0", "MIT"),
          ]),
          // A peer its graph met at one version, the project at another.
          lockOf({ "date-kit": "1.2.0", "tz-rules": "3.2.0" }, [
            {
              ...locked("date-kit", "1.2.0", "MIT"),
              peers: {
                "tz-rules": { range: "^3.0.0", resolved: "3.1.0", by: "graph" },
              },
            },
            locked("tz-rules", "3.1.0", "MIT"),
            locked("tz-rules", "3.2.0", "MIT"),
          ]),
          // The tarball the kit installs, with other dependencies.
          lockOf({ "date-kit": "1.2.0" }, [
            locked("date-kit", "1.2.0", "MIT", { zod: zod ?? "" }),
            {
              ...locked("zod", zod ?? "", "MIT", { "left-pad": "1.3.0" }),
              integrity: kitIntegrity(`zod@${zod ?? ""}`),
            },
            locked("left-pad", "1.3.0", "WTFPL"),
          ]),
          // The version of a package the kit installs, as another tarball.
          lockOf({ "date-kit": "1.2.0" }, [
            locked("date-kit", "1.2.0", "MIT", { zod: zod ?? "" }),
            locked("zod", zod ?? "", "MIT"),
          ]),
        ].map(
          async (lock) =>
            await refusalOf(packaged(withLock(lock), scratch().out))
        )
      );
      expect({
        dateKit: project.dependencies["date-kit"],
        locked: Object.fromEntries(
          ["date-kit@1.2.0", "tz-data@2.0.1", "tz-rules@3.1.0"].map((key) => [
            key,
            {
              integrity: lockfile.packages[key]?.resolution.integrity,
              dependencies: lockfile.snapshots[key]?.dependencies ?? {},
            },
          ])
        ),
        notices: notices
          .split("\n")
          .filter(
            (line) => line.startsWith("| date-kit") || line.includes("injected")
          ),
        refused,
      }).toStrictEqual({
        dateKit: "1.2.0",
        locked: {
          // Its peers met as the lock met them: one by the graph, React by
          // the project's own.
          "date-kit@1.2.0": {
            integrity: lockedIntegrity,
            dependencies: {
              react: lockfile.importers["."]?.dependencies?.react?.version,
              "tz-data": "2.0.1",
              "tz-rules": "3.1.0",
            },
          },
          "tz-data@2.0.1": { integrity: lockedIntegrity, dependencies: {} },
          "tz-rules@3.1.0": { integrity: lockedIntegrity, dependencies: {} },
        },
        notices: ["| date-kit | 1.2.0 | unknown | the App's lock |"],
        refused: [
          "refused",
          "refused",
          "refused",
          "refused",
          "refused",
          "refused",
          "refused",
          "refused",
        ],
      });
    });

    it("pins a workflow version's approved packages exactly as its lock resolved them, and refuses one a project can't install", async () => {
      /** The package with workflow `greet` sealing `packages`. */
      const withPackages = (
        packages: DefinitionPackage["workflows"][string]["packages"],
        files: Record<string, string> = notesFiles()
      ): DefinitionPackage => {
        const definition = definitionOf(files);
        const greet = definition.workflows["workspace/greet/1.0.0"];
        if (greet === undefined) {
          throw new Error("No greeting workflow");
        }
        return {
          ...definition,
          workflows: { "workspace/greet/1.0.0": { ...greet, packages } },
        };
      };
      const sealed = (lock: string | null) => ({
        graphHash: hash("9"),
        entries: ["date-kit"],
        lock: lock === null ? null : graspLockSchema.parse(JSON.parse(lock)),
      });
      const dateKit = (version: string) =>
        lockOf({ "date-kit": version }, [
          locked("date-kit", version, "MIT", { "tz-data": "2.0.1" }),
          locked("tz-data", "2.0.1", "Apache-2.0"),
        ]);
      const { out } = scratch();
      await packaged(withPackages(sealed(dateKit("1.2.0"))), out);
      const project = z
        .object({ dependencies: z.record(z.string(), z.string()) })
        .parse(
          JSON.parse(readFileSync(path.join(out, "package.json"), "utf-8"))
        );
      const lockfile = lockfileOf(out);
      const recorded = z
        .object({
          workflows: z.record(z.string(), z.object({ packages: z.unknown() })),
        })
        .parse(
          JSON.parse(
            readFileSync(path.join(out, "grasp-project.json"), "utf-8")
          )
        );
      const notices = readFileSync(
        path.join(out, "THIRD-PARTY-NOTICES.md"),
        "utf-8"
      );
      const withAppLock = (version: string) => ({
        ...notesFiles(),
        "package.json": JSON.stringify({
          dependencies: { "date-kit": `^${version}` },
        }),
        "grasp.lock.json": dateKit(version),
      });
      const refusals = {
        // The App's lock and the workflow's pin one package at two versions.
        conflicting: await refusalOf(
          packaged(
            withPackages(sealed(dateKit("1.2.0")), withAppLock("1.3.0")),
            scratch().out
          )
        ),
        // The same version in both is one pin.
        agreeing: await refusalOf(
          packaged(
            withPackages(sealed(dateKit("1.2.0")), withAppLock("1.2.0")),
            scratch().out
          )
        ),
        unlocked: await refusalOf(
          packaged(withPackages(sealed(null)), scratch().out)
        ),
        ownedByProject: await refusalOf(
          packaged(
            withPackages(
              sealed(
                lockOf({ react: "18.0.0" }, [locked("react", "18.0.0", "MIT")])
              )
            ),
            scratch().out
          )
        ),
      };
      expect({
        dateKit: project.dependencies["date-kit"],
        dependencies: lockfile.snapshots["date-kit@1.2.0"]?.dependencies,
        recorded: recorded.workflows["workspace/greet/1.0.0"]?.packages,
        notices: notices
          .split("\n")
          .filter((line) => line.startsWith("| date-kit")),
        refusals,
      }).toStrictEqual({
        dateKit: "1.2.0",
        dependencies: { "tz-data": "2.0.1" },
        recorded: { graphHash: hash("9"), entries: ["date-kit"] },
        notices: ["| date-kit | 1.2.0 | MIT | workspace/greet/1.0.0's lock |"],
        refusals: {
          conflicting: "refused",
          agreeing: "ok",
          unlocked: "refused",
          ownedByProject: "refused",
        },
      });
    });

    it("refuses a package of another format by its format, saying how to recover", async () => {
      // As core exported them before a workflow carried its packages.
      const { workflows, ...current } = definitionOf();
      const older = {
        ...current,
        formatVersion: 1,
        workflows: Object.fromEntries(
          Object.entries(workflows).map(
            ([key, { packages: _packages, ...workflow }]) => [key, workflow]
          )
        ),
      };
      let message = "packaged";
      try {
        await packaged(older, scratch().out);
      } catch (error) {
        message =
          error instanceof PackagingError ? error.message : String(error);
      }
      let newer = "packaged";
      try {
        await packaged(
          {
            ...current,
            workflows,
            formatVersion: definitionPackageFormatVersion + 1,
          },
          scratch().out
        );
      } catch (error) {
        newer = error instanceof PackagingError ? error.message : String(error);
      }
      expect({ message, newer }).toStrictEqual({
        message: `The package is format 1; this checkout reads format ${definitionPackageFormatVersion}. Export the App's definition again.`,
        newer: `The package is format ${definitionPackageFormatVersion + 1}; this checkout reads format ${definitionPackageFormatVersion}. Update this checkout to package it.`,
      });
    });

    it("meets the kit's peers only from the kit, a lock's as its lock met them, and refuses a peer outside its range or a platform it wasn't resolved against", async () => {
      const withLock = (lock: string) =>
        definitionOf({
          ...notesFiles(),
          "package.json": JSON.stringify({
            dependencies: Object.fromEntries(
              Object.keys(
                z
                  .object({ direct: z.record(z.string(), z.string()) })
                  .parse(JSON.parse(lock)).direct
              ).map((name) => [name, "*"])
            ),
          }),
          "grasp.lock.json": lock,
        });
      const lockfileFor = async (lock: string) => {
        const { out } = scratch();
        await packaged(withLock(lock), out);
        return lockfileOf(out);
      };
      // An App's own versions of packages the kit's packages take as
      // optional peers: never what meets them, not another version, nor
      // the very one the checkout met a peer with outside the kit's graph.
      const kit = lockfileOf(
        await (async () => {
          const { out } = scratch();
          await packaged(definitionOf(), out);
          return out;
        })()
      );
      const withOwn = await lockfileFor(
        lockOf({ "date-fns": "3.0.0", "supports-color": "10.2.2" }, [
          locked("date-fns", "3.0.0", "MIT"),
          {
            ...locked("supports-color", "10.2.2", "MIT"),
            integrity: kitIntegrity("supports-color@10.2.2"),
          },
        ])
      );
      const peered = (peers: Record<string, unknown>, platformPeers = {}) =>
        lockOf(
          { "date-kit": "1.2.0" },
          [
            { ...locked("date-kit", "1.2.0", "MIT"), peers },
            locked("tz-rules", "3.1.0", "MIT"),
          ],
          platformPeers
        );
      const refusals = {
        platformElsewhere: await refusalOf(
          packaged(
            withLock(
              peered({
                react: { range: "^17.0.0", resolved: "17.0.2", by: "platform" },
              })
            ),
            scratch().out
          )
        ),
        outsideRange: await refusalOf(
          packaged(
            withLock(
              peered({
                "tz-rules": { range: "^4.0.0", resolved: "3.1.0", by: "graph" },
              })
            ),
            scratch().out
          )
        ),
        dependencyAndPeerDiffer: await refusalOf(
          packaged(
            withLock(
              lockOf({ "date-kit": "1.2.0" }, [
                {
                  ...locked("date-kit", "1.2.0", "MIT", {
                    "tz-rules": "3.0.0",
                  }),
                  peers: {
                    "tz-rules": {
                      range: "^3.0.0",
                      resolved: "3.1.0",
                      by: "graph",
                    },
                  },
                },
                locked("tz-rules", "3.0.0", "MIT"),
                locked("tz-rules", "3.1.0", "MIT"),
              ])
            ),
            scratch().out
          )
        ),
        resolvedAgainstAnotherPlatform: await refusalOf(
          packaged(withLock(peered({}, { react: "17.0.2" })), scratch().out)
        ),
        // A kit package a lock names too, its peer met in the lock's graph
        // with a version the kit doesn't install: the project would leave
        // it unmet.
        kitPeerTheLockMet: await refusalOf(
          packaged(
            withLock(
              lockOf({ debug: "4.4.3" }, [
                {
                  ...locked("debug", "4.4.3", "MIT", { ms: "2.1.3" }),
                  integrity: kitIntegrity("debug@4.4.3"),
                  peers: {
                    "supports-color": {
                      range: "*",
                      resolved: "10.2.2",
                      by: "graph",
                    },
                  },
                },
                {
                  ...locked("supports-color", "10.2.2", "MIT"),
                  integrity: kitIntegrity("supports-color@10.2.2"),
                },
                {
                  ...locked("ms", "2.1.3", "MIT"),
                  integrity: kitIntegrity("ms@2.1.3"),
                },
              ])
            ),
            scratch().out
          )
        ),
        // A kit package a lock names too, its peer met by the platform at
        // a version the project doesn't install: refused as for any other.
        kitPackagePlatformElsewhere: await refusalOf(
          packaged(
            withLock(
              lockOf({ "lucide-react": "1.47.0" }, [
                {
                  ...locked("lucide-react", "1.47.0", "ISC"),
                  integrity: kitIntegrity("lucide-react@1.47.0"),
                  peers: {
                    react: {
                      range: "^16.5.1 || ^17.0.0 || ^18.0.0 || ^19.0.0",
                      resolved: "17.0.2",
                      by: "platform",
                    },
                  },
                },
              ])
            ),
            scratch().out
          )
        ),
      };
      expect({
        dateFns: metFor(withOwn, "@base-ui/react", "date-fns"),
        supportsColor: metFor(withOwn, "debug", "supports-color"),
        refusals,
      }).toStrictEqual({
        dateFns: metFor(kit, "@base-ui/react", "date-fns"),
        supportsColor: metFor(kit, "debug", "supports-color"),
        refusals: {
          platformElsewhere: "refused",
          outsideRange: "refused",
          dependencyAndPeerDiffer: "refused",
          resolvedAgainstAnotherPlatform: "refused",
          kitPeerTheLockMet: "refused",
          kitPackagePlatformElsewhere: "refused",
        },
      });
    });

    it("installs an App's locked packages with their peers as the lockfile meets them, and refuses one whose tarball isn't the one pinned", async () => {
      // The App's packages, as a registry of the test's own serves them.
      const tarballs = new Map<string, Buffer>();
      const tarball = (name: string, version: string, index: string) => {
        const dir = mkdtempSync(path.join(tmpdir(), "grasp-tarball-"));
        made.push(dir);
        mkdirSync(path.join(dir, "package"));
        writeFileSync(
          path.join(dir, "package/package.json"),
          JSON.stringify({ name, version, main: "index.js" })
        );
        writeFileSync(path.join(dir, "package/index.js"), index);
        spawnSync("tar", ["-czf", "package.tgz", "-C", dir, "package"], {
          cwd: dir,
        });
        const bytes = readFileSync(path.join(dir, "package.tgz"));
        tarballs.set(`/${name}/-/${name}-${version}.tgz`, bytes);
        return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      };
      const lock = (dateKitIntegrity?: string) =>
        lockOf({ "date-kit": "1.2.0" }, [
          {
            ...locked("date-kit", "1.2.0", "MIT", { "tz-data": "2.0.1" }),
            integrity:
              dateKitIntegrity ??
              tarball(
                "date-kit",
                "1.2.0",
                'module.exports = [require("tz-data"), require("tz-rules"), require("react").version];\n'
              ),
            peers: {
              "tz-rules": { range: "^3.0.0", resolved: "3.1.0", by: "graph" },
              react: { range: "^19.0.0", resolved: "19.3.0", by: "platform" },
            },
          },
          {
            ...locked("tz-data", "2.0.1", "MIT"),
            integrity: tarball(
              "tz-data",
              "2.0.1",
              'module.exports = "tz-data";\n'
            ),
          },
          {
            ...locked("tz-rules", "3.1.0", "MIT"),
            integrity: tarball(
              "tz-rules",
              "3.1.0",
              'module.exports = "tz-rules";\n'
            ),
          },
        ]);
      const registry = createServer((request, response) => {
        const bytes = tarballs.get(request.url ?? "");
        if (bytes === undefined) {
          response.writeHead(404).end();
        } else {
          response.end(bytes);
        }
      });
      registry.listen(0, "127.0.0.1");
      await once(registry, "listening");
      const address = registry.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      const installed = async (appLock: string) => {
        const { out } = scratch();
        await packaged(
          definitionOf({
            ...notesFiles(),
            "package.json": JSON.stringify({
              dependencies: { "date-kit": "^1.2.0" },
            }),
            "grasp.lock.json": appLock,
          }),
          out
        );
        const install = await installIn(out, [
          "--frozen-lockfile",
          "--",
          `--registry=http://127.0.0.1:${port}/`,
          "--fetch-retries=0",
        ]);
        const loaded = spawnSync(
          process.execPath,
          ["-p", 'JSON.stringify(require("date-kit"))'],
          { cwd: out, encoding: "utf-8" }
        );
        return { install, loaded: loaded.stdout.trim() };
      };
      const accepted = await installed(lock());
      const tampered = await installed(
        lock(`sha512-${createHash("sha512").update("other").digest("base64")}`)
      );
      registry.close();
      expect({
        accepted: { status: accepted.install.status, loaded: accepted.loaded },
        tampered: {
          status: tampered.install.status === 0 ? "installed" : "refused",
          why: tampered.install.output.includes("ERR_PNPM_TARBALL_INTEGRITY"),
        },
      }).toStrictEqual({
        accepted: {
          status: 0,
          loaded: JSON.stringify(["tz-data", "tz-rules", "19.3.0"]),
        },
        tampered: { status: "refused", why: true },
      });
    });

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

    it("renames the finished project onto an empty --out and leaves nothing beside it", async () => {
      const { dir, out } = scratch();
      mkdirSync(out);
      await packaged(definitionOf(), out);
      expect({
        beside: readdirSync(dir),
        written: readdirSync(out).toSorted(),
      }).toStrictEqual({
        beside: ["project"],
        written: [
          ".oxfmtrc.json",
          "LICENSES",
          "THIRD-PARTY-NOTICES.md",
          "app",
          "grasp",
          "grasp-project.json",
          "oxlint.config.ts",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig.json",
          "vendor",
          "workflows",
        ],
      });
    });

    it("refuses a directory that isn't empty, a key that isn't a workflow's, and dependencies with no lock", async () => {
      const used = scratch();
      writeFileSync(path.join(used.dir, "kept.txt"), "kept");
      const definition = definitionOf();
      const { greet } = {
        greet: definition.workflows["workspace/greet/1.0.0"],
      };
      expect({
        nonEmpty: await refusalOf(packaged(definition, used.dir)),
        kept: readFileSync(path.join(used.dir, "kept.txt"), "utf-8"),
        key: await refusalOf(
          packaged(
            {
              ...definition,
              workflows: { "workspace/../../escape/1.0.0": greet },
            },
            scratch().out
          )
        ),
        unlocked: await refusalOf(
          packaged(
            definitionOf({
              ...notesFiles(),
              "package.json": JSON.stringify({
                dependencies: { "left-pad": "^1.0.0" },
              }),
            }),
            scratch().out
          )
        ),
        notAPackage: await refusalOf(
          packaged(
            { formatVersion: definitionPackageFormatVersion },
            scratch().out
          )
        ),
      }).toStrictEqual({
        nonEmpty: "refused",
        kept: "kept",
        key: "refused",
        unlocked: "refused",
        notAPackage: "refused",
      });
    });
  }
);

describe("a packaged project's lockfile", () => {
  it("follows a checkout package's alias to the package it names, and keeps the alias", () => {
    const integrity = `sha512-${"A".repeat(86)}==`;
    const checkoutLock = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  server@1.0.0:",
      `    resolution: {integrity: ${integrity}}`,
      "  h3@2.0.1-rc.20:",
      `    resolution: {integrity: ${integrity}}`,
      "snapshots:",
      "  server@1.0.0:",
      "    dependencies:",
      "      h3-v2: h3@2.0.1-rc.20",
      "  h3@2.0.1-rc.20: {}",
      "",
    ].join("\n");

    const written = z
      .object({
        packages: z.record(z.string(), z.unknown()),
        snapshots: z.record(
          z.string(),
          z.object({ dependencies: z.record(z.string(), z.string()) }).partial()
        ),
      })
      .parse(
        parse(
          projectLockfile({
            checkoutLock,
            importers: {
              ".": {
                dependencies: { server: "1.0.0" },
                devDependencies: {},
                peerDependencies: {},
              },
            },
            locks: [],
          })
        )
      );

    expect({
      packages: Object.keys(written.packages).toSorted(),
      server: written.snapshots["server@1.0.0"]?.dependencies,
    }).toStrictEqual({
      packages: ["h3@2.0.1-rc.20", "server@1.0.0"],
      server: { "h3-v2": "h3@2.0.1-rc.20" },
    });
  });
});
