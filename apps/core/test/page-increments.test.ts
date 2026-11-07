import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildCachePrefix } from "../src/build-cache.ts";
import { buildPages } from "../src/pages.ts";

// What a pages build reuses of earlier ones (GRA-958, build-cache.ts and
// the compiler's increments.ts): each module's transform, kept as whole
// builds are; the type check reads every file each build. From its
// threat model: a build that reuses what doesn't stand for its files (a
// stale transform, a file whose import changed shape passed), a record
// core didn't keep or one kept under another file's key, a preview's
// transform served to production, and an incremental build that differs
// from one from nothing.

/** Files of this test's own, so nothing else built them: a page and two components. */
const appFiles = (badge = "New", tag = crypto.randomUUID()) => ({
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "../components/badge";
import { Card } from "../components/card";

function Desk() {
  return (
    <main className="flex flex-col gap-2">
      <Card title="${tag}" />
      <Badge />
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Desk });
`,
  // Each of its own: no other test's transforms stand for them.
  "src/components/card.tsx": `// ${tag}
export function Card({ title }: { title: string }) {
  return <h2 className="text-lg">{title}</h2>;
}
`,
  "src/components/badge.tsx": `// ${tag}
export function Badge() {
  return <span className="text-xs">${badge}</span>;
}
`,
});

/** The metrics each pages build logged while `build` ran. */
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
      .map(({ compiled, reused }) => ({ compiled, reused }));
  } finally {
    info.mockRestore();
  }
};

/** Every entry of the cache, by key, with its text. */
const entries = async (): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const listed = await env.FILES.list({ prefix: buildCachePrefix, cursor });
    for (const { key } of listed.objects) {
      // oxlint-disable-next-line no-await-in-loop -- read in turn
      const object = await env.FILES.get(key);
      // oxlint-disable-next-line no-await-in-loop -- read in turn
      found.set(key, (await object?.text()) ?? "");
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return found;
};

/** An entry's text, parsed as an object: none for text that isn't JSON (forged here). */
const fieldsOf = (text: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  return typeof parsed === "object" && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : {};
};

/** Deletes the cache's whole builds (each says whether it is `ok`), or every entry. */
const forget = async (what: "builds" | "all"): Promise<void> => {
  const keys = [...(await entries())]
    .filter(([, text]) => what === "all" || "ok" in fieldsOf(text))
    .map(([key]) => key);
  if (keys.length > 0) {
    await env.FILES.delete(keys);
  }
};

/** A build of `files` from nothing: no whole build, no part of one kept. */
const fromNothing = async (files: Record<string, string>) => {
  await forget("all");
  return await buildPages(env, files, "app-test");
};

/** The key and text of the module record of `path`'s transform, as this test (`tag`) made it. */
const moduleRecordKeys = async (path: string, tag: string) =>
  [...(await entries())]
    .filter(
      ([, text]) =>
        fieldsOf(text).path === path &&
        "code" in fieldsOf(text) &&
        text.includes(tag)
    )
    .map(([key, text]) => ({ key, text }));

describe("a pages build reusing earlier ones", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transforms again only what changed, and builds the same as from nothing", async () => {
    const tag = crypto.randomUUID();
    const files = appFiles("New", tag);
    const first = await metricsOf(
      async () => await buildPages(env, files, "app-test")
    );
    const changed = {
      ...files,
      "src/components/badge.tsx": appFiles("Fresh", tag)[
        "src/components/badge.tsx"
      ],
    };
    let built: unknown;
    const second = await metricsOf(async () => {
      built = await buildPages(env, changed, "app-test");
    });
    const scratch = await fromNothing(changed);

    expect({ first, second, same: built }).toStrictEqual({
      first: [{ compiled: 4, reused: 0 }],
      // The badge again; the page and the card stand.
      second: [{ compiled: 1, reused: 3 }],
      same: scratch,
    });
  });

  it("fails a file whose import changed shape, though its own transform is reused", async () => {
    const files = appFiles();
    await buildPages(env, files, "app-test");
    const broken = await buildPages(
      env,
      {
        ...files,
        "src/components/card.tsx": `export function Card({ title, count }: { title: string; count: number }) {
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
    ).toStrictEqual(["src/routes/index.tsx TS2741"]);
  });

  it("transforms again a module whose kept record core didn't keep, or that another file's key holds", async () => {
    const tag = crypto.randomUUID();
    const files = appFiles("New", tag);
    await buildPages(env, files, "app-test");
    const [desk] = await moduleRecordKeys("src/routes/index.tsx", tag);
    const [card] = await moduleRecordKeys("src/components/card.tsx", tag);
    if (desk === undefined || card === undefined) {
      throw new Error("The build kept no transform of its files");
    }
    // Bytes rewritten under the page's record, its MAC kept.
    const deskEntry = await env.FILES.get(desk.key);
    await env.FILES.put(
      desk.key,
      desk.text.replace(
        /"code":"[^"]*"/u,
        `"code":"export default () => 'forged';"`
      ),
      { customMetadata: deskEntry?.customMetadata }
    );
    // The card's key holding the page's record, with the MAC core kept it with.
    await env.FILES.put(card.key, desk.text, {
      customMetadata: deskEntry?.customMetadata,
    });
    await forget("builds");
    let built: Awaited<ReturnType<typeof buildPages>> | undefined;
    const metrics = await metricsOf(async () => {
      built = await buildPages(env, files, "app-test");
    });

    expect({
      metrics,
      forged: JSON.stringify(built).includes("forged"),
      same: built,
    }).toStrictEqual({
      metrics: [{ compiled: 2, reused: 2 }],
      forged: false,
      same: await fromNothing(files),
    });
  });

  it("keeps a preview's transforms apart from production's", async () => {
    const files = appFiles();
    await buildPages(env, files, "app-test");
    const preview = await metricsOf(
      async () =>
        await buildPages(env, files, "app-test", { profile: "preview" })
    );

    expect(preview).toStrictEqual([
      // Every transform is the preview's own.
      { compiled: 4, reused: 0 },
    ]);
  });

  it("reuses every transform when only a declaration changes, which compiles to nothing", async () => {
    const files = {
      ...appFiles(),
      "types.d.ts": `interface Probe { name: string }
`,
    };
    await buildPages(env, files, "app-test");
    const again = await metricsOf(
      async () =>
        await buildPages(
          env,
          {
            ...files,
            "types.d.ts": "interface Probe { name: string; size: number }\n",
          },
          "app-test"
        )
    );

    expect(again).toStrictEqual([{ compiled: 0, reused: 4 }]);
  });
});
