import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { fetchClientAdmin } from "../src/clients/functions.ts";
import { clients } from "../src/db/schema.ts";
import { fetchCreateOptions } from "../src/provision/functions.ts";
import { mockAccess } from "./access.ts";
import {
  cloudflare,
  token,
  db,
  recordClient,
  liveClient,
  staff,
} from "./admin-frame.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { useStoreSecrets } from "./secrets-store.ts";
import { emptyAdminSnapshot } from "./snapshots.ts";

// What opening or adding an organization from the overview reads; the
// overview's counts and filters, which it works out of what the frame
// read, are in src/admin/overview.test.tsx.

mockCloudflareApi(token, cloudflare);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const caller = { email: staff.email };

describe("opening or adding an organization", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("reads an organization the admin knows by its id, even one named like one of the admin's places, and nothing for one it doesn't", async () => {
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");
    // Named like one of the admin's sections, and still its own page.
    const platform = await recordClient("provisioning", "platform");

    const [known, named, unknown] = await Promise.all(
      [acme.clientId, "platform", "client-unknown"].map(
        async (clientId) =>
          await callServerFn(fetchClientAdmin, { clientId }, caller)
      )
    );

    expect({
      known: [known?.client.name, known?.state],
      named: [named?.client.name, named?.state],
      unknown,
    }).toStrictEqual({
      known: [acme.name, "answered"],
      named: [platform.name, "unreachable"],
      unknown: null,
    });
  });

  it("gives the create page the domain every organization's web address ends in", async () => {
    await expect(
      callServerFn(fetchCreateOptions, undefined, caller)
    ).resolves.toStrictEqual({ clientDomain: "grasp.test" });
  });
});
