import { env } from "cloudflare:workers";
import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import {
  auditEvents,
  clientProvisions,
  clients,
  hostingDestinations,
  releases,
} from "../src/db/schema.ts";
import { placeAndProvisionFn } from "../src/hosting/functions.ts";
import { notStartedWords } from "../src/hosting/words.ts";
import { createClient } from "../src/provision/control.ts";
import type { ProvisionInput } from "../src/provision/control.ts";
import { startClient } from "../src/provision/functions.ts";
import { getProvisioning } from "../src/provision/queries.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, destination, release, staff } from "./hosting.ts";
import { callServerFn } from "./pages.ts";
import { startsOf } from "./runs.ts";

// Adding a client (src/provision/control.ts): staff record it with no
// account of its own, then place it in a hosting destination and
// provision it there from its Setup. How it can fail, each tried below:
// - A client added with an account, or one the account-per-client path
//   then deploys: it would get Workers and resources outside any
//   destination's inventory.
// - Two adds of one id at once both recording it, or recording it twice.
// - A refusal that records anything: an admin without a domain, a sign-in
//   no app can serve, an id that can't be a hostname, an Attio id that
//   isn't one.
// - Anyone but staff adding one: the server function is behind Access.

const token = "test-deployer-token-add-client-5e2b91";
mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** How a new client's people sign in: both IdPs, as a client may have. */
const signIn = {
  domains: ["acme.test"],
  admins: ["ada@acme.test"],
  entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
  googleHostedDomain: "acme.test",
};

/** A new client's input. */
const inputOf = (input: Partial<ProvisionInput> = {}): ProvisionInput => ({
  clientId: `client-${crypto.randomUUID().slice(0, 8)}`,
  name: "Acme",
  ring: 2,
  signIn,
  ...input,
});

const clientRow = async (clientId: string) =>
  await db.select().from(clients).where(eq(clients.id, clientId)).get();

/** The actions audited of client `clientId`, oldest first. */
const actions = async (clientId: string): Promise<string[]> => {
  const rows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.clientId, clientId))
    .orderBy(asc(auditEvents.at), sql`rowid`);
  return rows.map(({ action }) => action);
};

/** What `promise` was refused with, as its code, or `resolved`. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : "thrown";
  }
  return "resolved";
};

/** What `promise` was refused with, as its message, or `resolved`. */
const messageOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : "thrown";
  }
  return "resolved";
};

/** A release imported to provision with, as the real one binds. */
const importedRelease = async (): Promise<string> => {
  const manifest = await release();
  const now = new Date();
  await db.insert(releases).values({
    id: manifest.releaseId,
    commitSha: manifest.commit,
    manifest: JSON.stringify(manifest),
    manifestSha256: "0".repeat(64),
    builtAt: now,
    importedAt: now,
  });
  return manifest.releaseId;
};

describe("adding a client", () => {
  it("starts provisioning by itself as it's added once a destination and a release are there, and says which is missing until then", async () => {
    // First, before any test imports a release.
    using runs = startsOf(adminWorkflows.provisionPlacedClient);
    const add = async () => {
      const input = inputOf();
      await callServerFn(startClient, input, { email: staff.email });
      return input.clientId;
    };
    const setupOf = async (clientId: string) => {
      const view = await getProvisioning(env, clientId);
      const operation = await db
        .select({ releaseId: clientProvisions.releaseId })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, clientId))
        .get();
      return {
        phase: view?.phase,
        notStarted: view?.notStarted,
        operation: operation?.releaseId ?? null,
        audited: await actions(clientId),
      };
    };

    try {
      // Each read as it's added: what keeps it is what's missing now.
      const noDestination = await setupOf(await add());
      await destination();
      const noRelease = await setupOf(await add());
      await importedRelease();
      const releaseId = await importedRelease();
      const started = await setupOf(await add());

      expect({
        noDestination,
        noRelease,
        started: {
          operation: started.operation,
          audited: started.audited.slice(0, 4),
        },
        attempts: runs.started.length,
        words: [
          notStartedWords("no_destination"),
          notStartedWords("no_release"),
        ],
      }).toStrictEqual({
        noDestination: {
          phase: "placing",
          notStarted: "no_destination",
          operation: null,
          audited: ["client.create"],
        },
        noRelease: {
          phase: "placing",
          notStarted: "no_release",
          operation: null,
          audited: ["client.create"],
        },
        // The newest release, in the one destination that meets its policy.
        started: {
          operation: releaseId,
          audited: [
            "client.create",
            "client.place",
            "client.provision_placed",
            "provision.start",
          ],
        },
        attempts: 1,
        words: [
          "Not started: no shared hosting destination yet. The admin records its own as soon as it is read.",
          "Not started: no release imported yet. CI publishes one per merge, and the admin imports it within 5 minutes.",
        ],
      });
    } finally {
      // The tests after choose among their own destinations alone.
      await db.update(hostingDestinations).set({ accountId: null });
    }
  });

  it("records it being provisioned with no account of its own, audited, as staff add it", async () => {
    const companyId = crypto.randomUUID();
    const input = inputOf({ attioCompanyId: companyId.toUpperCase() });

    const result = await callServerFn(startClient, input, {
      email: staff.email,
    });

    const row = await clientRow(input.clientId);
    const recordedSignIn: unknown = JSON.parse(row?.signIn ?? "null");
    expect({
      result,
      row: {
        name: row?.name,
        status: row?.status,
        ring: row?.ring,
        attio: row?.attioCompanyId,
        createdBy: row?.createdBy,
        signIn: recordedSignIn,
      },
      audited: await actions(input.clientId),
    }).toStrictEqual({
      result: { clientId: input.clientId, refused: null },
      row: {
        name: "Acme",
        status: "provisioning",
        ring: 2,
        attio: companyId,
        createdBy: staff.email,
        signIn,
      },
      audited: ["client.create"],
    });
  });

  it("is placed and provisioned from there, in the destination that meets its policy", async () => {
    await destination();
    const releaseId = await importedRelease();
    const input = inputOf();
    await createClient(env, staff, input);
    using runs = startsOf(adminWorkflows.provisionPlacedClient);

    const placed = await callServerFn(
      placeAndProvisionFn,
      {
        clientId: input.clientId,
        releaseId,
        destinationId: null,
      },
      { email: staff.email }
    );

    const attempts = runs.started;
    const operation = await db
      .select({ releaseId: clientProvisions.releaseId })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, input.clientId))
      .get();
    expect({
      refused: placed.refused,
      operation,
      attempts: attempts.length,
    }).toStrictEqual({
      refused: null,
      operation: { releaseId },
      attempts: 1,
    });
  });

  it("records one client however many adds of its id race, and refuses the rest", async () => {
    const input = inputOf();

    const adds = await Promise.all([
      codeOf(createClient(env, staff, input)),
      codeOf(createClient(env, staff, input)),
    ]);

    expect({
      adds: adds.map(String).toSorted((a, b) => a.localeCompare(b)),
      audited: await actions(input.clientId),
      again: await codeOf(createClient(env, staff, input)),
    }).toStrictEqual({
      adds: ["client_exists", "resolved"],
      audited: ["client.create"],
      again: "client_exists",
    });
  });

  it("refuses, recording nothing, an admin without a domain or the sign-in's OAuth app, an id that can't be a hostname, a sign-in no admin can use and an Attio id that isn't one", async () => {
    const input = inputOf();
    const reserved = await messageOf(
      createClient(env, staff, { ...input, clientId: "www" })
    );
    const admins = await messageOf(
      createClient(env, staff, {
        ...input,
        signIn: { ...signIn, admins: ["ada@elsewhere.test"] },
      })
    );

    expect({
      domain: await codeOf(
        createClient({ ...env, CLIENT_DOMAIN: "" }, staff, input)
      ),
      // Its sign-in is through Google too, and the admin has no Google app.
      app: await codeOf(
        createClient({ ...env, GOOGLE_CLIENT_ID: "" }, staff, input)
      ),
      reserved: reserved.includes("a reserved name"),
      admins: admins.includes("ada@elsewhere.test can't sign in"),
      attio: await codeOf(
        createClient(env, staff, {
          ...input,
          attioCompanyId: "Noordkade Finance",
        })
      ),
      row: await clientRow(input.clientId),
      audited: await actions(input.clientId),
    }).toStrictEqual({
      domain: "domain_not_set",
      app: "sign_in_app_missing",
      reserved: true,
      admins: true,
      attio: "thrown",
      row: undefined,
      audited: [],
    });
  });

  it("is refused to anyone Access doesn't vouch for", async () => {
    const input = inputOf();

    await expect(
      callServerFn(startClient, input, { email: null })
    ).rejects.toThrow("The server function answered 403");
    await expect(clientRow(input.clientId)).resolves.toBeUndefined();
  });
});
