import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { setCurrentVersion } from "../src/apps.ts";
import { grantReviewed, racingDb, release, reviewedOf } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// An App's next version and a permission of its that changes things (here,
// to invite guests), for the person whose call it runs in. These
// tests start from the way that can fail: a builder who can't grant the
// permission ships other code under it, and the next version they make
// current acts as the admin who uses it, under a grant that admin gave the
// code before.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** The App's one screen: what a version changes to differ from the last. */
const deskScreen = `export default function Desk() {
  return <main>Desk</main>;
}
`;

/**
 * The collection the Apps read, open to everyone, which an admin creates
 * before each test.
 */
let collectionId = "";

/** A permission for `app` to read the collection under `binding`. */
const collectionFor = (
  app: AppId,
  binding = "NOTES_READ"
): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "collection", collectionId },
  actions: ["read"],
  binding,
});

/** A permission for `app` to invite guests: one that changes things. */
const guestsFor = (app: AppId): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "platform" },
  actions: ["guests"],
  binding: "GUESTS",
});

/** A permission for `app` to list a shared mailbox under `binding`. */
const mailFor = (app: AppId, binding: string): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "connection", connectionId: "connection-shared" },
  actions: ["mail.list"],
  binding,
});

/**
 * An App `builder` released, which `admin` granted guests, and
 * the collection to read.
 */
const builtBy = async (builder: Person, admin: Person): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name: `Map ${unique()}` });
  const app = appIdSchema.parse(id);
  await release(builder, id, { "screens/desk.tsx": deskScreen });
  for (const request of [guestsFor(app), collectionFor(app)]) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
    const { id: permission } = await builder.api.permissions.request(request);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await grantReviewed(admin.api, permission);
  }
  return app;
};

/** `by` releases another version of `app`. */
const changedBy = async (
  by: Pick<Person, "api">,
  app: AppId,
  change: string
): Promise<void> => {
  await release(by, app, {
    "screens/desk.tsx": `${deskScreen}\n// ${change}\n`,
  });
};

/** The detail of each `action` event in `events`, by its target's ID. */
const details = (
  events: Awaited<ReturnType<typeof auditedDuring>>,
  action: string
): Map<string | undefined, Record<string, unknown>> =>
  new Map(
    events
      .filter((event) => event.action === action)
      .map(({ target, detail }) => [target?.id, detail])
  );

/** The App's permissions, as an admin lists them. */
const permissionsOf = async (admin: Person, app: AppId) => {
  const listed = await admin.api.permissions.list({ type: "app", appId: app });
  return listed.map(({ id, binding, status, requestedBy, grantedBy }) => ({
    id,
    binding,
    status,
    requestedBy,
    grantedBy,
  }));
};

describe("An App's next version", { timeout: 60_000 }, () => {
  // After the identity provider's mock is in place (`mockIdp`).
  beforeEach(async () => {
    const admin = await personApi("admin");
    ({ id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Notes ${unique()}`,
      access: "everyone",
    }));
  });

  it("is asked again for its permission to invite guests when a builder makes it current, and keeps reading", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const [write, read] = await permissionsOf(admin, app);

    // The attack: the builder ships other code, which the admin's next
    // call runs, under the grant the admin gave the code before.
    const events = await auditedDuring(async () => {
      await changedBy(builder, app, "Rewrites every rule.");
    });

    expect({
      permissions: await permissionsOf(admin, app),
      audited: events
        .filter(({ action }) => action.startsWith("permission."))
        .map(({ action, actor, target, detail }) => ({
          action,
          actor,
          target,
          detail,
        })),
    }).toStrictEqual({
      // Asked for again, it is the newest request, and still says who
      // granted it before: not a first request.
      permissions: [
        read,
        {
          id: write?.id,
          binding: "GUESTS",
          status: "requested",
          requestedBy: builder.userId,
          grantedBy: admin.userId,
        },
      ],
      audited: [
        {
          action: "permission.requested",
          actor: { type: "person", userId: builder.userId },
          target: { type: "permission", id: write?.id },
          detail: {
            subjectType: "app",
            subjectId: app,
            objectType: "platform",
            actions: "guests",
            binding: "GUESTS",
            version: 2,
            previous: 1,
            grantedBy: admin.userId,
          },
        },
      ],
    });

    // Granted again, by an admin who saw the new code, it holds again.
    await grantReviewed(admin.api, write?.id ?? "");
    const [, granted] = await permissionsOf(admin, app);
    expect(granted?.status).toBe("active");
  });

  it("records each permission it asks for again by the IDs its grant was recorded with", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const subject = { type: "app", appId: app } as const;
    const flow = await builder.api.workflowResources.create(`pay-${unique()}`);
    const requests: PermissionRequest[] = [
      {
        subject,
        object: {
          type: "connection",
          connectionId: "connection-outlook",
          resource: "inbox",
        },
        actions: ["mail.list", "mail.send"],
        binding: "OUTLOOK",
      },
      {
        subject,
        object: { type: "connection", connectionId: "connection-shared" },
        actions: ["mail.list"],
        binding: "SHARED",
      },
      {
        subject,
        object: { type: "workflow", workflowId: flow.id },
        actions: ["start"],
        binding: "PAY",
      },
    ];
    const granted = await auditedDuring(async () => {
      for (const request of requests) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        const { id } = await builder.api.permissions.request(request);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await grantReviewed(admin.api, id);
      }
    });
    const events = await auditedDuring(async () => {
      await changedBy(builder, app, "Uses everything.");
    });
    const requested = details(events, "permission.requested");

    expect({
      count: requested.size,
      asked: [...details(granted, "permission.granted")].map(
        ([id, detail]) => requested.get(id) ?? { missing: id, detail }
      ),
    }).toStrictEqual({
      // With the permission to invite guests.
      count: 4,
      asked: [...details(granted, "permission.granted").values()].map(
        ({ requestedBy: _requestedBy, ...detail }) => ({
          ...detail,
          version: 2,
          previous: 1,
          grantedBy: admin.userId,
        })
      ),
    });
  });

  it("is asked again for a permission an admin grants just before the batch that makes it current", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const late = await builder.api.permissions.request(mailFor(app, "LATE"));
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        "screens/desk.tsx": `${deskScreen}\n// Asks for more.\n`,
      },
      "More"
    );
    // The admin grants the request after everything the change reads, and
    // before its batch lands.
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await grantReviewed(admin.api, late.id);
      }, /^update "apps"/iu),
    };

    const events = await auditedDuring(async () => {
      await setCurrentVersion(racing, await builder.api.whoami(), app, version);
    });
    const listed = await permissionsOf(admin, app);

    expect({
      // Asked for again at the same time: in no particular order.
      permissions: listed
        .map(({ binding, status }) => ({ binding, status }))
        .toSorted((a, b) => a.binding.localeCompare(b.binding)),
      audited: events
        .filter(({ action }) => action === "permission.requested")
        .map(({ actor, detail }) => ({
          actor,
          binding: detail.binding,
          version: detail.version,
          grantedBy: detail.grantedBy,
        }))
        .toSorted((a, b) => String(a.binding).localeCompare(String(b.binding))),
    }).toStrictEqual({
      permissions: [
        { binding: "GUESTS", status: "requested" },
        { binding: "LATE", status: "requested" },
        { binding: "NOTES_READ", status: "active" },
      ],
      audited: ["GUESTS", "LATE"].map((binding) => ({
        actor: { type: "person", userId: builder.userId },
        binding,
        version,
        grantedBy: admin.userId,
      })),
    });
  });

  it("is refused a grant for the version the admin reviewed once a builder made another current", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const more = await builder.api.permissions.request(mailFor(app, "MORE"));
    // The admin reviews version 1; meanwhile the builder swaps the code.
    const reviewed = await reviewedOf(admin.api, more.id);
    await changedBy(builder, app, "Swapped while the admin looked.");

    const refused = await outcome(
      admin.api.permissions.grant(more.id, reviewed)
    );
    const listed = await permissionsOf(admin, app);
    const approved = await env.DB.prepare(
      "SELECT approved FROM app_versions WHERE app_id = ? AND version = 2"
    )
      .bind(app)
      .first("approved");

    expect({
      reviewed,
      refused,
      more: listed.find(({ binding }) => binding === "MORE")?.status,
      approved,
    }).toStrictEqual({
      reviewed: { version: 1 },
      refused: "app.conflict",
      more: "requested",
      approved: 0,
    });
  });

  it("is asked again for the first version of a copy of code no admin approved", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    // A version never made current, marked as a blueprint.
    const { id } = await builder.api.apps.create({ name: `Map ${unique()}` });
    const source = appIdSchema.parse(id);
    const { version } = await builder.api.apps.files.commit(
      source,
      { "screens/desk.tsx": deskScreen },
      "Never run"
    );
    await builder.api.permissions.request(guestsFor(source));
    const blueprint = await builder.api.apps.blueprints.mark(source, version);
    const created = await builder.api.apps.blueprints.create(blueprint.id, {
      name: `Copy ${unique()}`,
    });
    const copy = appIdSchema.parse(created.app.id);
    const [asked] = created.permissions;
    await grantReviewed(admin.api, asked?.id ?? "");

    await builder.api.apps.versions.setCurrent(copy, 1);
    const listed = await permissionsOf(admin, copy);

    expect(listed.map(({ status }) => status)).toStrictEqual(["requested"]);
  });

  it("is asked again for its first version whatever blueprint its creator names", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    // A label anyone creating an App may give: not a copy of anything.
    const { id } = await builder.api.apps.create({
      name: `Map ${unique()}`,
      blueprint: "workflow-map",
    });
    const app = appIdSchema.parse(id);
    const asked = await builder.api.permissions.request(guestsFor(app));
    await grantReviewed(admin.api, asked.id);
    await changedBy(builder, app, "Its own code.");

    const [write] = await permissionsOf(admin, app);
    expect(write?.status).toBe("requested");
  });

  it("asks for nothing again when another request made the same version current first", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const granted = await permissionsOf(admin, app);
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        "screens/desk.tsx": `${deskScreen}\n// Reviewed.\n`,
      },
      "Reviewed"
    );
    // The admin makes it current after the builder's request read the
    // App, and before its batch lands: that batch changes nothing.
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await admin.api.apps.versions.setCurrent(app, version);
      }, /^update "apps"/iu),
    };

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(
        setCurrentVersion(racing, await builder.api.whoami(), app, version)
      );
    });

    expect({
      refused,
      permissions: await permissionsOf(admin, app),
      audited: events.filter(({ action }) => action.startsWith("permission.")),
    }).toStrictEqual({
      refused: "app.conflict",
      permissions: granted,
      audited: [],
    });
  });

  it("is asked again when the admin making it current is no longer one as the change lands", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const { version } = await builder.api.apps.files.commit(
      app,
      {
        "screens/desk.tsx": `${deskScreen}\n// Demoted.\n`,
      },
      "Demoted"
    );
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await env.DB.prepare(
          "UPDATE members SET role = 'builder' WHERE user_id = ?"
        )
          .bind(admin.userId)
          .run();
      }, /^update "apps"/iu),
    };

    // Checked as an admin when the request came in.
    await setCurrentVersion(racing, await admin.api.whoami(), app, version);
    const statuses = await env.DB.prepare(
      "SELECT binding, status FROM permissions WHERE subject_id = ? ORDER BY binding"
    )
      .bind(app)
      .all();
    const approved = await env.DB.prepare(
      "SELECT approved FROM app_versions WHERE app_id = ? AND version = ?"
    )
      .bind(app, version)
      .first("approved");

    expect({ statuses: statuses.results, approved }).toStrictEqual({
      statuses: [
        { binding: "GUESTS", status: "requested" },
        { binding: "NOTES_READ", status: "active" },
      ],
      approved: 0,
    });
  });

  it("keeps its permissions when an admin makes it current, as they could grant them, and not when Grasp staff do", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const granted = await permissionsOf(admin, app);

    const events = await auditedDuring(async () => {
      await changedBy(admin, app, "Reviewed by an admin.");
    });

    expect({
      permissions: await permissionsOf(admin, app),
      audited: events.filter(({ action }) => action.startsWith("permission.")),
    }).toStrictEqual({
      permissions: granted,
      audited: [],
    });

    // Grasp staff are admins, but never decide a client's permissions.
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    await changedBy({ api: core.authenticate() }, app, "Changed by staff.");
    const byStaff = await permissionsOf(admin, app);
    expect(
      byStaff.map(({ binding, status }) => ({ binding, status }))
    ).toStrictEqual([
      { binding: "NOTES_READ", status: "active" },
      { binding: "GUESTS", status: "requested" },
    ]);
  });
});
