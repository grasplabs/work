import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { fetchOrganizationTrail } from "../src/admin/trail.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { callServerFn } from "./pages.ts";

// What an organization's Log reads of what Grasp did to it here: its own
// trail alone. What the Log shows of it is in src/admin/records.test.tsx.

mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A client staff added at `at`. */
const added = async (at: Date): Promise<string> => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        status: "active",
        createdAt: at,
        updatedAt: at,
      }),
    ],
    { action: "client.create", clientId }
  );
  return clientId;
};

describe("an organization's records", () => {
  it("reads for its Log that Grasp added it here, and nothing of another organization", async () => {
    const bakery = await added(new Date());
    await added(new Date());

    const trail = await callServerFn(
      fetchOrganizationTrail,
      { clientId: bakery },
      { email: staff.email }
    );

    expect(trail.map(({ what }) => what)).toStrictEqual(["made"]);
  });
});
