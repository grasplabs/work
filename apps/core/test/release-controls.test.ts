import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import { commitFiles } from "../src/apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { notesFiles } from "./notes-client-app.ts";
import { appWith, failure, seal } from "./sealed-apps.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// An admin's controls over an App's sealed releases over the session's
// `/rpc` (`apps.versions`), from release-controls.ts's threat model:
// revoking a release stops it running, and a legal hold keeps it, so only
// the organization's own admins see or change either, never its builders
// or Grasp staff; and an admin demoted since signing in changes nothing.

const idp = mockIdp();

/** A Notes App with versions 1 and 2, both sealed. */
const sealedTwice = async () => {
  const fixture = await appWith(notesFiles);
  const first = await seal(fixture);
  await commitFiles(
    env,
    fixture.owner,
    fixture.app,
    {
      ...notesFiles,
      "schema.ts": `${notesFiles["schema.ts"] ?? ""}// Again.\n`,
    },
    "Again"
  );
  const second = await seal(fixture, 2);
  return { ...fixture, first, second };
};

const controlActions = new Set([
  "app.release.revoked",
  "app.release.held",
  "app.release.hold_released",
]);

/** An admin's acts on App `app`'s releases the log holds, with their details. */
const loggedAbout = async (app: string) => {
  const logged = await allEvents();
  return logged
    .filter(
      ({ action, target }) => controlActions.has(action) && target?.id === app
    )
    .map(({ action, actor, detail }) => ({
      action,
      actor: actor.type === "person" ? actor.userId : actor.type,
      detail,
    }));
};

describe("an App's releases over /rpc", () => {
  it("are revoked by an admin, with why: the release runs no more, is shown revoked and is audited once", async () => {
    const { app, first, second } = await sealedTwice();
    const admin = await signedInApi(idp, "admin");
    const { versions } = admin.api.apps;

    const revoked = await versions.revoke(app, 2, { reason: "Leaks data" });
    const again = await versions.revoke(app, 2, { reason: "Again" });
    const listed = await versions.releases(app);

    expect({
      revoked: { ...revoked, revokedAt: "" },
      revokedAtIsSet: revoked.revokedAt !== null,
      again,
      listed,
      loads: await failure(async () => await loadRelease(env, app, 2)),
      logged: await loggedAbout(app),
    }).toStrictEqual({
      revoked: {
        app,
        version: 2,
        manifestHash: second.manifestHash,
        sealedAt: revoked.sealedAt,
        revokedAt: "",
        holds: [],
      },
      revokedAtIsSet: true,
      again: revoked,
      listed: [
        revoked,
        {
          app,
          version: 1,
          manifestHash: first.manifestHash,
          sealedAt: listed[1]?.sealedAt,
          revokedAt: null,
          holds: [],
        },
      ],
      loads: "version.revoked",
      logged: [
        {
          action: "app.release.revoked",
          actor: admin.userId,
          detail: {
            version: 2,
            manifestHash: second.manifestHash,
            reason: "Leaks data",
          },
        },
      ],
    });
  });

  it("are held by an admin until the hold is lifted, each audited", async () => {
    const { app, first } = await sealedTwice();
    const admin = await signedInApi(idp, "admin");
    const { versions } = admin.api.apps;

    const held = await versions.placeHold(app, 1, {
      hold: "case-2026-17",
      reason: "Litigation",
    });
    const heldAgain = await versions.placeHold(app, 1, {
      hold: "case-2026-17",
      reason: "Again",
    });
    const lifted = await versions.releaseHold(app, 1, "case-2026-17");

    expect({
      holds: held.holds.map(({ hold }) => hold),
      heldAgain,
      lifted,
      logged: await loggedAbout(app),
    }).toStrictEqual({
      holds: ["case-2026-17"],
      heldAgain: held,
      lifted: { ...held, holds: [] },
      logged: [
        {
          action: "app.release.held",
          actor: admin.userId,
          detail: {
            version: 1,
            hold: "case-2026-17",
            manifestHash: first.manifestHash,
            reason: "Litigation",
          },
        },
        {
          action: "app.release.hold_released",
          actor: admin.userId,
          detail: { version: 1, hold: "case-2026-17" },
        },
      ],
    });
  });

  it("are neither seen, revoked nor held by anyone but the organization's own admins", async () => {
    const fixture = await sealedTwice();
    const { app } = fixture;
    const admin = await signedInApi(idp, "admin");
    await admin.api.apps.versions.placeHold(app, 1, {
      hold: "case-1",
      reason: "Litigation",
    });
    const [builder, user, demoted] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    await env.DB.prepare(
      "UPDATE members SET role = 'builder' WHERE user_id = ?"
    )
      .bind(demoted.userId)
      .run();
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staffSession);
    const staff = core.authenticate();
    const before = await admin.api.apps.versions.releases(app);

    const tries = await Promise.all(
      [builder.api, user.api, demoted.api, staff].map(
        async ({ apps: { versions } }) => ({
          releases: await outcome(versions.releases(app)),
          revoke: await outcome(
            versions.revoke(app, 2, { reason: "Not mine" })
          ),
          hold: await outcome(
            versions.placeHold(app, 2, { hold: "mine", reason: "Mine" })
          ),
          lift: await outcome(versions.releaseHold(app, 1, "case-1")),
        })
      )
    );

    const refused = {
      releases: "role.forbidden",
      revoke: "role.forbidden",
      hold: "role.forbidden",
      lift: "role.forbidden",
    };
    const logged = await loggedAbout(app);
    expect({
      tries,
      after: await admin.api.apps.versions.releases(app),
      logged: logged.map(({ action }) => action),
    }).toStrictEqual({
      tries: [refused, refused, refused, refused],
      after: before,
      logged: ["app.release.held"],
    });
  });

  it("refuse a version never sealed, an App that isn't there, and a revocation or hold without why", async () => {
    const { app } = await sealedTwice();
    const admin = await signedInApi(idp, "admin");
    const { versions } = admin.api.apps;
    const refusals = {
      unsealed: await outcome(versions.revoke(app, 3, { reason: "Gone" })),
      unsealedHold: await outcome(
        versions.placeHold(app, 3, { hold: "case-1", reason: "Litigation" })
      ),
      noApp: await outcome(
        versions.revoke(crypto.randomUUID(), 1, { reason: "Gone" })
      ),
      noReason: await outcome(versions.revoke(app, 1, { reason: "  " })),
      noHoldName: await outcome(
        versions.placeHold(app, 1, { hold: "", reason: "Litigation" })
      ),
      badVersion: await outcome(versions.revoke(app, 0, { reason: "Gone" })),
    };
    const listed = await versions.releases(app);

    expect({
      ...refusals,
      listed: listed.map(({ revokedAt, holds }) => ({ revokedAt, holds })),
    }).toStrictEqual({
      unsealed: "version.not_sealed",
      unsealedHold: "version.not_sealed",
      noApp: "app.not_found",
      noReason: "app.invalid",
      noHoldName: "app.invalid",
      badVersion: "app.invalid",
      listed: [
        { revokedAt: null, holds: [] },
        { revokedAt: null, holds: [] },
      ],
    });
  });
});
