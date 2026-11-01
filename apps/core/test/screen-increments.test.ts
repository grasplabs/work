import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { keepUnderLease } from "../src/build-cache.ts";
import { buildScreens } from "../src/screens.ts";

// What a screens build reuses of earlier ones (GRA-958, module-cache.ts
// and the compiler's increments.ts): each module's transform and each
// file's type check, kept as whole builds are. From its threat model: a
// build that reuses what doesn't stand for its files (a stale transform,
// a check of a file whose imports changed shape), a record no receipt
// vouches for or one kept under another file's key, a preview's
// transform served to production, and an incremental build that differs
// from one from nothing.

/** Files of this test's own, so nothing else built them: a screen and two components. */
const appFiles = (badge = "New", tag = crypto.randomUUID()) => ({
  "screens/desk.tsx": `import { Badge } from "../components/badge";
import { Card } from "../components/card";

export default function Desk() {
  return (
    <main className="flex flex-col gap-2">
      <Card title="${tag}" />
      <Badge />
    </main>
  );
}
`,
  // Each of its own: no other test's transforms or checks stand for them.
  "components/card.tsx": `// ${tag}
export function Card({ title }: { title: string }) {
  return <h2 className="text-lg">{title}</h2>;
}
`,
  "components/badge.tsx": `// ${tag}
export function Badge() {
  return <span className="text-xs">${badge}</span>;
}
`,
});

/** The metrics each screens build logged while `build` ran. */
const metricsOf = async (build: () => Promise<unknown>) => {
  const info = vi.spyOn(console, "info");
  try {
    await build();
    return info.mock.calls
      .map(([logged]: unknown[]) => logged)
      .filter(
        (logged): logged is Record<string, unknown> =>
          typeof logged === "object" &&
          logged !== null &&
          "event" in logged &&
          logged.event === "build.compile"
      )
      .map(({ compiled, reused, checked, checksReused }) => ({
        compiled,
        reused,
        checked,
        checksReused,
      }));
  } finally {
    info.mockRestore();
  }
};

/** Deletes every object under `prefix`: what a build kept is gone, its receipts left naming nothing. */
const forgetAll = async (prefix: string): Promise<void> => {
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const listed = await env.FILES.list({ prefix, cursor });
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    await env.FILES.delete(listed.objects.map(({ key }) => key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
};

/** A build of `files` from nothing: no whole build, no part of one kept. */
const fromNothing = async (files: Record<string, string>) => {
  await Promise.all(
    ["screen-builds/", "screen-modules/", "screen-checks/"].map(forgetAll)
  );
  return await buildScreens(env, files, "app-test");
};

/** The receipted key and object of the module record of `path`'s transform, as this test (`tag`) made it. */
const moduleRecordKeys = async (path: string, tag: string) => {
  const rows = await env.DB.prepare(
    "SELECT key, object_key AS objectKey FROM build_receipts WHERE key LIKE 'screen-modules/%' AND object_key IS NOT NULL"
  ).all<{ key: string; objectKey: string }>();
  const found = [];
  for (const row of rows.results) {
    // oxlint-disable-next-line no-await-in-loop -- few rows, read in turn
    const object = await env.FILES.get(row.objectKey);
    // oxlint-disable-next-line no-await-in-loop -- few rows, read in turn
    const text = await object?.text();
    if (text?.includes(`"path":"${path}"`) === true && text.includes(tag)) {
      found.push({ ...row, text });
    }
  }
  return found;
};

describe("a screens build reusing earlier ones", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transforms again only what changed, rechecks what reads it, and builds the same as from nothing", async () => {
    const tag = crypto.randomUUID();
    const files = appFiles("New", tag);
    const first = await metricsOf(
      async () => await buildScreens(env, files, "app-test")
    );
    const changed = {
      ...files,
      "components/badge.tsx": appFiles("Fresh", tag)["components/badge.tsx"],
    };
    let built: unknown;
    const second = await metricsOf(async () => {
      built = await buildScreens(env, changed, "app-test");
    });
    const scratch = await fromNothing(changed);

    expect({ first, second, same: built }).toStrictEqual({
      first: [{ compiled: 3, reused: 0, checked: 3, checksReused: 0 }],
      // The badge again, and the screen that imports it checked again; the
      // card reads neither, so its check stands.
      second: [{ compiled: 1, reused: 2, checked: 2, checksReused: 1 }],
      same: scratch,
    });
  });

  it("checks a file again when a type it imports changed shape, though its own transform is reused", async () => {
    const files = appFiles();
    await buildScreens(env, files, "app-test");
    const broken = await buildScreens(
      env,
      {
        ...files,
        "components/card.tsx": `export function Card({ title, count }: { title: string; count: number }) {
  return <h2 className="text-lg">{title} {count}</h2>;
}
`,
      },
      "app-test"
    );

    expect(
      broken.ok
        ? []
        : broken.diagnostics
            .filter(({ severity }) => severity === "error")
            .map(({ file, rule }) => `${file ?? ""} ${rule}`)
    ).toStrictEqual(["screens/desk.tsx TS2741"]);
  });

  it("transforms again a module whose kept record no receipt vouches for, or that another file's key holds", async () => {
    const tag = crypto.randomUUID();
    const files = appFiles("New", tag);
    await buildScreens(env, files, "app-test");
    const [desk] = await moduleRecordKeys("screens/desk.tsx", tag);
    const [card] = await moduleRecordKeys("components/card.tsx", tag);
    if (desk === undefined || card === undefined) {
      throw new Error("The build kept no transform of its files");
    }
    // Bytes rewritten under the screen's record: its receipt says otherwise.
    await env.FILES.put(
      desk.objectKey,
      desk.text.replace(
        /"code":"[^"]*"/u,
        `"code":"export default () => 'forged';"`
      )
    );
    // The card's key, receipted, holding the screen's record.
    await env.DB.prepare("DELETE FROM build_receipts WHERE key = ?")
      .bind(card.key)
      .run();
    await keepUnderLease(env, card.key, desk.text, 60_000);
    await forgetAll("screen-builds/");
    let built: Awaited<ReturnType<typeof buildScreens>> | undefined;
    const metrics = await metricsOf(async () => {
      built = await buildScreens(env, files, "app-test");
    });

    expect({
      metrics,
      forged: JSON.stringify(built).includes("forged"),
      same: built,
    }).toStrictEqual({
      metrics: [{ compiled: 2, reused: 1, checked: 0, checksReused: 3 }],
      forged: false,
      same: await fromNothing(files),
    });
  });

  it("keeps a preview's transforms apart from production's", async () => {
    const files = appFiles();
    await buildScreens(env, files, "app-test");
    const preview = await metricsOf(
      async () =>
        await buildScreens(env, files, "app-test", { profile: "preview" })
    );

    expect(preview).toStrictEqual([
      // Checks are the same for both; every transform is the preview's own.
      { compiled: 3, reused: 0, checked: 0, checksReused: 3 },
    ]);
  });

  it("checks every file again when a declaration changes, which every file's types may read, and reuses every transform", async () => {
    const files = {
      ...appFiles(),
      "types.d.ts": `interface Probe { name: string }
`,
    };
    await buildScreens(env, files, "app-test");
    const again = await metricsOf(
      async () =>
        await buildScreens(
          env,
          {
            ...files,
            "types.d.ts": "interface Probe { name: string; size: number }\n",
          },
          "app-test"
        )
    );

    expect(again).toStrictEqual([
      { compiled: 0, reused: 3, checked: 4, checksReused: 0 },
    ]);
  });
});
