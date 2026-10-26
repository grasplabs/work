import { brainErrors } from "@grasp-os/brain/contract";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { requireCopyWithinAudience } from "../src/copy-audience.ts";
import { createCollection } from "../src/knowledge/collection-rules.ts";

// What a workflow run that read the Brain may write into an App's store
// (copy-audience.ts, GRA-1093): its pins reach a table only when everyone
// it is open to may read them. The calls into this check are tested through an agent's App call
// (workflow-app-starts.test.ts); here, a run's pins and each kind of
// table.

/** A member of the organization with `role`. */
const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

/** The code of what `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return brainErrors.codeOf(error) ?? String(error);
  }
};

/** A run whose pins name `collectionId`, if any. */
const runPinning = async (collectionId: string | null) => {
  const runId = crypto.randomUUID();
  if (collectionId !== null) {
    await env.DB.prepare(
      "INSERT INTO run_brain_evidence (run_id, document_id, collection_id, permission_id, recalled, recorded_at) VALUES (?, ?, ?, 'permission', 1, ?)"
    )
      .bind(runId, crypto.randomUUID(), collectionId, Date.now())
      .run();
  }
  return runId;
};

describe("a pinned run's writes into an App's store", () => {
  it("are admitted only for tables every reader of which may read the run's pins", async () => {
    const admin = await person("admin");
    const owner = await person("builder");
    const member = await person("user");
    const app = appIdSchema.parse(crypto.randomUUID());
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, status, created_at) VALUES (?, 'Desk', '', ?, 'published', ?)"
      ).bind(app, owner.userId, Date.now()),
      env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      ).bind(app, member.userId, owner.userId, Date.now()),
    ]);
    const everyone = await createCollection(env, admin, {
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    });
    const owners = await createCollection(env, owner, {
      name: `Owner's ${crypto.randomUUID()}`,
      access: "me",
    });
    const writes = async (
      runId: string,
      mode: "owner" | "appMembers" | "appBuilders" | "none"
    ) =>
      await outcome(
        requireCopyWithinAudience(
          env,
          {
            actor: { type: "system" },
            app,
            writer: { kind: "run", runId },
          },
          owner.userId,
          [mode]
        )
      );
    const open = await runPinning(everyone.id);
    const closed = await runPinning(owners.id);
    const unpinned = await runPinning(null);

    expect({
      openToMembers: await writes(open, "appMembers"),
      closedToMembers: await writes(closed, "appMembers"),
      // The owner's own records, read by them alone.
      closedToOwner: await writes(closed, "owner"),
      // Read by nobody.
      closedToNone: await writes(closed, "none"),
      unpinnedToMembers: await writes(unpinned, "appMembers"),
    }).toStrictEqual({
      openToMembers: "ok",
      closedToMembers: "brain.would_widen",
      closedToOwner: "ok",
      closedToNone: "ok",
      unpinnedToMembers: "ok",
    });
  });
});
