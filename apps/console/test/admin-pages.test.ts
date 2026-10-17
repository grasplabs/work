import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { act, consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { emptyAdminSnapshot, mockCloudflareApi } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-frame-3b7e21";
const tenantToken = "test-tenant-admin-token-admin-frame-8d0f54";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A client recorded as `status`, on a new account in the fake. */
const recordClient = async (status: "provisioning" | "active") => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount(`Acme ${clientId}`);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        accountId: account.id,
        status,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return { clientId, name: `Acme ${clientId}`, account };
};

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): the frame" });
  await importReleases(env.RELEASES, db);
  const client = await recordClient("active");
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, client.clientId, release.id)
  );
  return client;
};

/** The text of `html` between the admin's sidebar and the page beside it. */
const sidebarOf = (html: string): string =>
  html.slice(html.indexOf('data-slot="sidebar"'), html.indexOf("<main"));

describe("the admin's frame", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // Only each test's own clients have a core: an earlier test's accounts
  // are gone from the fake.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("gives staff the admin's own sidebar with every organization, one not read now marked as such, and no console bar", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");
    const down = await liveClient();
    down.account.unhealthy = 1000;
    const waiting = await recordClient("provisioning");

    const { status, html } = await page("/admin/platform");
    const sidebar = sidebarOf(html);

    const places = [
      "Overview",
      "Integrations to build",
      "Platform",
      "Ask Grasp",
      "Sources",
      "Stephen Lab",
      "Organizations",
      "Back to the console",
    ].map((text) => sidebar.indexOf(text));
    const [organizations = -1, back = -1] = places.slice(-2);
    /** Where `name` is in the sidebar, and what its entry says besides. */
    const entryOf = (name: string) => {
      const at = sidebar.indexOf(name);
      return {
        // Under the organizations' label and above the way back.
        listed: at > organizations && at < back,
        entry: sidebar.slice(at, sidebar.indexOf("</li>", at)),
      };
    };
    const [acmeEntry, downEntry, waitingEntry] = [acme, down, waiting].map(
      ({ name }) => entryOf(name)
    );

    expect({
      status,
      // Every place, in the prototype's order, the way back last.
      placesInOrder:
        places.every((position) => position >= 0) &&
        places.toSorted((a, b) => a - b).every((at, i) => at === places[i]),
      listed: [acmeEntry, downEntry, waitingEntry].map((each) => each?.listed),
      acmeUnread: acmeEntry?.entry.includes("unreachable"),
      downUnreachable: downEntry?.entry.includes("unreachable"),
      waitingNotDeployed: waitingEntry?.entry.includes("not deployed"),
      opensAcme: html.includes(`href="/admin/${acme.clientId}"`),
      // The console's own bar is not part of the admin.
      consoleBar: html.includes('aria-label="Console"'),
      readers: acme.account.adminReaders,
    }).toStrictEqual({
      status: 200,
      placesInOrder: true,
      listed: [true, true, true],
      acmeUnread: false,
      downUnreachable: true,
      waitingNotDeployed: true,
      opensAcme: true,
      consoleBar: false,
      readers: ["staff@grasp.test"],
    });
  });

  it("opens an organization the console knows, and has no page for one it doesn't", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");

    const known = await page(`/admin/${acme.clientId}`);
    const unknown = await page("/admin/client-unknown");

    expect({
      known: known.status,
      title: known.html.includes(`${acme.name}</h1>`),
      unknown: unknown.status,
    }).toStrictEqual({ known: 200, title: true, unknown: 404 });
  });

  it("gives a request Access doesn't vouch for nothing, asking no core", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");

    const answers = await Promise.all(
      ["/admin", "/admin/platform", `/admin/${acme.clientId}`].map(
        async (path) => {
          const response = await exports.default.fetch(
            `https://console.grasp.test${path}`
          );
          return { status: response.status, body: await response.text() };
        }
      )
    );

    expect({
      answers,
      readers: acme.account.adminReaders,
    }).toStrictEqual({
      answers: [403, 403, 403].map((status) => ({
        status,
        body: "Forbidden",
      })),
      readers: [],
    });
  });
});
