import { appCompilerName, typeCheckerName } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { cachedFilesManifest, filesManifest } from "../src/app-inspection.ts";
import { buildCachePrefix } from "../src/build-cache.ts";
import { buildPages, versionPages } from "../src/pages.ts";
import { withFiles } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { notesFiles } from "./notes-client-app.ts";

// The toolchain's output kept in R2, served again only as core kept it
// (build-cache.ts). From its threat model: bytes core never kept under a
// key (forged, cut short, rotted, or moved there from another key) served
// as a build; an entry that can't be read failing the build; and views of
// one App's page at once each running the compiler.

/** A page of this test's own, so nothing else built it. */
const page = (): Record<string, string> => ({
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

function Desk() {
  return <p>${crypto.randomUUID()}</p>;
}
export const Route = createFileRoute("/")({ component: Desk });
`,
});

/**
 * A Worker Loader counting the builds that ran, by the isolates they asked
 * for: the compiler's (the shared one and each App's) and the type
 * checker's apart, as a build asks for each once. Counted together, a burst
 * of builds that compiled once but type-checked each time would pass.
 */
const counting = () => {
  const started = { compiler: 0, typeChecker: 0 };
  const loader: WorkerLoader = {
    get: (name, code) => {
      // By prefix: core's Loader names each isolate with its console's
      // owner after it (quietLoader, platform-sandbox.ts).
      if (name?.startsWith(appCompilerName()) === true) {
        started.compiler += 1;
      }
      if (name?.startsWith(typeCheckerName) === true) {
        started.typeChecker += 1;
      }
      return env.LOADER.get(name, code);
    },
    load: (code) => env.LOADER.load(code),
  };
  return { started, loader };
};

/** A Worker Loader that fails the test if anything is built. */
const noBuilds: WorkerLoader = {
  get: () => {
    throw new Error("Built again");
  },
  load: () => {
    throw new Error("Built again");
  },
};

/** The cache's keys now. */
const cacheKeys = async (): Promise<Set<string>> => {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const listed = await env.FILES.list({ prefix: buildCachePrefix, cursor });
    for (const { key } of listed.objects) {
      keys.add(key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
};

/** The entries `run` kept, by key, with their text. */
const keptBy = async (
  run: () => Promise<unknown>
): Promise<Map<string, string>> => {
  const before = await cacheKeys();
  await run();
  const kept = new Map<string, string>();
  for (const key of await cacheKeys()) {
    if (!before.has(key)) {
      // oxlint-disable-next-line no-await-in-loop -- few entries, read in turn
      const object = await env.FILES.get(key);
      // oxlint-disable-next-line no-await-in-loop -- see above
      kept.set(key, (await object?.text()) ?? "");
    }
  }
  return kept;
};

/** A build of fresh files, and the key and text of its kept entry. */
const keptBuild = async () => {
  const files = page();
  let built: unknown;
  const entries = await keptBy(async () => {
    built = await buildPages(env, files, "app-test");
  });
  const text = JSON.stringify(built);
  const [key] = [...entries].find(([, entry]) => entry === text) ?? [];
  if (key === undefined) {
    throw new Error("The build kept no entry");
  }
  return { files, built, text, key };
};

/** A build that passed no gate, as forged bytes would claim. */
const forged = JSON.stringify({
  ok: true,
  modules: { "app~src~routes~index.js": "export default () => 'forged';" },
  css: "",
  pages: {},
});

describe("the build cache", { timeout: 120_000 }, () => {
  it("serves no bytes core didn't keep under their key, and builds them again", async () => {
    const { files, built, key } = await keptBuild();
    const other = await keptBuild();
    const kept = await env.FILES.get(key);
    const { started, loader } = counting();
    const counted = { ...env, LOADER: loader };

    // Forged in place, its MAC kept: it no longer holds.
    await env.FILES.put(key, forged, { customMetadata: kept?.customMetadata });
    const afterForgery = await buildPages(counted, files, "app-test");
    // Forged with no MAC at all.
    await env.FILES.put(key, forged);
    const unsigned = await buildPages(counted, files, "app-test");
    // Another build core kept, moved here with its own MAC.
    const moved = await env.FILES.get(other.key);
    await env.FILES.put(key, other.text, {
      customMetadata: moved?.customMetadata,
    });
    const afterMove = await buildPages(counted, files, "app-test");

    expect({
      afterForgery,
      unsigned,
      afterMove,
      started: { ...started },
      // Made again, it is served from the cache again.
      served: await buildPages({ ...env, LOADER: noBuilds }, files, "app-test"),
    }).toStrictEqual({
      afterForgery: built,
      unsigned: built,
      afterMove: built,
      started: { compiler: 3, typeChecker: 3 },
      served: built,
    });
  });

  it("builds again when a kept entry can't be read", async () => {
    const { files, built, key } = await keptBuild();
    const unreadable: Pick<R2Bucket, "get" | "put"> = {
      get: async (...args: Parameters<R2Bucket["get"]>) => {
        if (args[0] === key) {
          throw new Error("R2 is out");
        }
        return await env.FILES.get(...args);
      },
      put: async (...args: Parameters<R2Bucket["put"]>) =>
        await env.FILES.put(...args),
    };
    const { started, loader } = counting();
    const rebuilt = await buildPages(
      { ...env, FILES: unreadable, LOADER: loader },
      files,
      "app-test"
    );

    expect({ rebuilt, started: { ...started } }).toStrictEqual({
      rebuilt: built,
      started: { compiler: 1, typeChecker: 1 },
    });
  });

  it("still builds when R2 can't be read or written, and keeps nothing", async () => {
    const files = page();
    // Every read and write of R2 fails, as in an outage.
    const out: Pick<R2Bucket, "get" | "put"> = {
      get: async () => await Promise.reject(new Error("R2 is out")),
      put: async () => await Promise.reject(new Error("R2 is out")),
    };
    const built = await buildPages({ ...env, FILES: out }, files, "app-test");
    // Nothing was kept, so the next build compiles again.
    const { started, loader } = counting();
    const again = await buildPages(
      { ...env, LOADER: loader },
      files,
      "app-test"
    );

    expect({ ok: built.ok, again, started: { ...started } }).toStrictEqual({
      ok: true,
      again: built,
      started: { compiler: 1, typeChecker: 1 },
    });
  });

  it("compiles once for many views of one App's page at once", async () => {
    const files = page();
    const { started, loader } = counting();
    const views = await Promise.all(
      Array.from(
        { length: 10 },
        async () =>
          await buildPages({ ...env, LOADER: loader }, files, "app-test")
      )
    );

    expect({
      started: { ...started },
      all: views.every(
        (view) => JSON.stringify(view) === JSON.stringify(views[0])
      ),
    }).toStrictEqual({ started: { compiler: 1, typeChecker: 1 }, all: true });
  });

  it("keeps a preview's build apart from production's: neither serves the other, and their artifacts differ", async () => {
    const files = page();
    const { started, loader } = counting();
    const counted = { ...env, LOADER: loader };

    const production = await buildPages(counted, files, "app-test");
    // The same files, as a chat's draft builds them: not production's build.
    const preview = await buildPages(counted, files, "app-test", {
      profile: "preview",
    });
    const compiled = { ...started };
    const built = { ...env, LOADER: noBuilds };
    const artifacts = {
      production: await versionPages(built, files, 1, "app-test", "production"),
      preview: await versionPages(built, files, null, "app-test", "preview"),
    };

    expect({
      compiled,
      // Each served from its own kept build after.
      production: await buildPages(built, files, "app-test"),
      preview: await buildPages(built, files, "app-test", {
        profile: "preview",
      }),
      sameCode:
        JSON.stringify(artifacts.production.code) ===
        JSON.stringify(artifacts.preview.code),
      sameArtifact:
        artifacts.production.artifact === artifacts.preview.artifact,
    }).toStrictEqual({
      compiled: { compiler: 2, typeChecker: 2 },
      production,
      preview,
      // A preview's page is built for React Fast Refresh on the preview
      // kit (preview-refresh-build.test.ts), so not even its code is
      // production's.
      sameCode: false,
      sameArtifact: false,
    });
  });
});

/** The Notes App with server code of its own, so nothing else inspected it. */
const ownNotes = (): TestApp =>
  withFiles(notesFiles, {
    "server/notes.ts": `${notesFiles.files["server/notes.ts"] ?? ""}\n// ${crypto.randomUUID()}\n`,
  });

/** What `files`' first inspection for `profile` kept: its manifest's entry. */
const keptInspection = async (
  files: Readonly<Record<string, string>>,
  profile: "preview" | "production"
) => {
  let manifest: Awaited<ReturnType<typeof filesManifest>> | undefined;
  const kept = await keptBy(async () => {
    manifest = await filesManifest(env, files, "app-test", { profile });
  });
  // The manifest's entry, among the builds the inspection kept: a build
  // says whether it is `ok`, a manifest doesn't.
  const [key] =
    [...kept].find(([, text]) => {
      const entry: unknown = JSON.parse(text);
      return typeof entry === "object" && entry !== null && !("ok" in entry);
    }) ?? [];
  if (key === undefined || manifest === undefined) {
    throw new Error("The inspection kept no manifest");
  }
  return { manifest, key };
};

describe("the inspection cache", { timeout: 120_000 }, () => {
  it("reads back no manifest core didn't keep, and inspects again", async () => {
    const files = ownNotes();
    const { manifest, key } = await keptInspection(files.files, "production");
    const kept = await env.FILES.get(key);
    const text = (await kept?.text()) ?? "";
    // A manifest that reads, naming the App otherwise: forged over the
    // entry, its MAC kept, as anyone who can write R2 could.
    await env.FILES.put(
      key,
      JSON.stringify({ ...JSON.parse(text), name: "Forged" }),
      { customMetadata: kept?.customMetadata }
    );

    const sidebar = await cachedFilesManifest(env, files.files);
    const inspectedAgain = await filesManifest(env, files.files, "app-test");

    expect({
      // The sidebar shows only what core kept, so nothing now.
      sidebar,
      name: inspectedAgain.name,
      restored: await cachedFilesManifest(env, files.files),
    }).toStrictEqual({
      sidebar: undefined,
      name: manifest.name,
      restored: inspectedAgain,
    });
  });

  it("keeps a draft's inspection apart from a version's", async () => {
    const files = ownNotes();
    const preview = await keptInspection(files.files, "preview");
    // A draft's inspection is no version's: the sidebar has none to show.
    const sidebar = await cachedFilesManifest(env, files.files);
    const production = await keptInspection(files.files, "production");

    expect({
      sidebar,
      sameKey: preview.key === production.key,
      manifest: production.manifest,
    }).toStrictEqual({
      sidebar: undefined,
      sameKey: false,
      manifest: preview.manifest,
    });
  });
});
