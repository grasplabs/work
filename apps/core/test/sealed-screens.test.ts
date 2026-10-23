import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease, sealedScreen } from "../src/app-releases.ts";
import { appCandidateReports, appCandidates } from "../src/db/core/schema.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { loadFrame } from "./screen-frames.ts";
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
