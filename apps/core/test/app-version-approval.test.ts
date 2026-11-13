import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { grantReviewed, release, reviewedOf } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// An App's next version and what an admin granted the App. An approval
// is of access, never of a version: what was granted stays granted
// whichever version runs, and only access the App doesn't have yet waits
// for an admin (permissions.ts). These tests start from the ways that can
// fail: a publish or a roll back taking access away, or asking an admin
// again for what they granted; new access going live with a publish
// unasked; and an admin granting over code they never saw.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** The App's one page: what a version changes to differ from the last. */
const deskPage = `import { createFileRoute } from "@tanstack/react-router";

const Desk = () => <main>Desk</main>;

export const Route = createFileRoute("/")({ component: Desk });
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
  await release(builder, id, { "src/routes/index.tsx": deskPage });
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
    "src/routes/index.tsx": `${deskPage}\n// ${change}\n`,
  });
};

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

  it("keeps every grant when a builder publishes it or rolls back to an older one, asking nothing again", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const granted = await permissionsOf(admin, app);

    const events = await auditedDuring(async () => {
      await changedBy(builder, app, "Another page.");
      await builder.api.versions.rollback({ kind: "app", id: app }, 1);
    });

    expect({
      granted: granted.map(({ status }) => status),
      after: await permissionsOf(admin, app),
      asked: events.filter(({ action }) => action.startsWith("permission.")),
    }).toStrictEqual({
      granted: ["active", "active"],
      after: granted,
      asked: [],
    });
  });

  it("goes live with access the App doesn't have yet still waiting for an admin, whoever publishes it", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const more = await builder.api.permissions.request(mailFor(app, "MORE"));

    await changedBy(builder, app, "Lists the shared mailbox.");
    const waiting = await permissionsOf(admin, app);
    await grantReviewed(admin.api, more.id);

    const granted = await permissionsOf(admin, app);

    expect({
      waiting: waiting.find(({ binding }) => binding === "MORE")?.status,
      granted: granted.find(({ binding }) => binding === "MORE")?.status,
    }).toStrictEqual({ waiting: "requested", granted: "active" });
  });

  it("is refused a grant for the version the admin reviewed once a builder published another", async () => {
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

    expect({
      reviewed,
      refused,
      more: listed.find(({ binding }) => binding === "MORE")?.status,
    }).toStrictEqual({
      reviewed: { version: 1 },
      refused: "app.conflict",
      more: "requested",
    });
  });
});
