import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
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

const token = "test-deployer-token-admin-records-5c2e90";
const tenantToken = "test-tenant-admin-token-admin-records-1f7a3d";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live, added by staff. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): the records" });
  await importReleases(env.RELEASES, db);
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
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, release.id)
  );
  return { clientId, name: `Acme ${clientId}`, account, added: now };
};

/** A person on the roster. */
const person = (id: string, name: string, team: string) => ({
  id,
  name,
  email: `${id}@bakkerij.test`,
  team,
  title: "",
  away: false,
});

/** A link that went out on the first day, as it stands now. */
const link = (
  id: string,
  state: AdminSnapshot["links"][number]["state"],
  deletedAt: string | null = null
): AdminSnapshot["links"][number] => ({
  person: id,
  sentAt: "2026-10-05T07:00:00.000Z",
  openedAt: state === "invited" ? null : "2026-10-05T08:00:00.000Z",
  remindedAt: null,
  deletedAt,
  state,
});

/** An interview started on `day`, agreed to that day or stopped halfway. */
const interview = (
  id: string,
  day: string,
  agreed: boolean
): AdminSnapshot["interviews"][number] => ({
  person: id,
  kind: "own",
  startedAt: `${day}T09:00:00.000Z`,
  completedAt: agreed ? `${day}T09:40:00.000Z` : null,
  updatedAt: `${day}T09:40:00.000Z`,
  agreed,
  phase: agreed ? "readback" : "steps",
  stoppedAt: agreed ? null : "steps",
  minutes: 40,
  facts: 8,
  out: 0,
  confirmed: agreed ? 8 : 0,
  rating: null,
  typed: false,
  interviewer: "stephen",
});

/**
 * A bakery ten days into its interviews: Sales, five people, of whom two
 * agreed to their interview (one on the second day, past the days to ask
 * for a deletion, one on the ninth, still within them), one stopped
 * halfway and one had theirs deleted; Operations, two people, too few to
 * show. Its first conversation was read, both agreements were signed, and
 * two people made their account.
 */
const bakerySnapshot = (name: string): AdminSnapshot => ({
  ...emptyAdminSnapshot(name),
  now: "2026-10-15T10:00:00.000Z",
  roster: {
    teams: [
      { id: "sales", name: "Sales", lead: "lisa", does: "Sells", off: false },
      {
        id: "ops",
        name: "Operations",
        lead: "otto",
        does: "Bakes",
        off: false,
      },
    ],
    people: [
      person("lisa", "Lisa de Vries", "sales"),
      person("tom", "Tom Jansen", "sales"),
      person("ann", "Ann Bos", "sales"),
      person("piet", "Piet Kok", "sales"),
      person("joost", "Joost Bakker", "sales"),
      person("otto", "Otto Smit", "ops"),
      person("mia", "Mia Vos", "ops"),
    ],
  },
  plan: { start: "2026-10-05", days: 14, at: "2026-10-05T07:00:00.000Z" },
  agreements: {
    processing: true,
    assessment: true,
    council: "none",
    processingOn: "2026-09-25",
    assessmentOn: "2026-09-29",
  },
  agreed: true,
  told: true,
  links: [
    link("lisa", "completed"),
    link("tom", "completed"),
    link("ann", "incomplete"),
    link("piet", "invited", "2026-10-12T12:00:00.000Z"),
    link("joost", "invited"),
    link("otto", "opened"),
    link("mia", "invited"),
  ],
  interviews: [
    interview("lisa", "2026-10-06", true),
    interview("tom", "2026-10-13", true),
    interview("ann", "2026-10-14", false),
  ],
  kickoff: { at: "2026-09-24T10:00:00.000Z", known: 0.6 },
  members: [
    {
      userId: "u-eva",
      name: "Eva Mulder",
      email: "eva@bakkerij.test",
      role: "admin",
      joinedAt: "2026-09-22T10:00:00.000Z",
    },
    {
      userId: "u-bram",
      name: "Bram Visser",
      email: "bram@bakkerij.test",
      role: "builder",
      joinedAt: "2026-09-23T10:00:00.000Z",
    },
  ],
});

/** What `html` shows as text: its tags gone, its spaces one each. */
const textOf = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ");

/** The text of the part titled `title` of a section, to the next part. */
const panelOf = (html: string, title: string): string => {
  const at = html.indexOf(`>${title}</h2>`);
  const next = html.indexOf("</h2>", at + title.length + 6);
  return at === -1
    ? ""
    : textOf(html.slice(at, next === -1 ? undefined : next));
};

/** The day `at` falls on in UTC, as the log heads it: "15 Oct 2026". */
const headOf = (at: Date): string =>
  `${at.getUTCDate()} ${at.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${at.getUTCFullYear()}`;

describe("an organization's records", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("says in Data what is kept of the interviews, who had theirs deleted, and what the company sees, only for a team big enough", async () => {
    const bakery = await liveClient();
    bakery.account.admin = bakerySnapshot("Bakkerij");

    const { status, html } = await page(
      `/admin/organizations/${bakery.clientId}/data`
    );
    const kept = panelOf(html, "What is kept");
    const deleted = panelOf(html, "Deleted because they asked");
    const sees = panelOf(html, "What the company itself sees");

    expect({
      status,
      toCome: html.includes("This section isn’t in the console yet."),
      kept: [
        "The first conversation With the sponsor, word for word. It is what the research and Stephen’s first questions start from. Read by Stephen",
        "Interviews people agreed to Their words are kept, and what they said counts. 2",
        "Interviews that stopped halfway Kept, so the link carries on where they stopped. Nothing in them counts. 1",
        "Anyone’s voice What is said is written out, and the sound is gone. Never kept",
        // Lisa's days to ask are over; Tom's aren't.
        "Can still be deleted For 7 days after their interview, the person can ask. 1",
      ].map((line) => kept.includes(line)),
      deleted: deleted.includes("Piet Kok Sales"),
      nobodyElse: ["Lisa de Vries", "Tom Jansen", "Ann Bos"].some((name) =>
        deleted.includes(name)
      ),
      sees: [
        "Sales 5 people 5 2 1 40%",
        "Operations 2 people Too small to show 2 – – –",
        // Operations is too small to show, so it adds nothing to everyone's numbers.
        "Everyone 5 people 5 2 1 40%",
      ].map((line) => sees.includes(line)),
    }).toStrictEqual({
      status: 200,
      toCome: false,
      kept: [true, true, true, true, true],
      deleted: true,
      nobodyElse: false,
      sees: [true, true, true],
    });
  });

  it("says in Data that nothing is there yet for a company with no roster, no interviews and no first conversation", async () => {
    const empty = await liveClient();
    empty.account.admin = emptyAdminSnapshot("Empty");

    const { html } = await page(`/admin/organizations/${empty.clientId}/data`);

    expect({
      conversation: panelOf(html, "What is kept").includes(
        "start from. Not brought in yet"
      ),
      deleted: panelOf(html, "Deleted because they asked").includes(
        "Nobody asked."
      ),
      sees: panelOf(html, "What the company itself sees").includes(
        "Nothing yet. The teams come with the company’s own sign-in."
      ),
    }).toStrictEqual({ conversation: true, deleted: true, sees: true });
  });

  it("lists in the Log what happened at the company and that Grasp added it here, the newest first, and nothing of another organization", async () => {
    const bakery = await liveClient();
    bakery.account.admin = bakerySnapshot("Bakkerij");
    const other = await liveClient();
    other.account.admin = emptyAdminSnapshot("Other");

    const { status, html } = await page(
      `/admin/organizations/${bakery.clientId}/log`
    );
    const text = textOf(html);
    const added = `${headOf(bakery.added)} 1 ${bakery.added.toISOString().slice(11, 16)} Added this organization. Grasp, by hand`;
    const lines = [
      added,
      "29 Sep 2026 1 In place: The company’s look at the risks to its people. The company",
      "25 Sep 2026 1 In place: Agreement on handling data. The company",
      "23 Sep 2026 2 1 person made their account. The company 1 person was invited into the platform. The company",
      "22 Sep 2026 2 1 person made their account. The company 1 person was invited into the platform. The company",
    ];
    const at = lines.map((line) => text.indexOf(line));

    expect({
      status,
      toCome: html.includes("This section isn’t in the console yet."),
      chart: html.includes(">What happened, by who did it</h2>"),
      found: at.map((index) => index !== -1),
      newestFirst: at.every(
        (index, order) => order === 0 || index > (at[order - 1] ?? -1)
      ),
      // Each organization's log is its own: the other one was added too.
      added: text.split("Added this organization.").length - 1,
      // The interviews as core counts them: the day the team was told, and who finished.
      history: ["The company told its team.", "finished their interview."].map(
        (line) => text.includes(line)
      ),
    }).toStrictEqual({
      status: 200,
      toCome: false,
      chart: true,
      found: [true, true, true, true, true],
      newestFirst: true,
      added: 1,
      history: [true, true],
    });
  });
});
