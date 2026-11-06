import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { revokeRelease } from "../src/release-retention.ts";
import { mockIdp } from "./idp.ts";
import { notesFiles } from "./notes-client-app.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Navigation between an App's screens (spec 10.7.7), as core decides it
// for the page: the screen a route name names at the App's current
// version, with its input normalized by the route's own schema, only for
// someone who may open it now (a role in the App, and a build whose
// release isn't revoked). Opening a screen with that route and input checks all of
// it again, so an address the page carries can't hand a screen input its
// route refuses. The page's side, which navigates only to what core
// resolved, is the web's screen-bridge tests.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** A note's route input: its ID, and the tab it opens on, by default `view`. */
const routedFiles = (): Record<string, string> => ({
  ...notesFiles,
  "screens.ts": `import { v } from "@grasp-os/sdk";

export default {
  screens: [
    { name: "notes", path: "/", source: "screens/notes.tsx" },
    {
      name: "note",
      path: "/notes/:id",
      source: "screens/note.tsx",
      input: v.object({ id: v.string(), tab: v.enum(["view", "edit"]).default("view") }),
    },
    {
      name: "padded",
      path: "/padded",
      source: "screens/padded.tsx",
      input: v.object({ pad: v.string().default("x".repeat(2100)) }),
    },
  ],
};
`,
  "screens/note.tsx": `import type { ScreenProps } from "@grasp-os/sdk/react";
import type { screens } from "@server/_generated/api";

export default function Note({ input }: ScreenProps<typeof screens.note>) {
  return <p>{input.id} on {input.tab}</p>;
}
`,
  "screens/padded.tsx": `export default function Padded() {
  return <p>Padded</p>;
}
`,
  // A screen no route names: it opens by its file, with no input.
  "screens/extra.tsx": `export default function Extra() {
  return <p>Extra</p>;
}
`,
});

/**
 * A builder's Notes App with routed screens, made current: its screens
 * need nobody's approval.
 */
const routedApp = async () => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(
    id,
    routedFiles(),
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  return { app: id, builder, version };
};

/** The code refusing `person`'s navigation of `app` (`ok` if none). */
const navigated = async (
  person: Person,
  app: string,
  route: string,
  input?: unknown
): Promise<string> =>
  await outcome(person.api.screens.navigate(app, { route, input }));

describe("navigating between an App's screens", () => {
  it("resolves a route name to its screen, with its input normalized, and opens it with that input checked again", async () => {
    const { app, builder } = await routedApp();
    const target = await builder.api.screens.navigate(app, {
      route: "note",
      input: { id: "n1" },
    });
    const opened = await builder.api.screens.open(app, target.screen, {
      route: target.route,
      input: target.input,
    });
    // By file: its route that takes no input, or none at all.
    const list = await builder.api.screens.open(app, "notes");
    const extra = await builder.api.screens.open(app, "extra");
    const toList = await builder.api.screens.navigate(app, { route: "notes" });
    expect({
      target,
      opened: {
        screen: opened.screen,
        route: opened.route,
        input: opened.input,
      },
      list: { route: list.route, input: list.input },
      extra: { route: extra.route, input: extra.input },
      toList,
    }).toStrictEqual({
      target: {
        screen: "note",
        route: "note",
        input: { id: "n1", tab: "view" },
      },
      opened: {
        screen: "note",
        route: "note",
        input: { id: "n1", tab: "view" },
      },
      list: { route: "notes", input: {} },
      extra: { route: null, input: {} },
      toList: { screen: "notes", route: "notes", input: {} },
    });
  });

  it("refuses a route the App doesn't declare, input its schema refuses, and too much input, as navigation and as opening", async () => {
    const { app, builder } = await routedApp();
    const open = async (screen: string, route: string, input?: unknown) =>
      await outcome(builder.api.screens.open(app, screen, { route, input }));
    expect({
      unknownRoute: await navigated(builder, app, "settings"),
      prototypeRoute: await navigated(builder, app, "constructor"),
      notAName: await navigated(builder, app, "../notes"),
      missingId: await navigated(builder, app, "note", {}),
      wrongType: await navigated(builder, app, "note", { id: 7 }),
      extraField: await navigated(builder, app, "note", {
        id: "n1",
        admin: true,
      }),
      notAnEnum: await navigated(builder, app, "note", {
        id: "n1",
        tab: "delete",
      }),
      tooLarge: await navigated(builder, app, "note", { id: "x".repeat(4000) }),
      // Small as sent, too large once its defaults filled it in.
      filledTooLarge: await navigated(builder, app, "padded"),
      // `null` is input, not input left out.
      nullInput: await navigated(builder, app, "notes", null),
      // Opening a screen by a route that isn't its own, with input the
      // route refuses, or by its file when its every route needs input.
      otherFile: await open("notes", "note", { id: "n1" }),
      openMissingId: await open("note", "note", {}),
      openByFile: await outcome(builder.api.screens.open(app, "note")),
    }).toStrictEqual({
      unknownRoute: "screen.not_found",
      prototypeRoute: "screen.not_found",
      notAName: "screen.invalid",
      missingId: "screen.input_invalid",
      wrongType: "screen.input_invalid",
      extraField: "screen.input_invalid",
      notAnEnum: "screen.input_invalid",
      tooLarge: "screen.input_too_large",
      filledTooLarge: "screen.input_too_large",
      nullInput: "screen.input_invalid",
      otherFile: "screen.not_found",
      openMissingId: "screen.input_invalid",
      openByFile: "screen.input_invalid",
    });
  });

  it("takes a target whose input nests as deep as values may, and refuses it by the route's schema, not by its depth", async () => {
    const { app, builder } = await routedApp();
    // An input `valueDepth` levels deep (`{ id }` around the rest), inside
    // the `{ route, input }` target: within the connection's bound
    // (screen-limits.ts).
    let deep: unknown = "leaf";
    for (let level = 1; level < valueDepth - 1; level += 1) {
      deep = [deep];
    }
    expect({
      navigated: await navigated(builder, app, "note", { id: deep }),
      opened: await outcome(
        builder.api.screens.open(app, "note", {
          route: "note",
          input: { id: deep },
        })
      ),
    }).toStrictEqual({
      navigated: "screen.input_invalid",
      opened: "screen.input_invalid",
    });
  });

  it("never hands a screen a key that reaches a prototype: what it gets is what its schema made", async () => {
    const { app, builder } = await routedApp();
    const polluted: unknown = JSON.parse(
      '{"id":"n1","__proto__":{"admin":true}}'
    );
    const target = await builder.api.screens.navigate(app, {
      route: "note",
      input: polluted,
    });
    const { input } = target;
    const fields =
      typeof input === "object" && input !== null ? input : undefined;
    const admin: unknown =
      fields === undefined ? undefined : Reflect.get(fields, "admin");
    expect({
      input,
      own: fields === undefined ? [] : Object.keys(fields),
      admin,
    }).toStrictEqual({
      input: { id: "n1", tab: "view" },
      own: ["id", "tab"],
      admin: undefined,
    });
  });

  it("refuses someone with no access to the App, and navigating once its current release was revoked", async () => {
    const { app, builder, version } = await routedApp();
    const stranger = await personApi("builder");
    const before = await navigated(builder, app, "note", { id: "n1" });
    await revokeRelease(
      env,
      await actingPerson("admin"),
      { app: appIdSchema.parse(app), version },
      "Leaks data"
    );
    expect({
      stranger: await navigated(stranger, app, "note", { id: "n1" }),
      before,
      after: await navigated(builder, app, "note", { id: "n1" }),
    }).toStrictEqual({
      stranger: "app.not_found",
      before: "ok",
      after: "version.revoked",
    });
  });

  it("counts each navigation as one of the person's requests of the App, refused past their budget", async () => {
    const { app, builder } = await routedApp();
    const answers = await Promise.all(
      Array.from(
        { length: 40 },
        async () => await navigated(builder, app, "note", { id: "n1" })
      )
    );
    expect({
      some: answers.includes("ok"),
      refused: answers.includes("screen.rate_limited"),
      nothingElse: answers.every(
        (answer) => answer === "ok" || answer === "screen.rate_limited"
      ),
    }).toStrictEqual({ some: true, refused: true, nothingElse: true });
  });

  it("refuses a sealed release that fails its checks as itself, rather than opening it with no routes", async () => {
    const { app, builder } = await routedApp();
    // The sealed manifest no longer matches its hash.
    await env.DB.prepare(
      "UPDATE sdk_release_manifests SET manifest = manifest || ' ' WHERE app_id = ?"
    )
      .bind(app)
      .run();
    expect({
      navigate: await navigated(builder, app, "note", { id: "n1" }),
      open: await outcome(builder.api.screens.open(app, "notes")),
    }).toStrictEqual({
      navigate: "version.manifest_corrupt",
      open: "version.manifest_corrupt",
    });
  });

  it("fails, rather than routing nothing, when reading the version's routes fails for another reason than the version", async () => {
    const { app, builder } = await routedApp();
    // Core's own store failing under the read: not an answer about the
    // version, so it is never taken for a version without routes.
    await env.DB.exec(
      "ALTER TABLE sdk_release_manifests RENAME TO sdk_release_manifests_away"
    );
    try {
      const failed = {
        navigate: await navigated(builder, app, "note", { id: "n1" }),
        open: await outcome(builder.api.screens.open(app, "notes")),
      };
      expect({
        navigate:
          failed.navigate === "ok" || failed.navigate.startsWith("screen."),
        open: failed.open === "ok" || failed.open.startsWith("screen."),
      }).toStrictEqual({ navigate: false, open: false });
    } finally {
      await env.DB.exec(
        "ALTER TABLE sdk_release_manifests_away RENAME TO sdk_release_manifests"
      );
    }
  });
});
