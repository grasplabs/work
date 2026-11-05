import type { SavedBuild } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { commitFiles, setCurrentVersion, versionFiles } from "../src/apps.ts";
import { buildOnSave } from "../src/save-builds.ts";
import { buildScreens, screenCode } from "../src/screens.ts";
import { holdingBuilds } from "./build-holds.ts";
import { mockIdp } from "./idp.ts";
import { notesFiles } from "./notes-client-app.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Saving an App's files builds them at once, so the version opens without
// building, and whoever saved (an agent, most of all) hears what doesn't
// build in the same call. A build never fails the save, and one that
// can't finish is reported as such within a bound. Gone with App
// workflows: a save building an App's own workflows.

const idp = mockIdp();

/** A screen that says `text`, on the kit. */
const screen = (text: string): Record<string, string> => ({
  "screens/desk.tsx": `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return <Button>${text}</Button>;
}
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

describe("building on save", { timeout: 60_000 }, () => {
  it("builds a saved version's screens, so it opens without building", async () => {
    const builder = await signedInApi(idp, "builder");
    // Files no other test builds, so nothing is in the cache before.
    const unique = crypto.randomUUID();
    const app = await newApp(builder);

    const { version, builds } = await builder.api.apps.files.commit(
      app,
      screen(unique),
      "Save"
    );
    const files = await versionFiles(env, appIdSchema.parse(app), version);
    const unbuilt = { ...env, LOADER: noBuilds };

    expect(builds).toStrictEqual({
      screens: { status: "ok", diagnostics: [] },
      workflows: { status: "none", diagnostics: [] },
    });
    // Opening it loads what the save built.
    await expect(
      buildScreens(unbuilt, files, "app-test")
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  it("builds a screen with an unused import: an unused name is the lint's, never the build's", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    const unused = {
      "screens/desk.tsx": `import { Badge } from "@grasp-os/ui/components/badge";
${screen(crypto.randomUUID())["screens/desk.tsx"] ?? ""}`,
    };

    const { builds } = await builder.api.apps.files.commit(
      app,
      unused,
      "Unused"
    );

    expect(builds.screens).toStrictEqual({ status: "ok", diagnostics: [] });
  });

  it("tells whoever saved what doesn't build and where, and commits all the same", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    const broken = {
      "screens/desk.tsx": `export default function Desk() {
  const count: number = "three";
  return <p>{count}</p>;
}
`,
    };

    const committed = await builder.api.apps.files.commit(
      app,
      broken,
      "Broken"
    );

    const { screens, workflows } = committed.builds;

    const [typeError] = screens.diagnostics;

    expect({
      screens: [screens.status, ...where(screens)],
      workflows: workflows.status,
      column: typeError?.column,
      message:
        typeError?.message.includes("not assignable to type 'number'") ?? false,
    }).toStrictEqual({
      screens: ["failed", "screens/desk.tsx:2 TS2322 error"],
      workflows: "none",
      column: 9,
      message: true,
    });
    await expect(
      builder.api.apps.versions.get(app, committed.version)
    ).resolves.toMatchObject({ version: committed.version });
  });

  it("never says screens are ok that were checked without their server code's references, as it doesn't register", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    // Registration throws (never inspected before: no kept manifest).
    const throwing = (notesFiles["app.ts"] ?? "").replace(
      "\nexport default app({",
      `\nif (schema !== undefined) throw new Error("No notes today ${crypto.randomUUID()}");\nexport default app({`
    );

    const { builds } = await builder.api.apps.files.commit(
      app,
      { ...notesFiles, "app.ts": throwing },
      "Notes"
    );

    // Checked for everything else, and nothing else failed, but not ok:
    // whoever reads the status alone isn't told the screens passed.
    expect(builds.screens).toStrictEqual({
      status: "error",
      diagnostics: [],
      error:
        "Checked without the references the server code generates, as it doesn't register yet: fix the server code and save again.",
      standIn: true,
    });
  });

  it("says a build couldn't run when the compiler can't be reached, commits, and leaves it to its first use", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    const by = await builder.api.whoami();
    const unreachable: WorkerLoader = {
      get: () => {
        throw new Error("The compiler is unreachable");
      },
      load: () => {
        throw new Error("The compiler is unreachable");
      },
    };
    const warned = vi.spyOn(console, "warn");

    const committed = await commitFiles(
      { ...env, LOADER: unreachable },
      by,
      app,
      screen(crypto.randomUUID()),
      "Save"
    );

    expect(committed).toMatchObject({
      version: 1,
      builds: {
        screens: {
          status: "error",
          diagnostics: [],
          error:
            "The build couldn't run now. It runs again when this is first used.",
        },
        workflows: { status: "none" },
      },
    });
    // The warning says why, not only what kind of error.
    expect(warned.mock.calls).toContainEqual([
      expect.objectContaining({
        event: "app.save_build_failed",
        kind: "screens",
        errorName: "Error",
        errorMessage: "The compiler is unreachable",
      }),
    ]);
    const files = await versionFiles(env, appIdSchema.parse(app), 1);
    await expect(buildScreens(env, files, "app-test")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("says a build that doesn't finish within its wait couldn't run, rather than wait on", async () => {
    const files = screen(crypto.randomUUID());
    const held = Promise.withResolvers<boolean>();
    // The build cache, which answers only once the test lets it: the
    // build waits on its receipt before it starts.
    const holding = holdingBuilds(env.DB, held.promise);

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
      { ...env, DB: holding, BUILD_WAIT_MS: "50" },
      {
        app: appIdSchema.parse(crypto.randomUUID()),
        version: 1,
        files,
        bindings: {},
      },
      { profile: "production" }
    );
    // Still held: the build that didn't finish has cached nothing, so its
    // first use builds it anew.
    const firstUse = await buildScreens(
      { ...env, LOADER: counting },
      files,
      "app-test"
    );
    held.resolve(true);

    expect({ builds, firstUse: firstUse.ok, rebuilt: built > 0 }).toStrictEqual(
      {
        builds: {
          screens: {
            status: "error",
            diagnostics: [],
            error:
              "The build didn't finish in time. It runs again when this is first used.",
          },
          workflows: { status: "none", diagnostics: [] },
        },
        firstUse: true,
        rebuilt: true,
      }
    );
  });

  it("commits within a build's wait, saying the build didn't finish", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    const by = await builder.api.whoami();
    const held = Promise.withResolvers<boolean>();
    // The build cache answers only once the test lets it: every build
    // waits on its receipt, a second one too.
    const holding = holdingBuilds(env.DB, held.promise);

    // Answers while the cache is still held: a second build would wait on
    // it, and the commit with it, until the test timed out.
    const committed = await commitFiles(
      { ...env, DB: holding, BUILD_WAIT_MS: "50" },
      by,
      app,
      screen(crypto.randomUUID()),
      "Save"
    );
    held.resolve(true);

    expect(committed.builds.screens.status).toBe("error");
  });

  it("makes a version current without waiting on a screen build, however long that takes", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    const by = await builder.api.whoami();
    const { version } = await builder.api.apps.files.commit(
      app,
      screen(crypto.randomUUID()),
      "Save"
    );
    const held = Promise.withResolvers<boolean>();
    // Screen builds answer only once the test lets them: making the
    // version current reads its files and workflows, never a screen build.
    const holding = holdingBuilds(env.DB, held.promise, (key) =>
      key.startsWith("screen-builds/")
    );

    // Answers while screen builds are still held.
    const made = await setCurrentVersion(
      { ...env, DB: holding },
      by,
      app,
      version
    );
    held.resolve(true);

    expect(made.currentVersion).toBe(version);
  });

  it("answers a screen whose build doesn't finish within the build wait as still building, rather than wait on", async () => {
    const files = screen(crypto.randomUUID());
    const held = Promise.withResolvers<boolean>();
    const holding = holdingBuilds(env.DB, held.promise);

    // What an open, a review or a preview builds through.
    const slow = await outcome(
      screenCode(
        { ...env, DB: holding, BUILD_WAIT_MS: "50" },
        files,
        "desk",
        1,
        "app-test",
        "production"
      )
    );
    held.resolve(true);

    expect(slow).toBe("screen.build_slow");
  });
});

describe("a save's diagnostics", { timeout: 60_000 }, () => {
  it.each([
    [
      "limits",
      {
        ...screen("desk"),
        // More characters together than a build takes, each file within it.
        ...Object.fromEntries(
          ["a", "b", "c", "d", "e", "f"].map((name) => [
            `components/${name}.ts`,
            `// ${"x".repeat(199_000)}\n`,
          ])
        ),
      },
    ],
    [
      "imports",
      {
        "screens/desk.tsx":
          'import pad from "left-pad";\n\nexport default function Desk() {\n  return <p>{String(pad)}</p>;\n}\n',
      },
    ],
    [
      "compile",
      {
        "screens/desk.tsx":
          "export default function Desk() {\n  return <p>desk</p\n}\n",
      },
    ],
    [
      "types",
      {
        "screens/desk.tsx":
          'export default function Desk() {\n  const count: number = "three";\n  return <p>{count}</p>;\n}\n',
      },
    ],
    [
      "design-system",
      {
        "screens/desk.tsx":
          'export default function Desk() {\n  return <p className="bg-red-500">desk</p>;\n}\n',
      },
    ],
    [
      "structure",
      {
        "components/note.tsx":
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
          bindings: {},
        },
        { profile: "production" }
      );
      expect(
        builds.screens.diagnostics
          .filter(({ severity }) => severity === "error")
          .map((diagnostic) => diagnostic.category)
      ).toContain(category);
    }
  );
});
