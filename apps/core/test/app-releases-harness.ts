import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  sdkReleaseManifests,
  sdkResourceBindings,
} from "../src/db/core/schema.ts";
import { buildAppCode, buildAppTests, buildPages } from "../src/pages.ts";
import { testApp, withFiles } from "./app-definitions.ts";
import type { AppSpec, TestApp, TestSource } from "./app-definitions.ts";
import { appWith, artifactKey, putArtifact, seal } from "./sealed-apps.ts";

// What app-releases*.test.ts share: the Apps they seal and how they read
// and rewrite a sealed release.

/** Notes, laid out as spec 8 has an App: its schema, operations and registration. */
/** The Notes App's definition, named `label`. */
export const notesSpec = (label = "Notes"): AppSpec => ({
  name: label,
  tables: {
    notes: {
      fields: {
        title: "v.string().trim().min(1).max(200)",
        body: 'v.string().max(100_000).default("")',
      },
      access: { read: "owner", write: "owner" },
      indexes: { by_updated: ["_updatedAt"] },
    },
  },
});

export const notesFiles = (label = "Notes"): TestApp =>
  testApp(notesSpec(label), {
    "values.ts": `import { v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};
`,
    "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { internal } from "@server/_generated/internal";
import { action, doc, internalQuery, mutation, query } from "@server/_generated/server";
import { noteFields } from "../values.ts";

export const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

export const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const notes = await ctx.db.query("notes").take(100);
    return notes.length;
  },
});

export const tally = action({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.runQuery(internal.notes.count, {}),
});
`,
  });

/** The Notes App's files with one more table, `name`. */
export const withTable = (name: string): TestApp => {
  const spec = notesSpec();
  return testApp(
    {
      ...spec,
      tables: { ...spec.tables, [name]: { fields: { label: "v.string()" } } },
    },
    notesFiles().files
  );
};

/** The artifact of `release` at `path`. */
export const artifactAt = (release: Release, path: string) => {
  const entry = release.manifest.artifacts.find(
    (artifact) => artifact.path === path
  );
  if (entry === undefined) {
    throw new Error(`No artifact at ${path}`);
  }
  return entry;
};

/** How many builds of an App's server code the build cache holds. */
export const builds = async (): Promise<number> => {
  const listed = await env.FILES.list({ prefix: "build-cache/" });
  return listed.objects.filter(({ key }) => key.includes("/app-build/")).length;
};

/** A table-less App: nothing to store, so no store binding. */
export const tablelessFiles = (): TestApp =>
  testApp(
    { name: "Hello", tables: {} },
    {
      "server/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";
export const hello = query({ args: {}, returns: v.string(), handler: () => "hello" });
`,
    }
  );

/** JSON text that holds an object, as a mutable record. */
export const jsonRecord = (text: string): Record<string, Json> => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Not a JSON object");
  }
  // SAFETY: parsed JSON, checked just above to be an object.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return parsed as Record<string, Json>;
};

/** Where a release's check evidence is among its artifacts. */
export const evidencePath = ".grasp/verification.json";

/** What a consistent rewrite of a sealed release changes. */
export interface Rewrite {
  /** Changes the check's evidence, recorded again for the rewritten release first. */
  readonly evidence?: (evidence: Record<string, Json>) => void;
  /** The evidence's text, when not canonical. */
  readonly evidenceText?: (evidence: Record<string, Json>) => string;
  /** Changes the manifest once its evidence is recorded again. */
  readonly last?: (manifest: Record<string, Json>) => void;
  /** Changes `contracts.json`, stored again under its new hash. */
  readonly contracts?: (contracts: Record<string, Json>) => void;
  /** Changes the manifest. */
  readonly manifest?: (manifest: Record<string, Json>) => void;
  /** The manifest's text, when not canonical. */
  readonly text?: (manifest: Record<string, Json>) => string;
}

/** The text of the stored artifact `entry` names, as a load decodes it. */
export const storedText = async (entry: Json): Promise<[string, string]> => {
  const { path, sha256 } = z
    .object({ path: z.string(), sha256: z.string() })
    .parse(entry);
  const stored = await env.FILES.get(await artifactKey(sha256));
  const bytes = (await stored?.arrayBuffer()) ?? new ArrayBuffer(0);
  return [
    path,
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  ];
};

/** The modules among `manifest`'s artifacts under `dir`, by name. */
export const modulesUnder = async (
  manifest: Record<string, Json>,
  dir: string
): Promise<Record<string, string>> => {
  const entries = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const texts = await Promise.all(entries.map(storedText));
  return Object.fromEntries(
    texts
      .filter(([path]) => path.startsWith(dir))
      .map(([path, text]) => [path.slice(dir.length), text])
  );
};

/**
 * Records the check's evidence of `release` again for `manifest`, its
 * rewrite, as someone with write access to storage could: its identities
 * the rewritten manifest's and the hashes of its modules, SDK and
 * migration evidence recomputed, then `change.evidence` applied, stored
 * under its new hash and named by the manifest.
 */
export const recordEvidence = async (
  release: Release,
  manifest: Record<string, Json>,
  change: Rewrite
): Promise<void> => {
  const entry = artifactAt(release, evidencePath);
  const stored = await env.FILES.get(await artifactKey(entry.sha256));
  const evidence = jsonRecord((await stored?.text()) ?? "{}");
  const observed = jsonRecord(JSON.stringify(evidence.observed));
  evidence.source = {
    resourceId: manifest.resourceId ?? null,
    sourceTreeHash: manifest.sourceTreeHash ?? null,
    definitionHash: manifest.definitionHash ?? null,
  };
  evidence.candidate = {
    resourceVersion: manifest.resourceVersion ?? null,
    contractHash: manifest.contractHash ?? null,
    schemaHash: manifest.schemaHash ?? null,
  };
  evidence.profile = {
    target: manifest.target ?? null,
    compilerVersion: manifest.compilerVersion ?? null,
    sdkVersion: manifest.sdkVersion ?? null,
    uiVersion: manifest.uiVersion ?? null,
  };
  observed.checkedModules = await sha256Hex(
    canonicalJson(await modulesUnder(manifest, "modules/"))
  );
  observed.sdkModules = await sha256Hex(
    canonicalJson(await modulesUnder(manifest, "sdk/"))
  );
  observed.migrations = await sha256Hex(
    canonicalJson(manifest.migrationEvidence ?? null)
  );
  evidence.observed = observed;
  change.evidence?.(evidence);
  const text = change.evidenceText?.(evidence) ?? canonicalJson(evidence);
  const bytes = new TextEncoder().encode(text);
  const sha256 = await sha256Hex(text);
  await putArtifact(sha256, bytes);
  const artifacts: readonly Json[] = Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : [];
  manifest.artifacts = artifacts.map((artifact) =>
    z.object({ path: z.string() }).parse(artifact).path === evidencePath
      ? { path: evidencePath, sha256, bytes: bytes.byteLength }
      : artifact
  );
  manifest.verificationReportHash = sha256;
};

/**
 * Rewrites the stored release of `app`'s version 1 as someone with write
 * access to storage could, consistently: every hash recomputed, the
 * manifest's, its artifacts' and the binding's, so only what the change
 * itself breaks can be refused.
 */
export const rewrite = async (
  app: string,
  release: Release,
  change: Rewrite
): Promise<void> => {
  const manifest = jsonRecord(JSON.stringify(release.manifest));
  if (change.contracts !== undefined) {
    const entry = artifactAt(release, ".grasp/contracts.json");
    const stored = await env.FILES.get(await artifactKey(entry.sha256));
    const contracts = jsonRecord((await stored?.text()) ?? "{}");
    change.contracts(contracts);
    const text = `${canonicalJson(contracts)}\n`;
    const bytes = new TextEncoder().encode(text);
    const sha256 = await sha256Hex(text);
    await putArtifact(sha256, bytes);
    manifest.artifacts = release.manifest.artifacts.map((artifact) =>
      artifact.path === entry.path
        ? { path: artifact.path, sha256, bytes: bytes.byteLength }
        : { ...artifact }
    );
    manifest.contractHash = sha256;
  }
  change.manifest?.(manifest);
  await recordEvidence(release, manifest, change);
  change.last?.(manifest);
  const text = change.text?.(manifest) ?? canonicalJson(manifest);
  const hash = await sha256Hex(text);
  await drizzle(env.DB)
    .update(sdkReleaseManifests)
    .set({ manifest: text, manifestHash: hash })
    .where(eq(sdkReleaseManifests.appId, app));
  await drizzle(env.DB)
    .update(sdkResourceBindings)
    .set({ manifestHash: hash })
    .where(eq(sdkResourceBindings.resourceId, app));
};

/** What loading `app`'s version 1 was refused with: its code, and the artifact it names. */
export const refusedLoad = async (app: AppId): Promise<string> => {
  try {
    await loadRelease(env, app, 1);
  } catch (error) {
    const refused = z
      .object({
        code: z.string(),
        details: z.object({ path: z.string() }).partial().optional(),
      })
      .safeParse(error);
    return refused.success
      ? `${refused.data.code} at ${refused.data.details?.path ?? "none"}`
      : String(error);
  }
  return "loaded";
};

/** `record`'s object member `key`, as a mutable record. */
export const member = (record: Record<string, Json>, key: string) =>
  jsonRecord(JSON.stringify(record[key] ?? null));

/** `change` made to `evidence`'s section `key`. */
export const inSection =
  (key: string, change: (section: Record<string, Json>) => void) =>
  (evidence: Record<string, Json>): void => {
    const section = member(evidence, key);
    change(section);
    evidence[key] = section;
  };

export const otherHash = "1".repeat(64);

/** What a seal of `files` was refused with: its code, and the files its diagnostics name. */
export const refusedSeal = async (
  files: TestSource
): Promise<{ code: string; files: string[] }> => {
  const fixture = await appWith(files);
  try {
    await seal(fixture);
    return { code: "ok", files: [] };
  } catch (error) {
    const refusal = z
      .object({
        code: z.string(),
        details: z
          .object({
            diagnostics: z.array(z.object({ file: z.string().nullable() })),
          })
          .optional(),
      })
      .safeParse(error);
    if (!refusal.success) {
      return { code: String(error), files: [] };
    }
    const { code, details } = refusal.data;
    return {
      code,
      files: [
        ...new Set(
          (details?.diagnostics ?? []).map(({ file }) => file ?? "(App)")
        ),
      ].toSorted(),
    };
  }
};

/** An operation file added to the notes, holding `source`. */
export const withOperation = (source: string): TestApp =>
  withFiles(notesFiles(), {
    "server/extra.ts": source,
  });

/**
 * Modules App code never imports: every entry of the platform's runtime,
 * and paths of the SDK that aren't its entries, including the platform
 * entries the SDK had before the runtime held them.
 */
export const platformModules = [
  "@grasp-os/runtime/app",
  "@grasp-os/runtime/server",
  "@grasp-os/runtime/react",
  "@grasp-os/runtime/workflow",
  "@grasp-os/runtime/testing",
  "@grasp-os/runtime/host",
  "@grasp-os/runtime/definition",
  "@grasp-os/runtime/page",
  "@grasp-os/runtime/check",
  "@grasp-os/runtime/forms",
  "@grasp-os/sdk/client",
  "@grasp-os/sdk/host",
  "@grasp-os/sdk/src/index.ts",
  "@grasp-os/sdk/",
  "@grasp-os/runtime",
  "@grasp-os/ui/../runtime/host",
  "@grasp-os/shared/json",
] as const;

/** How a file names a module: for its values, or for its types alone. */
export const importForms = {
  values: (module: string, index: number) =>
    `import { a${index} } from "${module}";\nvoid a${index};`,
  types: (module: string, index: number) =>
    `import type { A${index} } from "${module}";\nexport type B${index} = A${index};`,
  "re-exported types": (module: string, index: number) =>
    `export type { A${index} } from "${module}";`,
  "an import type": (module: string, index: number) =>
    `export type C${index} = typeof import("${module}");`,
  "a type's require": (module: string, index: number) =>
    `import type D${index} = require("${module}");\nexport type E${index} = typeof D${index};`,
} as const;

/** A file that names every platform module as `form` writes one. */
export const namingAll = (
  form: (module: string, index: number) => string
): string =>
  platformModules.map((module, index) => form(module, index)).join("\n");

/** What a build said, whatever it built. */
export const saidSchema = z.object({
  diagnostics: z
    .array(
      z.object({
        file: z.string().optional(),
        rule: z.string(),
        message: z.string(),
        severity: z.string(),
      })
    )
    .default([]),
});

/** What a build said about `file`, as the modules each import it refused named. */
export const refusedIn = (built: object, file: string): string[] =>
  saidSchema
    .parse(built)
    .diagnostics.filter((diagnostic) => diagnostic.file === file)
    .flatMap(({ message }) =>
      platformModules.filter((module) => message.includes(`"${module}"`))
    )
    .toSorted();

/** The errors a build said. */
export const errorsOf = (built: object): string[] =>
  saidSchema
    .parse(built)
    .diagnostics.filter(({ severity }) => severity === "error")
    .map(({ message }) => message);

/** Types a page may name that its values may not: only `{ v }` is the SDK root's. */
export const pageTypes =
  'import type { FunctionReturn } from "@grasp-os/sdk";\nimport type { ReactNode } from "react";\nexport type Shown = FunctionReturn<never> | ReactNode;';

/** Types other App code may name from a module its values may not reach. */
export const codeTypes =
  'import type { Doc } from "@grasp-os/sdk/server";\nexport type Stored = Doc<never>;';

/** Each kind of App file, the build that reads it, and what it holds besides. */
export const targets = {
  "a page": {
    types: pageTypes,
    file: "src/routes/index.tsx",
    wrap: (lines: string) =>
      `${lines}\nimport { createFileRoute } from "@tanstack/react-router";\n\nfunction Notes() {\n  return null;\n}\n\nexport const Route = createFileRoute("/")({ component: Notes });\n`,
    build: async (files: Record<string, string>) =>
      await buildPages(env, files, "app-test"),
  },
  "a component": {
    types: pageTypes,
    file: "src/components/note.tsx",
    others: {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Note } from "../components/note";

function Notes() {
  return <Note />;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
    },
    wrap: (lines: string) =>
      `${lines}\nexport function Note() {\n  return null;\n}\n`,
    build: async (files: Record<string, string>) =>
      await buildPages(env, files, "app-test"),
  },
  "a declaration file": {
    types: pageTypes,
    file: "notes.d.ts",
    // Declarations name modules only for their types.
    typesOnly: true,
    others: {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
    },
    wrap: (lines: string) => `${lines}\nexport type Declared = string;\n`,
    build: async (files: Record<string, string>) =>
      await buildPages(env, files, "app-test"),
  },
  "an operation": {
    types: codeTypes,
    file: "server/extra.ts",
    wrap: (lines: string) => `${lines}\nexport const extra = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildAppCode(env, files, "app-test"),
  },
  "the shared values": {
    types: codeTypes,
    file: "values.ts",
    wrap: (lines: string) => `${lines}\nexport const shared = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildAppCode(env, files, "app-test"),
  },
  "a migration": {
    types: codeTypes,
    file: "server/migrations/0001-extra.ts",
    wrap: (lines: string) => `${lines}\nexport const migration = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildAppCode(env, files, "app-test"),
  },
  "a test": {
    types: codeTypes,
    file: "tests/extra.test.ts",
    wrap: (lines: string) => `${lines}\nexport const test = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildAppTests(env, files, "app-test"),
  },
} as const;

/** A page that imports `Props` by `line` and names it. */
export const pageShowingProps = (line: string): string =>
  `import { createFileRoute } from "@tanstack/react-router";
${line}\nexport type Shown = Props;\nfunction Notes() {\n  return null;\n}\n

export const Route = createFileRoute("/")({ component: Notes });
`;
