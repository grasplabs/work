import { describe, expect, it } from "vite-plus/test";

import {
  fetchClientAdmin,
  fetchClientAdmins,
} from "../src/clients/functions.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";
import { fact, interviewingSnapshot, linkCode, said } from "./snapshots.ts";

// What the admin's pages of interviews read: never what anyone said. What
// they show of the rest is in src/admin/interviews.test.tsx.

const token = "test-deployer-token-admin-interviews-5c1a97";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

describe("an organization's interviews", () => {
  useStoreSecrets({ deployer: token });

  it("never gives the browser what anyone said, the facts' words or a link's code, though a core sends them", async () => {
    const release = await placedRelease("feat(core): interviews");
    const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
    const { core } = await livePlacedClient(cloudflare, release, {
      id: clientId,
      name: `Acme ${clientId}`,
      signIn: null,
    });
    core.admin = interviewingSnapshot();
    const caller = { email: "staff@grasp.test" };

    const sent = JSON.stringify([
      await callServerFn(fetchClientAdmin, { clientId }, caller),
      await callServerFn(fetchClientAdmins, undefined, caller),
    ]);

    expect({
      read: sent.includes("Ana"),
      leaked: [said, fact, linkCode].filter((text) => sent.includes(text)),
    }).toStrictEqual({ read: true, leaked: [] });
  });
});
