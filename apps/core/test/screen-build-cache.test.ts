import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { cachedFilesManifest, filesManifest } from "../src/app-inspection.ts";
import { quarantineAfter } from "../src/build-cache.ts";
import { buildScreens, screenCode } from "../src/screens.ts";
import { notesFiles } from "./notes-client-app.ts";

// The compiler's builds kept in R2, served again only as the build that
// passed its gates wrote them (build-cache.ts). From its threat model:
// bytes under a key that no build kept (forged, cut short, rotted) served
// as a verified build; one bad object quarantining a key on its own;
// builds of the same files at once each running the compiler; a holder
// that died keeping the key from ever being built.

/** A screen of this test's own, so nothing else built it. */
const screen = (): Record<string, string> => ({
  "screens/desk.tsx": `export default function Desk() {
  return <p>${crypto.randomUUID()}</p>;
}
`,
});

/** A Worker Loader counting the compiler's starts. */
const counting = () => {
  const started = { count: 0 };
  const loader: WorkerLoader = {
    get: (name, code) => {
      started.count += 1;
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

/** A build of fresh files, its cache key and its bytes, as core kept them. */
const keptBuild = async () => {
  const files = screen();
  const built = await buildScreens(env, files, "app-test");
  const text = JSON.stringify(built);
  const sha256 = await sha256Hex(text);
  const row = await env.DB.prepare(
    "SELECT key, object_key AS objectKey FROM build_receipts WHERE sha256 = ?"
  )
    .bind(sha256)
    .first<{ key: string; objectKey: string }>();
  if (row === null) {
    throw new Error("The build has no receipt");
  }
  return { files, built, text, key: row.key, objectKey: row.objectKey };
};

/** A build that passed no gate, as forged bytes would claim. */
const forged = JSON.stringify({
  ok: true,
  modules: { "app~screens~desk.js": "export default () => 'forged';" },
  css: "",
  screens: {},
});

const receiptOf = async (key: string) =>
  await env.DB.prepare(
    "SELECT sha256, object_key AS objectKey, integrity_failures AS failures, quarantined_at AS quarantinedAt FROM build_receipts WHERE key = ?"
  )
    .bind(key)
    .first<{
      sha256: string | null;
      objectKey: string | null;
      failures: number;
      quarantinedAt: number | null;
    }>();

/** Forges the bytes of `key`'s kept build, under the object its receipt names. */
const forgeKept = async (key: string): Promise<void> => {
  const receipt = await receiptOf(key);
  if (receipt?.objectKey === null || receipt?.objectKey === undefined) {
    throw new Error("The build has no object");
  }
  await env.FILES.put(receipt.objectKey, forged);
};

describe("the build cache", { timeout: 120_000 }, () => {
  it("serves no bytes its receipt doesn't vouch for, builds them again, and keeps the bad ones for operators", async () => {
    const { files, built, text, key } = await keptBuild();
    const { started, loader } = counting();

    // Forged under a key with a receipt: a mismatch, counted once.
    await forgeKept(key);
    const afterForgery = await buildScreens(
      { ...env, LOADER: loader },
      files,
      "app-test"
    );
    const counted = await receiptOf(key);
    // Written with no receipt at all: built again, not counted.
    await env.DB.prepare("DELETE FROM build_receipts WHERE key = ?")
      .bind(key)
      .run();
    await env.FILES.put(key, forged);
    const unreceipted = await buildScreens(
      { ...env, LOADER: loader },
      files,
      "app-test"
    );
    const kept = await env.FILES.list({ prefix: `build-quarantine/${key}/` });
    const restored = await receiptOf(key);

    expect({
      afterForgery,
      unreceipted,
      started: started.count,
      counted: {
        failures: counted?.failures,
        quarantined: counted?.quarantinedAt,
      },
      receipt: restored?.sha256,
      kept: kept.objects.length,
      // The good bytes are back, and served from the cache again.
      served: await buildScreens(
        { ...env, LOADER: noBuilds },
        files,
        "app-test"
      ),
    }).toStrictEqual({
      afterForgery: built,
      unreceipted: built,
      started: 2,
      counted: { failures: 1, quarantined: null },
      receipt: await sha256Hex(text),
      kept: 1,
      served: built,
    });
  });

  it("counts one bad build once, however many find it at once", async () => {
    const { files, built, key } = await keptBuild();
    await forgeKept(key);
    const found = await Promise.all(
      ["app-one", "app-two", "app-three"].map(
        async (app) => await buildScreens(env, files, app)
      )
    );
    const receipt = await receiptOf(key);

    expect({
      found: found.every(
        (each) => JSON.stringify(each) === JSON.stringify(built)
      ),
      failures: receipt?.failures,
    }).toStrictEqual({ found: true, failures: 1 });
  });

  it("quarantines a key once its kept builds fail their check repeatedly, and still builds it, never from the cache", async () => {
    const { files, built, key } = await keptBuild();
    for (let round = 0; round < quarantineAfter; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one round after another
      await forgeKept(key);
      // oxlint-disable-next-line no-await-in-loop -- one round after another
      await buildScreens(env, files, "app-test");
    }
    const quarantined = await receiptOf(key);
    const { started, loader } = counting();
    const again = await buildScreens(
      { ...env, LOADER: loader },
      files,
      "app-test"
    );
    const stored = await env.FILES.get(quarantined?.objectKey ?? key);

    expect({
      failures: quarantined?.failures,
      quarantined: quarantined?.quarantinedAt !== null,
      again,
      started: started.count,
      // Nothing is written to the cache for it any more.
      stored: await stored?.text(),
    }).toStrictEqual({
      failures: quarantineAfter,
      quarantined: true,
      again: built,
      started: 1,
      stored: forged,
    });
  });

  it("waits for the build another holds the lease for, and takes over one whose holder died", async () => {
    const { files, built, text, key } = await keptBuild();
    const forget = async () => {
      await env.DB.prepare("DELETE FROM build_receipts WHERE key = ?")
        .bind(key)
        .run();
    };
    // Another isolate holds the lease and keeps its build a moment later.
    await forget();
    await env.DB.prepare(
      "INSERT INTO build_receipts (key, holder, lease_expires_at) VALUES (?, 'elsewhere', ?)"
    )
      .bind(key, Date.now() + 60_000)
      .run();
    const waiting = buildScreens(
      { ...env, LOADER: noBuilds },
      files,
      "app-test"
    );
    await scheduler.wait(600);
    await env.FILES.put(`${key}~elsewhere`, text);
    await env.DB.prepare(
      "UPDATE build_receipts SET object_key = ?, sha256 = ?, built_at = ?, holder = NULL, lease_expires_at = NULL WHERE key = ?"
    )
      .bind(`${key}~elsewhere`, await sha256Hex(text), Date.now(), key)
      .run();
    const shared = await waiting;

    // A holder that died: its lease ran out, so this one builds.
    await forget();
    await env.DB.prepare(
      "INSERT INTO build_receipts (key, holder, lease_expires_at) VALUES (?, 'dead', ?)"
    )
      .bind(key, Date.now() - 1000)
      .run();
    const { started, loader } = counting();
    const takenOver = await buildScreens(
      { ...env, LOADER: loader },
      files,
      "app-test"
    );

    const lease = await env.DB.prepare(
      "SELECT holder FROM build_receipts WHERE key = ?"
    )
      .bind(key)
      .first<{ holder: string | null }>();

    expect({
      shared,
      takenOver,
      started: started.count,
      released: lease?.holder,
    }).toStrictEqual({
      shared: built,
      takenOver: built,
      started: 1,
      released: null,
    });
  });

  it("builds again when a kept build's object can't be read", async () => {
    const { files, built, objectKey } = await keptBuild();
    // Its receipt is there; reading the object it names fails.
    const unreadable: Pick<R2Bucket, "get" | "put"> = {
      get: async (...args: Parameters<R2Bucket["get"]>) => {
        if (args[0] === objectKey) {
          throw new Error("R2 is out");
        }
        return await env.FILES.get(...args);
      },
      put: async (...args: Parameters<R2Bucket["put"]>) =>
        await env.FILES.put(...args),
    };
    const { started, loader } = counting();
    const rebuilt = await buildScreens(
      { ...env, FILES: unreadable, LOADER: loader },
      files,
      "app-test"
    );

    expect({ rebuilt, started: started.count }).toStrictEqual({
      rebuilt: built,
      started: 1,
    });
  });

  it("still builds when R2 can't be read or written, and keeps nothing unreceipted", async () => {
    const files = screen();
    // Every read and write of R2 fails, as in an outage.
    const out: Pick<R2Bucket, "get" | "put"> = {
      get: async (...args: Parameters<R2Bucket["get"]>) => {
        if (args[0].length > 0) {
          throw new Error("R2 is out");
        }
        return await env.FILES.get(...args);
      },
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        if (args[0].length > 0) {
          throw new Error("R2 is out");
        }
        return await env.FILES.put(...args);
      },
    };
    const built = await buildScreens({ ...env, FILES: out }, files, "app-test");
    // Nothing was kept, so the next build compiles again.
    const { started, loader } = counting();
    const again = await buildScreens(
      { ...env, LOADER: loader },
      files,
      "app-test"
    );

    expect({ ok: built.ok, again, started: started.count }).toStrictEqual({
      ok: true,
      again: built,
      started: 1,
    });
  });

  it("compiles once for many views of one App at once, and hands an uncacheable build to them all", async () => {
    const { files, built, key } = await keptBuild();
    // Quarantined: no build of it is kept, so none is shared through R2.
    for (let round = 0; round < quarantineAfter; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one round after another
      await forgeKept(key);
      // oxlint-disable-next-line no-await-in-loop -- one round after another
      await buildScreens(env, files, "app-test");
    }
    const { started, loader } = counting();
    const views = await Promise.all(
      Array.from(
        { length: 10 },
        async () =>
          await buildScreens({ ...env, LOADER: loader }, files, "app-test")
      )
    );

    expect({
      started: started.count,
      all: views.every(
        (view) => JSON.stringify(view) === JSON.stringify(built)
      ),
    }).toStrictEqual({ started: 1, all: true });
  });

  it("builds the same files asked for at once by two Apps once", async () => {
    const files = screen();
    const { started, loader } = counting();
    const both = await Promise.all(
      ["app-one", "app-two"].map(
        async (app) =>
          await buildScreens({ ...env, LOADER: loader }, files, app)
      )
    );

    expect({ same: both[0], started: started.count }).toStrictEqual({
      same: both[1],
      started: 1,
    });
  });

  it("keeps a preview's build apart from production's: neither serves the other, and their artifacts differ", async () => {
    const files = screen();
    const { started, loader } = counting();
    const counted = { ...env, LOADER: loader };

    const production = await buildScreens(counted, files, "app-test");
    // The same files, as a chat's draft builds them: not production's build.
    const preview = await buildScreens(counted, files, "app-test", {
      profile: "preview",
    });
    const compiled = started.count;
    const built = { ...env, LOADER: noBuilds };
    const artifacts = {
      production: await screenCode(
        built,
        files,
        "desk",
        1,
        "app-test",
        "production"
      ),
      preview: await screenCode(
        built,
        files,
        "desk",
        null,
        "app-test",
        "preview"
      ),
    };

    expect({
      compiled,
      // Each served from its own kept build after.
      production: await buildScreens(built, files, "app-test"),
      preview: await buildScreens(built, files, "app-test", {
        profile: "preview",
      }),
      sameCode:
        JSON.stringify(artifacts.production.code) ===
        JSON.stringify(artifacts.preview.code),
      sameArtifact:
        artifacts.production.artifact === artifacts.preview.artifact,
    }).toStrictEqual({
      compiled: 2,
      production,
      preview,
      sameCode: true,
      sameArtifact: false,
    });
  });
});

/** The receipts of inspected manifests, by key, with the object each names. */
const inspectionReceipts = async (): Promise<Map<string, string | null>> => {
  const { results } = await env.DB.prepare(
    "SELECT key, object_key AS objectKey FROM build_receipts WHERE key LIKE 'inspections/%'"
  ).all<{ key: string; objectKey: string | null }>();
  return new Map(results.map(({ key, objectKey }) => [key, objectKey]));
};

/** The Notes App with server code of its own, so nothing else inspected it. */
const ownNotes = (): Record<string, string> => ({
  ...notesFiles,
  "operations/notes.ts": `${notesFiles["operations/notes.ts"] ?? ""}\n// ${crypto.randomUUID()}\n`,
});

/** What `files`' first inspection for `profile` kept: its receipt's key and object. */
const keptInspection = async (
  files: Record<string, string>,
  profile: "preview" | "production"
) => {
  const before = await inspectionReceipts();
  const manifest = await filesManifest(env, files, "app-test", { profile });
  const added = [...(await inspectionReceipts())].filter(
    ([key]) => !before.has(key)
  );
  const [kept] = added;
  if (added.length !== 1 || kept === undefined || kept[1] === null) {
    throw new Error("The inspection kept no one receipt");
  }
  return { manifest, key: kept[0], objectKey: kept[1] };
};

describe("the inspection cache", { timeout: 120_000 }, () => {
  it("reads back no manifest its receipt doesn't vouch for, and inspects again", async () => {
    const files = ownNotes();
    const { manifest, objectKey } = await keptInspection(files, "production");
    const kept = await env.FILES.get(objectKey);
    const text = (await kept?.text()) ?? "";
    // A manifest that reads, naming the App otherwise: forged over the
    // object its receipt names, as anyone who can write R2 could.
    await env.FILES.put(
      objectKey,
      JSON.stringify({ ...JSON.parse(text), name: "Forged" })
    );

    const sidebar = await cachedFilesManifest(env, files);
    const inspectedAgain = await filesManifest(env, files, "app-test");

    expect({
      // The sidebar shows only what core vouches for, so nothing now.
      sidebar,
      name: inspectedAgain.name,
      restored: await cachedFilesManifest(env, files),
    }).toStrictEqual({
      sidebar: undefined,
      name: manifest.name,
      restored: inspectedAgain,
    });
  });

  it("keeps a draft's inspection apart from a version's", async () => {
    const files = ownNotes();
    const preview = await keptInspection(files, "preview");
    // A draft's inspection is no version's: the sidebar has none to show.
    const sidebar = await cachedFilesManifest(env, files);
    const production = await keptInspection(files, "production");

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
