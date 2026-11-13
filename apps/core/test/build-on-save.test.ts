import type { SavedBuild } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { sealRelease } from "../src/app-releases.ts";
import { appKind } from "../src/apps.ts";
import { buildPages, versionPages } from "../src/pages.ts";
import { rollback } from "../src/publish.ts";
import { buildOnSave, draftLintBuild } from "../src/save-builds.ts";
import { commitApp } from "./apps.ts";
import { holdingBuilds } from "./build-holds.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Saving an App's files builds them at once, so its pages open without
// building, and whoever saved (an agent, most of all) hears what doesn't
// build in the same call. A build never fails the save, and one that
// can't finish is reported as such within a bound.

const idp = mockIdp();

/** A page that says `text`, on the kit. */
const page = (text: string): Record<string, string> => ({
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { Button } from "@grasp-os/ui/components/button";

function Desk() {
  return <Button>${text}</Button>;
}
export const Route = createFileRoute("/")({ component: Desk });
`,
});

/** A Worker Loader that fails the test if anything is built. */
const noBuilds: WorkerLoader = {
  get: () => {
    throw new Error("Built again");
  },
  load: () => {
    throw new Error("Built again");
  },
};

/** Where each problem is, and how bad, as the agent's repair loop reads it. */
const where = (build: SavedBuild): string[] =>
  build.diagnostics.map(
    ({ file, line, rule, severity }) => `${file}:${line} ${rule} ${severity}`
  );

/** A new App of `builder`'s, without versions. */
const newApp = async (
  builder: Awaited<ReturnType<typeof signedInApi>>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Saved" });
  return id;
};

/** `files` built as a save builds them, for a new App's draft. */
const saved = async (files: Readonly<Record<string, string>>, on: Env = env) =>
  await buildOnSave(
    on,
    { app: appIdSchema.parse(crypto.randomUUID()), version: 0, files },
    { profile: "production" }
  );

describe("building on save", { timeout: 60_000 }, () => {
  it("builds what a save holds, so its pages open without building", async () => {
    // Files no other test builds, so nothing is in the cache before.
    const files = page(crypto.randomUUID());
    const unbuilt = { ...env, LOADER: noBuilds };

    const builds = await saved(files);

    expect(builds).toStrictEqual({
      pages: { status: "ok", diagnostics: [] },
    });
    // Opening it loads what the save built.
    await expect(buildPages(unbuilt, files, "app-test")).resolves.toMatchObject(
      { ok: true }
    );
  });

  it("builds a page with an unused import: an unused name is the lint's, never the build's", async () => {
    const builds = await saved({
      "src/routes/index.tsx": `import { Badge } from "@grasp-os/ui/components/badge";
${page(crypto.randomUUID())["src/routes/index.tsx"] ?? ""}`,
    });

    expect(builds.pages).toStrictEqual({ status: "ok", diagnostics: [] });
  });

  it("tells whoever saved what doesn't build and where", async () => {
    const { pages } = await saved({
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router"; function Desk() {
  const count: number = "three";
  return <p>{count}</p>;
}
export const Route = createFileRoute("/")({ component: Desk });
`,
    });
    const [typeError] = pages.diagnostics;

    expect({
      pages: [pages.status, ...where(pages)],
      column: typeError?.column,
      message:
        typeError?.message.includes("not assignable to type 'number'") ?? false,
    }).toStrictEqual({
      pages: ["failed", "src/routes/index.tsx:2 TS2322 error"],
      column: 9,
      message: true,
    });
  });

  it("says a build couldn't run when the compiler can't be reached, and leaves it to its first use", async () => {
    const unreachable: WorkerLoader = {
      get: () => {
        throw new Error("The compiler is unreachable");
      },
      load: () => {
        throw new Error("The compiler is unreachable");
      },
    };
    const warned = vi.spyOn(console, "warn");
    const files = page(crypto.randomUUID());

    const builds = await saved(files, { ...env, LOADER: unreachable });

    expect(builds).toStrictEqual({
      pages: {
        status: "error",
        diagnostics: [],
        error:
          "The build couldn't run now. It runs again when this is first used.",
      },
    });
    // The warning says why, not only what kind of error.
    expect(warned.mock.calls).toContainEqual([
      expect.objectContaining({
        event: "app.save_build_failed",
        kind: "pages",
        errorName: "Error",
        errorMessage: "The compiler is unreachable",
      }),
    ]);
    await expect(buildPages(env, files, "app-test")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("says a build that doesn't finish within its wait couldn't run, rather than wait on", async () => {
    const files = page(crypto.randomUUID());
    const held = Promise.withResolvers<boolean>();
    // The build cache, which answers only once the test lets it: the
    // build waits on its entry before it starts.
    const holding = holdingBuilds(env.FILES, held.promise);

    // The compiler, counting the builds that start it.
    let built = 0;
    const counting: WorkerLoader = {
      get: (...args) => {
        built += 1;
        return env.LOADER.get(...args);
      },
      load: (...args) => {
        built += 1;
        return env.LOADER.load(...args);
      },
    };

    const builds = await buildOnSave(
      { ...env, FILES: holding, BUILD_WAIT_MS: "50" },
      {
        app: appIdSchema.parse(crypto.randomUUID()),
        version: 1,
        files,
      },
      { profile: "production" }
    );
    // Still held: the build that didn't finish has cached nothing, so its
    // first use builds it anew.
    const firstUse = await buildPages(
      { ...env, LOADER: counting },
      files,
      "app-test"
    );
    held.resolve(true);

    expect({ builds, firstUse: firstUse.ok, rebuilt: built > 0 }).toStrictEqual(
      {
        builds: {
          pages: {
            status: "error",
            diagnostics: [],
            error:
              "The build didn't finish in time. It runs again when this is first used.",
          },
        },
        firstUse: true,
        rebuilt: true,
      }
    );
  });

  it("makes a version current without waiting on a page build, however long that takes", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    const by = await builder.api.whoami();
    const { version } = await commitApp(
      builder.api,
      app,
      page(crypto.randomUUID())
    );
    // Its server code, the config and schema of the definition its first
    // version got, sealed first, as a review would.
    await sealRelease(env, { app: appIdSchema.parse(app), version, by });
    const held = Promise.withResolvers<boolean>();
    // Builds answer only once the test lets them: making the version
    // current reads its files and workflows, never a build.
    const holding = holdingBuilds(env.FILES, held.promise);

    // Answers while builds are still held.
    const made = await rollback(
      { ...env, FILES: holding },
      appKind,
      by,
      app,
      version
    );
    held.resolve(true);

    expect(made.version).toBe(version);
  });

  it("answers a page whose build doesn't finish within the build wait as still building, rather than wait on", async () => {
    const files = page(crypto.randomUUID());
    const held = Promise.withResolvers<boolean>();
    const holding = holdingBuilds(env.FILES, held.promise);

    // What an open, a review or a preview builds through.
    const slow = await outcome(
      versionPages(
        { ...env, FILES: holding, BUILD_WAIT_MS: "50" },
        files,
        1,
        "app-test",
        "production"
      )
    );
    held.resolve(true);

    expect(slow).toBe("page.build_slow");
  });
});

describe("a save's diagnostics", { timeout: 60_000 }, () => {
  it.each([
    [
      "limits",
      {
        ...page("desk"),
        // More characters together than a build takes, each file within it.
        ...Object.fromEntries(
          ["a", "b", "c", "d", "e", "f"].map((name) => [
            `src/components/${name}.ts`,
            `// ${"x".repeat(199_000)}\n`,
          ])
        ),
      },
    ],
    [
      "imports",
      {
        "src/routes/index.tsx":
          'import { createFileRoute } from "@tanstack/react-router"; import pad from "left-pad";\n\nfunction Desk() {\n  return <p>{String(pad)}</p>;\n}\nexport const Route = createFileRoute("/")({ component: Desk });\n',
      },
    ],
    [
      "compile",
      {
        "src/routes/index.tsx":
          'import { createFileRoute } from "@tanstack/react-router"; function Desk() {\n  return <p>desk</p\n}\nexport const Route = createFileRoute("/")({ component: Desk });\n',
      },
    ],
    [
      "types",
      {
        "src/routes/index.tsx":
          'import { createFileRoute } from "@tanstack/react-router"; function Desk() {\n  const count: number = "three";\n  return <p>{count}</p>;\n}\nexport const Route = createFileRoute("/")({ component: Desk });\n',
      },
    ],
    [
      "structure",
      {
        "src/components/note.tsx":
          "export function Note() {\n  return <p>note</p>;\n}\n",
      },
    ],
  ] as const)(
    "names a problem's category, %s, in a closed set that holds nothing of the App's",
    async (category, files) => {
      // Built as a save builds them: past what a commit takes, for limits.
      const builds = await buildOnSave(
        env,
        {
          app: appIdSchema.parse(crypto.randomUUID()),
          version: 1,
          files,
        },
        { profile: "production" }
      );
      expect(
        builds.pages.diagnostics
          .filter(({ severity }) => severity === "error")
          .map((diagnostic) => diagnostic.category)
      ).toContain(category);
    }
  );

  it("names the design system's findings by their category in the lint, apart from the code's", async () => {
    const linted = await draftLintBuild(env, {
      app: appIdSchema.parse(crypto.randomUUID()),
      version: 1,
      files: {
        "src/routes/index.tsx":
          'import { createFileRoute } from "@tanstack/react-router"; function Desk() {\n  debugger;\n  return <form>desk</form>;\n}\nexport const Route = createFileRoute("/")({ component: Desk });\n',
      },
    });

    expect(
      linted.diagnostics
        .filter(
          ({ rule }) =>
            rule === "react/forbid-elements" || rule === "no-debugger"
        )
        .map(({ rule, category }) => `${rule} ${category}`)
        .toSorted()
    ).toStrictEqual([
      "no-debugger code",
      "react/forbid-elements design-system",
    ]);
  });
});
