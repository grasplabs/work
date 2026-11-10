/**
 * What the tests of packaging a definition package into a standalone
 * project (package-definition*.test.ts) share: the package, the SDK's
 * Notes fixture with a generated workflow, and how a test installs,
 * checks and runs the project it writes. Split into files so the installs
 * and checks, each many seconds, run on different workers and shards.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectApp, symbolicModules } from "@grasp-os/runtime/host";
import {
  definitionPackageFormatVersion,
  definitionPackageSchema,
} from "@grasp-os/shared/definition-packages";
import type { DefinitionPackage } from "@grasp-os/shared/definition-packages";
import { canonicalText } from "@grasp-os/shared/json";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import {
  definitionFormat,
  workflowSchemaUrl,
} from "@grasp-os/workflow-schema/format";
import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { parse } from "yaml";
import { z } from "zod";

import { hostModules } from "../apps/core/src/host-modules.ts";
import { oxcWasmModule } from "../packages/compiler/oxc-wasm/wasm.ts";
import {
  serverEntryPath,
  serverEntrySource,
} from "../packages/compiler/src/app-code.ts";
import { pageRuleNames } from "../packages/compiler/src/page-rules.ts";
import { ultraciteOf } from "../packages/compiler/src/ultracite.ts";
import { ultraciteConfig } from "../packages/compiler/ultracite-config.ts";
import { notesWorkflows } from "../packages/runtime/test/notes-workflows.ts";
import notes from "../packages/runtime/test/notes/.grasp/app.ts";
import { packageProject, PackagingError } from "./package-definition-lib.ts";

export const ROOT = path.join(import.meta.dirname, "..");
export const notesDir = path.join(ROOT, "packages/runtime/test/notes");
export const hash = (digit: string): string => digit.repeat(64);

/**
 * A module of the App's own that reads a workflow's event reference, which
 * types only when the references carry what the seal resolved.
 */
export const confirmations = `import { workflows } from "@server/_generated/api";

export const { confirmed } = workflows.archiveNotes.events;
`;

/** A page, which has the DOM as its frame does. */
export const notesPage = `import { createFileRoute } from "@tanstack/react-router";

const Notes = () => <p>{window.location.pathname}</p>;

export const Route = createFileRoute("/")({ component: Notes });
`;

/** The Notes fixture's source, as an App version's tree holds it. */
export const notesFiles = (): Record<string, string> => ({
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
 * grasp-workflow/2 definition, as publication does.
 */
export const greetingSource = (() => {
  const checked = checkWorkflow({
    $schema: workflowSchemaUrl,
    args: { kind: "object", fields: { who: { kind: "string" } } },
    returns: { kind: "object", fields: { status: { kind: "string" } } },
    result: { status: { $expr: '"Hello, " + args.who' } },
    steps: [{ id: "pause", type: "wait", for: "1 minute" }],
  });
  if (!checked.ok) {
    throw new Error("The greeting workflow isn't valid");
  }
  return generateWorkflow(checked.workflow).source;
})();

/** A greeting workflow's files, as its version seals them. */
export const greeting = (): Record<string, string> => ({
  ".grasp/workflow.ts": greetingSource,
});

/** A definition package of the Notes App binding the greeting workflow. */
export const definitionOf = (
  files: Record<string, string> = notesFiles()
): DefinitionPackage => ({
  formatVersion: definitionPackageFormatVersion,
  app: {
    version: 3,
    provenance: {
      manifestHash: hash("a"),
      sourceTreeHash: hash("b"),
      definitionHash: hash("f"),
      contractHash: hash("c"),
      schemaHash: hash("d"),
      dependencyLockHash: hash("e"),
      sdkVersion: "sdk-1",
      uiVersion: "ui-1",
      compilerVersion: "compiler-1",
      generated: {},
    },
    files,
    definition: { name: "Notes", permissions: [], tables: [], answers: [] },
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
    },
  },
  unresolved: [],
});

/** A locked package, as an App's lock records it. */
/** The integrity `locked` gives every package. */
export const lockedIntegrity = `sha512-${"A".repeat(86)}==`;
export const locked = (
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
});
export const lockOf = (
  direct: Record<string, string>,
  packages: ReturnType<typeof locked>[]
) =>
  JSON.stringify({
    lockfileVersion: 2,
    registry: "https://registry.npmjs.org",
    requested: Object.fromEntries(
      Object.entries(direct).map(([name, version]) => [name, `^${version}`])
    ),
    direct,
    entries: Object.keys(direct),
    packages: Object.fromEntries(
      packages.map((entry) => [`${entry.name}@${entry.version}`, entry])
    ),
  });

export const made: string[] = [];

/** A new empty directory, and where a project would go inside it. */
export const scratch = (): { dir: string; out: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-package-"));
  made.push(dir);
  return { dir, out: path.join(dir, "project") };
};

export const packaged = async (definition: unknown, out: string) =>
  await packageProject({ definition, out, repo: ROOT, commit: "f".repeat(40) });

/** What packaging refused with, or "ok". */
export const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof PackagingError ? "refused" : String(error);
  }
};

export const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});

export const exactOrPrerelease =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
export const sha512 = /^sha512-[A-Za-z0-9+/]{86}==$/u;

/** The integrity the checkout's lockfile pins `key` (`name@version`) with. */
export const kitIntegrity = (key: string): string =>
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
export const lockfileOf = (out: string) =>
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
export const metFor = (
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
export const checkoutStore = z
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
export const installIn = async (
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
export const installedVersion = (dir: string, name: string): string =>
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
export const platformChecker = installedVersion(
  "packages/compiler",
  "@tsrs/wasm"
);

/**
 * Grasp's own lint and format of App code (ultracite.ts), on the oxc.wasm
 * its isolate runs.
 */
export const ultracite = ultraciteOf(await oxcWasmModule(), ultraciteConfig());
export const { lintCode } = ultracite;

/** `files` as a write saves them: tidied, or as written where `tidy` keeps them. */
export const tidy = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(ultracite.tidy(files)).map(([file, tidied]) => [
      file,
      tidied ?? files[file] ?? "",
    ])
  );

/** The oxc-parser a project's check parses App files with: the oxc of oxc.wasm. */
export const platformParser = installedVersion(
  "packages/compiler",
  "oxc-parser"
);

export const problemLine =
  /^(?<file>[^(:]+)(?:\(\d+,\d+\))?: error (?<code>\S+):/u;

/**
 * The project's own check (`npm run typecheck`), as a developer runs it:
 * its status, and the codes of what it reported, by file.
 */
export const projectCheck = (
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
export const run = (
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
export const designFinding = (finding: string): boolean =>
  pageRuleNames.has(finding.split(" ")[2] ?? "");

/** A rule as oxlint's report codes it: `plugin(rule)`, `eslint(rule)`. */
export const reportCode = /^(?<plugin>[^(]+)\((?<rule>[^)]+)\)$/u;

/**
 * What oxlint's JSON report found: each finding's file, severity and
 * rule, by the name Grasp's lint reports it by (`unicorn/no-array-reduce`).
 */
export const rulesOf = (report: string): string[] =>
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
export const graspRulesOf = (files: Record<string, string>): string[] =>
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
export const unusedNames = `import { Badge } from "@grasp-os/ui/components/badge";

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
export const blueprintFiles = (name: string): Record<string, string> => {
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
export const appDefinition = async (
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
    path.join(ROOT, "packages/runtime"),
    path.join(dir, "node_modules/@grasp-os/runtime")
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
