import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { artifactKey } from "../src/app-releases.ts";
import { mockIdp } from "./idp.ts";
import { notesFiles } from "./notes-client-app.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// An App's surfaces (spec 34.1), as core decides them for the page: where
// the host may place one of the App's screens besides its route, with the
// surface's own input. Core resolves a surface only from the version's own
// manifest, for the screen it is declared for, and checks its input with
// the surface's schema and then the screen's; opening a screen by a
// surface checks it all again. Listing the surfaces opens nothing. The
// page's placement is the web's tests.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * Notes with a list and a note screen, and a surface of each kind: the
 * panel takes only short IDs, narrower than the note's route.
 */
const surfacedFiles = (): Record<string, string> => ({
  ...notesFiles,
  "app.ts": (notesFiles["app.ts"] ?? "")
    .replace(
      'import { app } from "@grasp-os/sdk";',
      'import { app, v } from "@grasp-os/sdk";'
    )
    .replace(
      "  screens: [],",
      `  screens: [
    { name: "notes", path: "/", source: "screens/notes.tsx" },
    {
      name: "note",
      path: "/notes/:id",
      source: "screens/note.tsx",
      input: v.object({ id: v.string(), tab: v.enum(["view", "edit"]).default("view") }),
    },
  ],
  surfaces: [
    { name: "all", kind: "sidebar", screen: "notes", title: "All notes", input: v.object({}) },
    { name: "settings", kind: "settings", screen: "notes", title: "Settings", input: v.object({}) },
    { name: "beside", kind: "panel", screen: "note", title: "Note", input: v.object({ id: v.string().max(8) }) },
    { name: "shared", kind: "deepLink", screen: "note", title: "Shared note", input: v.object({ id: v.string() }) },
  ],`
    ),
  "screens/note.tsx": `import type { ScreenProps } from "@grasp-os/sdk/react";
import type { screens } from "#grasp";

export default function Note({ input }: ScreenProps<typeof screens.note>) {
  return <p>{input.id} on {input.tab}</p>;
}
`,
});

/** A builder's surfaced Notes, current, its screens approved by an admin. */
const surfacedApp = async (name = "Notes", approved = true) => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name });
  const { version } = await builder.api.apps.files.commit(
    id,
    surfacedFiles(),
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  if (approved) {
    const review = await admin.api.screenTrust.review(id);
    await admin.api.screenTrust.approve(id, {
      version: review.version,
      generation: review.generation,
      artifacts: builtArtifacts(review.screens),
    });
  }
  return { app: id, builder, admin };
};

/** The code refusing `person`'s navigation (`ok` if none). */
const navigated = async (
  person: Person,
  app: string,
  navigation: {
    route: string;
    input?: unknown;
    surface?: string;
    deepLink?: true;
  }
): Promise<string> =>
  await outcome(person.api.screens.navigate(app, navigation));

describe("an App's surfaces", () => {
  it("resolve to their screen, with their input checked by the surface and then the screen, and open with it checked again", async () => {
    const { app, builder } = await surfacedApp();
    const target = await builder.api.screens.navigate(app, {
      route: "note",
      input: { id: "n1" },
      surface: "beside",
    });
    const opened = await builder.api.screens.open(app, target.screen, {
      route: target.route,
      input: target.input,
      surface: "beside",
    });
    const sidebar = await builder.api.screens.navigate(app, {
      route: "notes",
      surface: "all",
    });
    expect({
      target,
      opened: { route: opened.route, input: opened.input },
      sidebar,
    }).toStrictEqual({
      // What the page carries: the surface's input, as its schema made it.
      target: {
        screen: "note",
        route: "note",
        input: { id: "n1" },
        surface: { name: "beside", kind: "panel", title: "Note" },
      },
      opened: { route: "note", input: { id: "n1", tab: "view" } },
      sidebar: {
        screen: "notes",
        route: "notes",
        input: {},
        surface: { name: "all", kind: "sidebar", title: "All notes" },
      },
    });
  });

  it("refuse a surface the version doesn't declare for that screen, and input the surface refuses though the screen would take it", async () => {
    const { app, builder } = await surfacedApp();
    const other = await surfacedApp("Other");
    const open = async (surface: string, input: unknown) =>
      await outcome(
        builder.api.screens.open(app, "note", { route: "note", input, surface })
      );
    expect({
      undeclared: await navigated(builder, app, {
        route: "note",
        input: { id: "n1" },
        surface: "panel",
      }),
      anotherScreens: await navigated(builder, app, {
        route: "notes",
        surface: "beside",
      }),
      prototypeKey: await navigated(builder, app, {
        route: "note",
        input: { id: "n1" },
        surface: "constructor",
      }),
      notAName: await navigated(builder, app, {
        route: "note",
        input: { id: "n1" },
        surface: "../beside",
      }),
      // The panel takes IDs of at most 8 characters; the route takes any.
      tooLongForPanel: await navigated(builder, app, {
        route: "note",
        input: { id: "a-long-id" },
        surface: "beside",
      }),
      asRoute: await navigated(builder, app, {
        route: "note",
        input: { id: "a-long-id" },
      }),
      // The surface takes no `tab`: what the screen takes isn't enough.
      fieldOnlyTheScreenTakes: await navigated(builder, app, {
        route: "note",
        input: { id: "n1", tab: "edit" },
        surface: "beside",
      }),
      openTooLong: await open("beside", { id: "a-long-id" }),
      openUndeclared: await open("panel", { id: "n1" }),
      // Another App's builder, naming this App's surface: no role here.
      stranger: await navigated(other.builder, app, {
        route: "note",
        input: { id: "n1" },
        surface: "beside",
      }),
    }).toStrictEqual({
      undeclared: "screen.not_found",
      anotherScreens: "screen.not_found",
      prototypeKey: "screen.not_found",
      notAName: "screen.invalid",
      tooLongForPanel: "screen.input_invalid",
      asRoute: "ok",
      fieldOnlyTheScreenTakes: "screen.input_invalid",
      openTooLong: "screen.input_invalid",
      openUndeclared: "screen.not_found",
      stranger: "app.not_found",
    });
  });

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
    const surfaces = await builder.api.screens.surfaces(app);
    const sidebar = await builder.api.screens.sidebar();
    const stranger = await personApi("builder");
    const strangerSidebar = await stranger.api.screens.sidebar();
    expect({
      surfaces,
      sidebar: sidebar.filter(
        (entry) =>
          entry.app === app || entry.app === plain || entry.app === broken
      ),
      strangerList: await outcome(stranger.api.screens.surfaces(app)),
      strangerSidebar: strangerSidebar.filter((entry) => entry.app === app),
    }).toStrictEqual({
      surfaces: [
        {
          name: "all",
          kind: "sidebar",
          title: "All notes",
          route: "notes",
          screen: "notes",
          opensEmpty: true,
        },
        {
          name: "beside",
          kind: "panel",
          title: "Note",
          route: "note",
          screen: "note",
          opensEmpty: false,
        },
        {
          name: "settings",
          kind: "settings",
          title: "Settings",
          route: "notes",
          screen: "notes",
          opensEmpty: true,
        },
        {
          name: "shared",
          kind: "deepLink",
          title: "Shared note",
          route: "note",
          screen: "note",
          opensEmpty: false,
        },
      ],
      sidebar: [
        {
          app,
          name: "Notes",
          entries: [
            {
              name: "all",
              kind: "sidebar",
              title: "All notes",
              route: "notes",
              screen: "notes",
              opensEmpty: true,
            },
          ],
        },
      ],
      strangerList: "app.not_found",
      strangerSidebar: [],
    });
  });

  it("open from a deep link only a surface the App declares as one", async () => {
    const { app, builder } = await surfacedApp();
    expect({
      deepLink: await navigated(builder, app, {
        route: "note",
        input: { id: "n1" },
        surface: "shared",
        deepLink: true,
      }),
      panel: await navigated(builder, app, {
        route: "note",
        input: { id: "n1" },
        surface: "beside",
        deepLink: true,
      }),
      noSurface: await navigated(builder, app, {
        route: "note",
        input: { id: "n1" },
        deepLink: true,
      }),
      sidebar: await navigated(builder, app, {
        route: "notes",
        surface: "all",
        deepLink: true,
      }),
    }).toStrictEqual({
      deepLink: "ok",
      panel: "screen.not_found",
      noSurface: "screen.not_found",
      sidebar: "screen.not_found",
    });
  });

  it("count each listing against the person: an App's surfaces as one of their requests of it, the sidebar apart", async () => {
    const { app, builder } = await surfacedApp();
    const listings = await Promise.all(
      Array.from(
        { length: 40 },
        async () => await outcome(builder.api.screens.surfaces(app))
      )
    );
    const sidebars: string[] = [];
    for (let at = 0; at < 15; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one read after another, as a page makes them
      sidebars.push(await outcome(builder.api.screens.sidebar()));
    }
    expect({
      listed: listings.includes("ok"),
      listingsRefused: listings.includes("screen.rate_limited"),
      sidebarListed: sidebars[0],
      sidebarRefused: sidebars.at(-1),
    }).toStrictEqual({
      listed: true,
      listingsRefused: true,
      sidebarListed: "ok",
      sidebarRefused: "screen.rate_limited",
    });
  });

  it("list in the sidebar only Apps whose screens would get their data", async () => {
    const approved = await surfacedApp("Approved");
    const unapproved = await surfacedApp("Unapproved", false);
    const [first] = await approved.builder.api.screens.sidebar();
    const theirs = await unapproved.builder.api.screens.sidebar();
    expect({
      approved: first?.app,
      unapproved: theirs.filter(({ app }) => app === unapproved.app),
    }).toStrictEqual({ approved: approved.app, unapproved: [] });
  });

  it("show no sidebar entries for an App whose manifest core would have to work out now", async () => {
    const { app, builder } = await surfacedApp();
    // Not sealed, and its inspection not kept: the sidebar doesn't inspect
    // its code to list it, though listing its surfaces does.
    await env.DB.prepare("DELETE FROM sdk_release_manifests WHERE app_id = ?")
      .bind(app)
      .run();
    const kept = await env.FILES.list({ prefix: "inspections/" });
    await Promise.all(
      kept.objects.map(async ({ key }) => {
        await env.FILES.delete(key);
      })
    );
    const sidebar = await builder.api.screens.sidebar();
    const surfaces = await builder.api.screens.surfaces(app);
    expect({
      sidebar: sidebar.filter((entry) => entry.app === app),
      surfaces: surfaces.map(({ name }) => name),
    }).toStrictEqual({
      sidebar: [],
      surfaces: ["all", "beside", "settings", "shared"],
    });
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
    const sidebar = await builder.api.screens.sidebar();
    expect(sidebar.filter((entry) => entry.app === app)).toHaveLength(1);
  });
});
