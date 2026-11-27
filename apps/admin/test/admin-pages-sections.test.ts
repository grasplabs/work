import { exports } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { cloudflare, token, db, liveClient } from "./admin-frame.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { useStoreSecrets } from "./secrets-store.ts";
import { emptyAdminSnapshot } from "./snapshots.ts";

// An organization's pages for a request Access doesn't vouch for. What its
// sections show, its core answering or not, is in
// src/admin/sections.test.tsx.

mockCloudflareApi(token, cloudflare);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

describe("an organization's pages", () => {
  useStoreSecrets({ deployer: token });
  // Only each test's own clients are listed: an earlier test's accounts
  // are gone from the fake, and Home counts every client.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("gives a request Access doesn't vouch for nothing, asking no core", async () => {
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");

    const answers = await Promise.all(
      [
        "/",
        "/platform",
        "/new-organization",
        `/organizations/${acme.clientId}`,
        `/organizations/${acme.clientId}/details?tab=contract`,
      ].map(async (path) => {
        const response = await exports.default.fetch(
          `https://ops.grasp.test${path}`
        );
        return { status: response.status, body: await response.text() };
      })
    );

    expect({
      answers,
      readers: acme.core.adminReaders,
    }).toStrictEqual({
      answers: [403, 403, 403, 403, 403].map((status) => ({
        status,
        body: "Forbidden",
      })),
      readers: [],
    });
  });
});
