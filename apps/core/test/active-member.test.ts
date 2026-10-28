import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { activeMember, organizationId } from "../src/auth/auth.ts";
import { apps, members } from "../src/db/core/schema.ts";
import { openTo } from "../src/workflows/owners.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// The membership conditions every role check builds on (auth.ts
// `activeMember`, workflows/owners.ts `openTo`), given a column of the very
// table they read: a query on `members` asking which of its own rows are
// active admins, or one on `apps` asking whose owner may open another App.
// Unaliased, the helper's own read would take the caller's column for its
// own row, and the condition would hold for every row once one qualifies.

const idp = mockIdp();

describe(
  "the membership conditions, on a caller's own table",
  { timeout: 60_000 },
  () => {
    it("judge each of a caller's members rows by its own member, never by any other's", async () => {
      const [admin, user, removed] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      // Removed while its membership row still stands, as between a
      // removal's two writes.
      await env.DB.prepare(
        "INSERT INTO member_removals (organization_id, user_id, removed_at) VALUES (?, ?, ?)"
      )
        .bind(organizationId, removed.userId, Date.now())
        .run();
      const rows = await drizzle(env.DB)
        .select({ userId: members.userId })
        .from(members)
        .where(
          and(
            eq(members.organizationId, organizationId),
            inArray(members.userId, [
              admin.userId,
              user.userId,
              removed.userId,
            ]),
            activeMember(members.userId, ["admin"])
          )
        );

      expect(rows.map(({ userId }) => userId)).toStrictEqual([admin.userId]);
    });

    it("judge each of a caller's apps rows by its own owner, never by any other's", async () => {
      const [owner, stranger] = await Promise.all([
        signedInApi(idp, "builder"),
        signedInApi(idp, "builder"),
      ]);
      const { id: mine } = await owner.api.apps.create({ name: "Mine" });
      const { id: theirs } = await stranger.api.apps.create({ name: "Theirs" });
      // Whose owner may open `mine`: its own owner, not the other App's.
      const rows = await drizzle(env.DB)
        .select({ id: apps.id })
        .from(apps)
        .where(
          and(inArray(apps.id, [mine, theirs]), openTo(apps.ownerId, mine))
        );

      expect(rows.map(({ id }) => id)).toStrictEqual([mine]);
    });
  }
);
