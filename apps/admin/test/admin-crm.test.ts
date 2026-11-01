import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { attioLimits } from "../src/crm/attio.ts";
import { setAttioCompanyFn } from "../src/crm/functions.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { attioValue, fakeAttio } from "./attio-fake.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn, page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

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
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name,
    signIn: null,
  });
  account.admin = emptyAdminSnapshot("Noordkade");
  return clientId;
};

/** Links `clientId` to Attio company `recordId` (null unlinks), as staff do under its Details. */
const link = async (clientId: string, recordId: string | null) =>
  await callServerFn(
    setAttioCompanyFn,
    { clientId, recordId },
    { email: staff.email }
  );

/** The page's main part, past the column of sections. */
const mainOf = (html: string): string => html.slice(html.indexOf("<main"));

/** The text of the line under `label`, tags taken out. */
const lineOf = (html: string, label: string): string => {
  const at = html.indexOf(`>${label}</dt>`);
  if (at === -1) {
    return "";
  }
  const start = html.indexOf("<dd", at);
  const end = html.indexOf("</dd>", start);
  return html
    .slice(html.indexOf(">", start) + 1, end)
    .replaceAll(/<[^>]*>/gu, "");
};

const detailsOf = async (clientId: string) => {
  const { html } = await page(`/organizations/${clientId}/details`);
  return { html, main: mainOf(html) };
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

describe("an organization's company in Attio, with Attio's key", () => {
  useStoreSecrets({ deployer: token });
  eachTest({ withKey: true });

  it("shows a linked company, its people and its deals, read only", async () => {
    const clientId = await liveClient();
    const { companyId } = noordkade();

    const linked = await link(clientId, companyId);
    const { html, main } = await detailsOf(clientId);

    expect({
      linked,
      name: lineOf(main, "Name in Attio"),
      domains: lineOf(main, "Domains"),
      categories: lineOf(main, "Categories"),
      employees: lineOf(main, "Employees"),
      opens: main.includes(
        `https://app.attio.com/grasp/company/${companyId}/overview`
      ),
      deal: main.includes("Noordkade Finance: Business"),
      dealLine: main.includes("Won 🎉 · €21,780.00 · owned by Ruben Jansen"),
      people: [
        "Sanne de Wit",
        "COO · sanne@noordkade.test",
        "Pieter de Boer",
      ].map((text) => main.includes(text)),
      stranger: html.includes("someone@elsewhere.test"),
      notConnected: main.includes("Attio isn’t connected"),
      // The key never reaches the page, hydration data included.
      key: html.includes(attioKey),
      writes: attio.writes,
    }).toStrictEqual({
      linked: { changed: true, refused: null },
      name: "Noordkade Finance",
      domains: "noordkade.test",
      categories: "Financial Services and B2B",
      employees: "51-250",
      opens: true,
      deal: true,
      dealLine: true,
      people: [true, true, true],
      stranger: false,
      notConnected: false,
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
    const { main } = await detailsOf(clientId);
    const calls = main.slice(main.indexOf(">Calls</h2>"));
    const kickoff = calls.indexOf("Kickoff with the team leads");
    const first = calls.indexOf("First conversation");

    expect({
      deal: calls.includes(
        "Noordkade Finance: Business · Won 🎉 · Ruben Jansen"
      ),
      newestFirst: kickoff !== -1 && first !== -1 && kickoff < first,
      with: calls.includes("With Sanne de Wit and joost@noordkade.test"),
      grasp: calls.includes("ruben@grasp.test"),
      future: calls.includes("Next week"),
      other: calls.includes("Another company"),
      note: calls.includes("A note, not a call"),
      notConnected: calls.includes("Once Attio is connected"),
    }).toStrictEqual({
      deal: true,
      newestFirst: true,
      with: true,
      grasp: false,
      future: false,
      other: false,
      note: false,
      notConnected: false,
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
    const { main } = await detailsOf(clientId);
    const inCalls = (text: string): boolean =>
      main.includes(text, main.indexOf(">Calls</h2>"));
    expect({
      from: inCalls("from its notes in Attio"),
      note: inCalls("Call with Sanne"),
      other: inCalls("Another company"),
    }).toStrictEqual({ from: true, note: true, other: false });
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
    await detailsOf(clientId);
    expect(
      attio.paths.filter((path) => path.includes("/objects/people/"))
    ).toHaveLength(attioLimits.people);
  });

  it("says when Attio has no such company, and still offers the link", async () => {
    const clientId = await liveClient();
    await link(clientId, crypto.randomUUID());
    const { main } = await detailsOf(clientId);
    expect({
      line: main.includes(
        "Attio can’t be read for it now: Attio has no such company."
      ),
      form: main.includes('name="recordId"'),
    }).toStrictEqual({ line: true, form: true });
  });

  it("refuses a company Attio answers for another id", async () => {
    const clientId = await liveClient();
    const { companyId } = noordkade();
    attio.swapped.set(companyId, crypto.randomUUID());
    await link(clientId, companyId);
    const { main } = await detailsOf(clientId);
    expect({
      line: main.includes("what Attio answered can’t be read"),
      shown: main.includes("Sanne de Wit"),
    }).toStrictEqual({ line: true, shown: false });
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

  it("says Attio isn't connected and asks Attio nothing", async () => {
    const clientId = await liveClient();
    const { companyId } = noordkade();
    await link(clientId, companyId);
    const { main } = await detailsOf(clientId);
    expect({
      line: main.includes(
        "Attio isn’t connected yet. Once it is, this fills in by itself. Add ATTIO_READ_KEY to the stage’s 1Password Environment, then run Deploy platform."
      ),
      requests: attio.requests,
    }).toStrictEqual({ line: true, requests: 0 });
  });
});
