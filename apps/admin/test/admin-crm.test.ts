import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { ClientAdmin } from "../src/clients/admin.ts";
import { fetchClientAdmin } from "../src/clients/functions.ts";
import { attioLimits } from "../src/crm/attio.ts";
import type { Crm } from "../src/crm/crm.ts";
import { setAttioCompanyFn } from "../src/crm/functions.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { attioValue, fakeAttio } from "./attio-fake.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";
import { emptyAdminSnapshot } from "./snapshots.ts";

const token = "test-deployer-token-admin-crm-7d2e41";
/** Attio's read-only key; never a real one. */
const attioKey = "attio-read-key-admin-crm-fake-4f1b8c2e";

const cloudflare = mockCloudflareApi(token);
mockAccess();
const attio = fakeAttio(attioKey);

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/**
 * Before each test: only its own clients are read, and with `withKey`,
 * Attio's key is in Secrets Store, as someone at Grasp would put it there
 * (after `useStoreSecrets`, which takes it out after).
 */
const eachTest = ({ withKey }: { withKey: boolean }): void => {
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
    if (withKey) {
      await setStoreSecret(env.ATTIO_READ_KEY, "ATTIO_READ_KEY", attioKey);
    }
  });
};

/** An active client running a new release, whose core answers an empty snapshot. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): crm");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Noordkade ${clientId}`;
  const { core } = await livePlacedClient(cloudflare, release, {
    id: clientId,
    name,
    signIn: null,
  });
  core.admin = emptyAdminSnapshot("Noordkade");
  return clientId;
};

/** Links `clientId` to Attio company `recordId` (null unlinks), as staff do under its Details. */
const link = async (clientId: string, recordId: string | null) =>
  await callServerFn(
    setAttioCompanyFn,
    { clientId, recordId },
    { email: staff.email }
  );

/** Client `clientId` as its organization's page reads it, as the staff member. */
const adminOf = async (clientId: string): Promise<ClientAdmin | null> =>
  await callServerFn(fetchClientAdmin, { clientId }, { email: staff.email });

/** Client `clientId`'s company in Attio, as its page reads it. */
const crmOf = async (clientId: string): Promise<Crm | undefined> => {
  const admin = await adminOf(clientId);
  return admin?.state === "answered" ? admin.crm : undefined;
};

/**
 * Noordkade in Attio: the company, two people on its team and one deal
 * Ruben owns, plus a person at another company that must never show.
 */
const noordkade = () => {
  const companyId = crypto.randomUUID();
  const sanne = crypto.randomUUID();
  const pieter = crypto.randomUUID();
  const stranger = crypto.randomUUID();
  const deal = crypto.randomUUID();
  const ruben = crypto.randomUUID();
  attio.records.companies.set(companyId, {
    name: [attioValue.text("Noordkade Finance")],
    domains: [attioValue.domain("noordkade.test")],
    categories: [
      attioValue.option("Financial Services"),
      attioValue.option("B2B"),
    ],
    employee_range: [attioValue.option("51-250")],
    team: [
      attioValue.reference("people", sanne),
      attioValue.reference("people", pieter),
    ],
    associated_deals: [attioValue.reference("deals", deal)],
  });
  attio.records.people.set(sanne, {
    name: [attioValue.personalName("Sanne", "de Wit")],
    email_addresses: [attioValue.email("sanne@noordkade.test")],
    job_title: [attioValue.text("COO")],
  });
  attio.records.people.set(pieter, {
    name: [attioValue.personalName("Pieter", "de Boer")],
    email_addresses: [],
    job_title: [attioValue.text("Head of Finance")],
  });
  attio.records.people.set(stranger, {
    name: [attioValue.personalName("Someone", "Else")],
    email_addresses: [attioValue.email("someone@elsewhere.test")],
    job_title: [],
  });
  attio.records.deals.set(deal, {
    name: [attioValue.text("Noordkade Finance: Business")],
    stage: [attioValue.status("Won 🎉")],
    value: [attioValue.currency(21_780, "EUR")],
    owner: [attioValue.member(ruben)],
    associated_company: [attioValue.reference("companies", companyId)],
  });
  attio.members.push({ id: ruben, firstName: "Ruben", lastName: "Jansen" });
  return { companyId, dealId: deal };
};

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/** The day `days` ago. */
const dayAgo = (days: number): string => daysAgo(days).slice(0, 10);

describe("an organization's company in Attio, with Attio's key", () => {
  useStoreSecrets({ deployer: token });
  eachTest({ withKey: true });

  it("reads a linked company, its people and its deals, writing nothing, and nothing of anyone else or of the key", async () => {
    const clientId = await liveClient();
    const { companyId } = noordkade();

    const linked = await link(clientId, companyId);
    const admin = await adminOf(clientId);
    const sent = JSON.stringify(admin);

    expect({
      linked,
      crm: admin?.state === "answered" ? admin.crm : undefined,
      stranger: sent.includes("someone@elsewhere.test"),
      key: sent.includes(attioKey),
      writes: attio.writes,
    }).toStrictEqual({
      linked: { changed: true, refused: null },
      crm: {
        state: "read",
        recordId: companyId,
        records: {
          company: {
            name: "Noordkade Finance",
            domains: ["noordkade.test"],
            categories: ["Financial Services", "B2B"],
            employeeRange: "51-250",
            url: `https://app.attio.com/grasp/company/${companyId}/overview`,
          },
          people: [
            { name: "Pieter de Boer", title: "Head of Finance", email: "" },
            {
              name: "Sanne de Wit",
              title: "COO",
              email: "sanne@noordkade.test",
            },
          ],
          deals: [
            {
              name: "Noordkade Finance: Business",
              stage: { title: "Won 🎉", kind: "won" },
              value: { amount: 21_780, currency: "EUR" },
              owner: "Ruben Jansen",
            },
          ],
          calls: { from: "meetings", calls: [] },
        },
      },
      stranger: false,
      key: false,
      writes: 0,
    });
  });

  it("lists the calls with the company from its meetings, the newest first, naming only the company's people in them", async () => {
    const clientId = await liveClient();
    const { companyId } = noordkade();
    attio.meetings.push(
      {
        title: "First conversation",
        start: daysAgo(40),
        participants: ["ruben@grasp.test", "sanne@noordkade.test"],
        companyIds: [companyId],
      },
      {
        title: "Kickoff with the team leads",
        start: daysAgo(10),
        participants: [
          "ruben@grasp.test",
          "Sanne@Noordkade.test",
          "joost@noordkade.test",
        ],
        companyIds: [companyId],
      },
      {
        title: "Next week's check-in",
        start: daysAgo(-7),
        participants: ["sanne@noordkade.test"],
        companyIds: [companyId],
      },
      {
        title: "Another company's call",
        start: daysAgo(3),
        participants: ["someone@elsewhere.test"],
        companyIds: [crypto.randomUUID()],
      }
    );
    attio.notes.push({
      title: "A note, not a call",
      createdAt: daysAgo(5),
      companyId,
    });

    await link(clientId, companyId);
    const crm = await crmOf(clientId);

    expect(crm?.state === "read" ? crm.records.calls : crm).toStrictEqual({
      from: "meetings",
      calls: [
        {
          on: dayAgo(10),
          title: "Kickoff with the team leads",
          with: ["Sanne de Wit", "joost@noordkade.test"],
        },
        { on: dayAgo(40), title: "First conversation", with: ["Sanne de Wit"] },
      ],
    });
  });

  it("lists its notes as the calls when the workspace has no meetings", async () => {
    const clientId = await liveClient();
    const { companyId } = noordkade();
    attio.hasMeetings = false;
    attio.notes.push(
      { title: "Call with Sanne", createdAt: daysAgo(4), companyId },
      {
        title: "Another company's note",
        createdAt: daysAgo(2),
        companyId: crypto.randomUUID(),
      }
    );
    await link(clientId, companyId);
    const crm = await crmOf(clientId);
    expect(crm?.state === "read" ? crm.records.calls : crm).toStrictEqual({
      from: "notes",
      calls: [{ on: dayAgo(4), title: "Call with Sanne", with: [] }],
    });
  });

  it("reads no more than a page's worth of a company's people", async () => {
    const clientId = await liveClient();
    const companyId = crypto.randomUUID();
    const many = Array.from({ length: attioLimits.people + 5 }, () =>
      crypto.randomUUID()
    );
    attio.records.companies.set(companyId, {
      name: [attioValue.text("Big Co")],
      team: many.map((id) => attioValue.reference("people", id)),
    });
    for (const [index, id] of many.entries()) {
      attio.records.people.set(id, {
        name: [attioValue.personalName("Person", `${index}`)],
      });
    }
    await link(clientId, companyId);
    await adminOf(clientId);
    expect(
      attio.paths.filter((path) => path.includes("/objects/people/"))
    ).toHaveLength(attioLimits.people);
  });

  it("reads a company Attio doesn't have as such, keeping the link", async () => {
    const clientId = await liveClient();
    const recordId = crypto.randomUUID();
    await link(clientId, recordId);
    await expect(crmOf(clientId)).resolves.toStrictEqual({
      state: "unread",
      recordId,
      error: "not_found",
    });
  });

  it("refuses a company Attio answers for another id", async () => {
    const clientId = await liveClient();
    const { companyId } = noordkade();
    attio.swapped.set(companyId, crypto.randomUUID());
    await link(clientId, companyId);
    const admin = await adminOf(clientId);
    expect({
      crm: admin?.state === "answered" ? admin.crm : undefined,
      shown: JSON.stringify(admin).includes("Sanne de Wit"),
    }).toStrictEqual({
      crm: { state: "unread", recordId: companyId, error: "invalid_answer" },
      shown: false,
    });
  });

  it("links only by a company's record id, audits each change, and unlinks", async () => {
    const clientId = await liveClient();
    const recordId = crypto.randomUUID();

    const byName = await link(clientId, "Noordkade Finance");
    const linked = await link(clientId, recordId.toUpperCase());
    const again = await link(clientId, recordId);
    const unlinked = await link(clientId, null);
    const unknown = await link("no-such-client", recordId);
    const events = await db
      .select({ actor: auditEvents.actor, target: auditEvents.target })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "client.attio_company")
        )
      )
      .orderBy(auditEvents.at);
    const [row] = await db
      .select({ recordId: clients.attioCompanyId })
      .from(clients)
      .where(eq(clients.id, clientId));

    expect({
      byName,
      linked,
      again,
      unlinked,
      unknown,
      events,
      row,
    }).toStrictEqual({
      byName: { changed: null, refused: "record_id_invalid" },
      linked: { changed: true, refused: null },
      again: { changed: false, refused: null },
      unlinked: { changed: true, refused: null },
      unknown: { changed: null, refused: "unknown_client" },
      events: [
        { actor: staff.email, target: recordId },
        { actor: staff.email, target: null },
      ],
      row: { recordId: null },
    });
  });
});

describe("an organization's company in Attio, without Attio's key", () => {
  useStoreSecrets({ deployer: token });
  eachTest({ withKey: false });

  it("reads Attio as not connected, keeps the company it is linked to, and asks Attio nothing", async () => {
    const clientId = await liveClient();
    const { companyId } = noordkade();
    await link(clientId, companyId);
    expect({
      crm: await crmOf(clientId),
      requests: attio.requests,
    }).toStrictEqual({
      crm: { state: "not_connected", recordId: companyId },
      requests: 0,
    });
  });
});
