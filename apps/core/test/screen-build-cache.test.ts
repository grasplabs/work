import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { quarantineAfter } from "../src/build-cache.ts";
import { buildScreens } from "../src/screens.ts";

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
    "SELECT key FROM build_receipts WHERE sha256 = ?"
  )
    .bind(sha256)
    .first<{ key: string }>();
  if (row === null) {
    throw new Error("The build has no receipt");
  }
  return { files, built, text, key: row.key };
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
    "SELECT sha256, integrity_failures AS failures, quarantined_at AS quarantinedAt FROM build_receipts WHERE key = ?"
  )
    .bind(key)
    .first<{
      sha256: string | null;
      failures: number;
      quarantinedAt: number | null;
    }>();

describe("the build cache", { timeout: 120_000 }, () => {
  it("serves no bytes its receipt doesn't vouch for, builds them again, and keeps the bad ones for operators", async () => {
    const { files, built, text, key } = await keptBuild();
    const { started, loader } = counting();

    // Forged under a key with a receipt: a mismatch, counted once.
    await env.FILES.put(key, forged);
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
    await env.FILES.put(key, forged);
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
      await env.FILES.put(key, forged);
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
    const stored = await env.FILES.get(key);

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
    await env.FILES.put(key, text);
    await env.DB.prepare(
      "UPDATE build_receipts SET sha256 = ?, built_at = ?, holder = NULL, lease_expires_at = NULL WHERE key = ?"
    )
      .bind(await sha256Hex(text), Date.now(), key)
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
});
