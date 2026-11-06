import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { artifactKey } from "../src/app-releases.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { mockIdp } from "./idp.ts";
import { notesFiles } from "./notes-client-app.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// An App's surfaces (spec 34.1): where the host places one of the App's
// pages besides its route, as the page's file route exports it
// (`export const surface = { kind, title }`). Core lists them from what
// the version's release sealed, never by building or running its code;
// listing them opens nothing. The page's placement is the web's tests.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** Notes whose list is a sidebar surface, with a settings page of its own. */
const surfacedFiles = (): Record<string, string> => ({
  ...notesFiles,
  "src/routes/index.tsx": `${notesFiles["src/routes/index.tsx"] ?? ""}
export const surface = { kind: "sidebar", title: "All notes" } as const;
`,
  "src/routes/settings.tsx": `import { createFileRoute } from "@tanstack/react-router";

export const surface = { kind: "settings", title: "Preferences" } as const;

function Settings() {
  return <p>Preferences</p>;
}

export const Route = createFileRoute("/settings")({ component: Settings });
`,
});

/** A builder's surfaced Notes, current: its pages need nobody's approval. */
const surfacedApp = async (name = "Notes") => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name });
  const { version } = await builder.api.apps.files.commit(
    id,
    surfacedFiles(),
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  return { app: id, builder, admin, version };
};

describe("an App's surfaces", () => {
  it("are listed for someone with a role in the App, to place them, and the sidebar lists only Apps with sidebar entries", async () => {
    const { app, builder } = await surfacedApp();
    // An App of theirs that declares no surfaces: no sidebar entry.
    const { id: plain } = await builder.api.apps.create({ name: "Plain" });
    const { version } = await builder.api.apps.files.commit(
      plain,
      notesFiles,
      "First"
    );
    await builder.api.apps.versions.setCurrent(plain, version);
    // Another of theirs whose sealed release no longer passes its checks:
    // it drops out of the sidebar, the others' entries stay.
    const { id: broken } = await builder.api.apps.create({ name: "Broken" });
    const second = await builder.api.apps.files.commit(
      broken,
      surfacedFiles(),
      "First"
    );
    await builder.api.apps.versions.setCurrent(broken, second.version);
    await env.DB.prepare(
      "UPDATE sdk_release_manifests SET manifest = manifest || ' ' WHERE app_id = ?"
    )
      .bind(broken)
      .run();
    const surfaces = await builder.api.pages.surfaces(app);
    const sidebar = await builder.api.pages.sidebar();
    const stranger = await personApi("builder");
    const strangerSidebar = await stranger.api.pages.sidebar();
    expect({
      surfaces,
      sidebar: sidebar.filter(
        (entry) =>
          entry.app === app || entry.app === plain || entry.app === broken
      ),
      strangerList: await outcome(stranger.api.pages.surfaces(app)),
      strangerSidebar: strangerSidebar.filter((entry) => entry.app === app),
    }).toStrictEqual({
      surfaces: [
        { path: "/", kind: "sidebar", title: "All notes" },
        { path: "/settings", kind: "settings", title: "Preferences" },
      ],
      sidebar: [
        {
          app,
          name: "Notes",
          entries: [{ path: "/", kind: "sidebar", title: "All notes" }],
        },
      ],
      strangerList: "app.not_found",
      strangerSidebar: [],
    });
  });

  it("count each listing against the person: an App's surfaces as one of their requests of it, the sidebar apart", async () => {
    const { app, builder } = await surfacedApp();
    const listings = await Promise.all(
      Array.from(
        { length: 40 },
        async () => await outcome(builder.api.pages.surfaces(app))
      )
    );
    const sidebars: string[] = [];
    for (let at = 0; at < 15; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one read after another, as a page makes them
      sidebars.push(await outcome(builder.api.pages.sidebar()));
    }
    expect({
      listed: listings.includes("ok"),
      listingsRefused: listings.includes("page.rate_limited"),
      sidebarListed: sidebars[0],
      sidebarRefused: sidebars.at(-1),
    }).toStrictEqual({
      listed: true,
      listingsRefused: true,
      sidebarListed: "ok",
      sidebarRefused: "page.rate_limited",
    });
  });

  it("list in the sidebar an App made current, with nobody approving its pages, and none of a revoked release's", async () => {
    const current = await surfacedApp("Current");
    const revoked = await surfacedApp("Revoked");
    await revokeRelease(
      env,
      await actingPerson("admin"),
      { app: appIdSchema.parse(revoked.app), version: revoked.version },
      "Leaks data"
    );
    const [first] = await current.builder.api.pages.sidebar();
    const theirs = await revoked.builder.api.pages.sidebar();
    expect({
      current: first?.app,
      revoked: theirs.filter(({ app }) => app === revoked.app),
    }).toStrictEqual({ current: current.app, revoked: [] });
  });

  it("leave out of the sidebar an App whose sealed release no longer reads back, and list the others", async () => {
    const { app: readable, builder } = await surfacedApp("Readable");
    const { id: unreadable } = await builder.api.apps.create({
      name: "Unreadable",
    });
    // Surfaces of its own: artifacts are stored by their hash, so the
    // same ones would be the readable App's too.
    const files = surfacedFiles();
    const { version } = await builder.api.apps.files.commit(
      unreadable,
      {
        ...files,
        "src/routes/index.tsx": (files["src/routes/index.tsx"] ?? "").replace(
          "All notes",
          "Every note"
        ),
      },
      "First"
    );
    await builder.api.apps.versions.setCurrent(unreadable, version);
    // Its sealed surfaces no longer read back: one App's, never the
    // listing's, failure.
    const row = await env.DB.prepare(
      "SELECT manifest FROM sdk_release_manifests WHERE app_id = ?"
    )
      .bind(unreadable)
      .first<{ manifest: string }>();
    const { artifacts } = z
      .object({
        artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })),
      })
      .parse(JSON.parse(row?.manifest ?? "{}"));
    const surfaces = artifacts.find(({ path }) => path === "surfaces.json");
    if (surfaces === undefined) {
      throw new Error("The release has its surfaces");
    }
    await env.FILES.put(artifactKey(surfaces.sha256), '[{"kind":"elsewhere"}]');
    const sidebar = await builder.api.pages.sidebar();
    expect(
      Object.fromEntries(
        sidebar
          .filter(({ app }) => app === readable || app === unreadable)
          .map(({ app, entries }) => [app, entries.length])
      )
    ).toStrictEqual({ [readable]: 1 });
  });

  it("list a sealed App's sidebar entries from its manifest alone, its other artifacts not read", async () => {
    const { app, builder } = await surfacedApp();
    // One of its modules no longer matches its hash: loading the whole
    // release would refuse it, listing doesn't read it.
    const row = await env.DB.prepare(
      "SELECT manifest FROM sdk_release_manifests WHERE app_id = ?"
    )
      .bind(app)
      .first<{ manifest: string }>();
    const { artifacts } = z
      .object({
        artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })),
      })
      .parse(JSON.parse(row?.manifest ?? "{}"));
    const module = artifacts.find(({ path }) => path.startsWith("modules/"));
    if (module === undefined) {
      throw new Error("The release has a module");
    }
    await env.FILES.put(artifactKey(module.sha256), "tampered");
    const sidebar = await builder.api.pages.sidebar();
    expect(sidebar.filter((entry) => entry.app === app)).toHaveLength(1);
  });
});
