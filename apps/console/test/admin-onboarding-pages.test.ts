import { adminSnapshotSchema } from "@grasp-os/shared/admin-snapshot";
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { act, consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { emptyAdminSnapshot, mockCloudflareApi } from "./cloudflare-api.ts";
import { page as pageAt } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-onboarding-5c1e93";
const tenantToken = "test-tenant-admin-token-admin-onboarding-a72f04";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live, whose core answers `snapshot`. */
const liveClient = async (snapshot: AdminSnapshot) => {
  const release = await publishRelease({ notes: "feat(core): onboarding" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount(`Bakkerij ${clientId}`);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Bakkerij ${clientId}`,
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
  account.admin = snapshot;
  return `/admin/organizations/${clientId}`;
};

/**
 * A small bakery, nine days into its interviews: everything agreed and the
 * team told. Sales's lead talked and its links went out; Tom is talking
 * now, and Ann, away, gets none. Operations's lead opened their link and
 * hasn't talked, so the team waits; Logistics takes no part. 62% is known,
 * below the 80% it opens at.
 */
const bakery = (): AdminSnapshot =>
  adminSnapshotSchema.parse({
    ...emptyAdminSnapshot("Bakkerij Noord"),
    now: "2026-10-14T10:05:00Z",
    roster: {
      teams: [
        {
          id: "sales",
          name: "Sales",
          lead: "lisa",
          does: "Sells bread to shops",
          off: false,
        },
        { id: "ops", name: "Operations", lead: "otto", does: "", off: false },
        // An id of digits, as a list may have it.
        { id: "7", name: "Logistics", lead: null, off: true },
      ],
      people: [
        {
          id: "lisa",
          name: "Lisa de Vries",
          email: "lisa@bakkerij.test",
          team: "sales",
          title: "Head of Sales",
        },
        {
          id: "tom",
          name: "Tom Jansen",
          email: "tom@bakkerij.test",
          team: "sales",
          title: "Account manager",
        },
        { id: "ann", name: "Ann Bos", team: "sales", away: true },
        {
          id: "otto",
          name: "Otto Smit",
          email: "otto@bakkerij.test",
          team: "ops",
          title: "Head baker",
        },
        { id: "lars", name: "Lars Kok", team: "7" },
      ],
    },
    plan: { start: "2026-10-05", days: 14, at: "2026-10-05T07:00:00.000Z" },
    agreements: {
      processing: true,
      assessment: true,
      council: "none",
    },
    agreed: true,
    told: true,
    mapped: ["sales"],
    links: [
      {
        person: "lisa",
        sentAt: "2026-10-05T07:00:00.000Z",
        openedAt: "2026-10-05T07:30:00.000Z",
        remindedAt: null,
        deletedAt: null,
        state: "completed",
      },
      {
        person: "tom",
        sentAt: "2026-10-06T07:00:00.000Z",
        openedAt: "2026-10-14T09:40:00.000Z",
        remindedAt: null,
        deletedAt: null,
        state: "progress",
      },
      {
        person: "otto",
        sentAt: "2026-10-05T07:00:00.000Z",
        openedAt: "2026-10-06T08:00:00.000Z",
        remindedAt: null,
        deletedAt: null,
        state: "opened",
      },
    ],
    interviews: [
      {
        person: "lisa",
        kind: "lead",
        startedAt: "2026-10-05T08:00:00.000Z",
        completedAt: "2026-10-05T08:40:00.000Z",
        updatedAt: "2026-10-05T08:40:00.000Z",
        agreed: true,
        phase: "readback",
        stoppedAt: null,
        minutes: 40,
        facts: 12,
        out: 2,
        confirmed: 12,
        rating: 5,
        typed: false,
        interviewer: "stephen",
      },
      {
        person: "tom",
        kind: "own",
        startedAt: "2026-10-14T09:45:00.000Z",
        completedAt: null,
        updatedAt: "2026-10-14T10:00:00.000Z",
        agreed: false,
        phase: "steps",
        stoppedAt: null,
        minutes: 15,
        facts: 3,
        out: 0,
        confirmed: 0,
        rating: null,
        typed: true,
        interviewer: "claire",
      },
    ],
    kickoff: { at: "2026-09-24T10:00:00.000Z", known: 0.6 },
    gate: {
      open: false,
      closedSince: "2026-09-21T08:00:00.000Z",
      threshold: 80,
      known: 62,
      ready: false,
      over: false,
      openedAt: null,
    },
  });

/** The page at `path`, its text whole where React marks where one piece of it ends and the next starts. */
const page = async (path: string) => {
  const { status, html } = await pageAt(path);
  return { status, html: html.replaceAll("<!-- -->", "") };
};

/** The steps' list on a page: from its start to its end. */
const stepsOf = (html: string): string => {
  const at = html.indexOf('<nav aria-label="The steps of this onboarding"');
  return at === -1 ? "" : html.slice(at, html.indexOf("</nav>", at));
};

/** The step titled `title` in the steps' list: from its link's start to its end. */
const stepOf = (steps: string, title: string): string => {
  const at = steps.indexOf(`>${title}<`);
  return at === -1
    ? ""
    : steps.slice(steps.lastIndexOf("<a", at), steps.indexOf("</a>", at));
};

/** The card of the team named `name` on the organization's page. */
const cardOf = (html: string, name: string): string => {
  const at = html.indexOf(`aria-label="Open ${name}"`);
  return at === -1
    ? ""
    : html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
};

describe("an organization's onboarding in the admin", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });

  it("opens the steps on the one the organization is at, each saying where it stands, and the open one underneath", async () => {
    const base = await liveClient(bakery());

    const { status, html } = await page(`${base}/steps`);
    const steps = stepsOf(html);

    expect({
      status,
      // Operations's lead hasn't talked: the first step not done.
      current: stepOf(steps, "Team leads").includes('aria-current="page"'),
      // Only the open step is marked, and it is where the steps open by themselves.
      marked: steps.split("aria-current=").length - 1,
      opensLeads: stepOf(steps, "Team leads").includes(`href="${base}/steps"`),
      lines: [
        "Read, nothing is missing",
        "Everything is in place",
        "1 of 2 talked",
        "Day 9 of 14. 1 of 3 talked",
        "62% known. It opens at 80%",
      ].map((line) => steps.includes(line)),
      statuses: [
        stepOf(steps, "Agreed").includes(": Done"),
        stepOf(steps, "Interviews").includes(": Now"),
        stepOf(steps, "Grasp opens").includes(": Later"),
      ],
      // Each step opens itself underneath.
      opensAgreed: stepOf(steps, "Agreed").includes(
        `href="${base}/steps?stage=agreed"`
      ),
      leads: [
        "Lisa de Vries",
        "Talked on 5 Oct 2026. 2 colleagues got a link.",
        "Otto Smit",
        "Opened. The team waits for this interview.",
        "1 lead can still be reminded. Sending the reminder isn’t in the console yet.",
      ].map((text) => html.includes(text)),
      // Nothing here sends a reminder.
      remind: html.includes(">Remind"),
    }).toStrictEqual({
      status: 200,
      current: true,
      marked: 1,
      opensLeads: true,
      lines: [true, true, true, true, true],
      statuses: [true, true, true],
      opensAgreed: true,
      leads: [true, true, true, true, true],
      remind: false,
    });
  });

  it("opens the step a link names, read only, with what can't be done from the console said so", async () => {
    const base = await liveClient(bakery());

    const agreed = await page(`${base}/steps?stage=agreed`);
    const interviews = await page(`${base}/steps?stage=interviews`);
    const opens = await page(`${base}/steps?stage=open`);
    const conversation = await page(`${base}/steps?stage=conversation`);
    const unknown = await page(`${base}/steps?stage=nothing`);

    expect({
      agreed: {
        current: stepOf(stepsOf(agreed.html), "Agreed").includes(
          'aria-current="page"'
        ),
        states: [
          "Signed",
          "Signed off",
          "No works council",
          "Interviews can start.",
          "The team is told, so this stays as it was agreed.",
        ].map((text) => agreed.html.includes(text)),
        // Nothing here changes what was agreed.
        switches: agreed.html.includes('role="switch"'),
        notHere: agreed.html.includes(
          "Keeping what was agreed as it comes in isn’t in the console yet."
        ),
      },
      interviews: {
        shown: [
          "Day 9 of 14. The link closes on 19 Oct 2026.",
          "are talking right now",
          // Operations's people wait for Otto; Sales has nobody left to remind.
          "Waits for Otto’s list",
          "Everyone by name",
          `href="${base}/interviews"`,
          "1 person can still be reminded. Sending the reminder isn’t in the console yet.",
        ].map((text) => interviews.html.includes(text)),
        // Logistics takes no part, so it isn't among the teams talking.
        logistics: interviews.html.includes(">Logistics<"),
      },
      opens: {
        known: [
          "62%",
          "Opens at 80%",
          "Not enough is known yet. It can open once it is past 80%.",
          // Core counts the whole, and sends no share of each source.
          "The company’s own Grasp counts what is known and sends the whole",
          "Giving Grasp’s go, taking it back and changing the share it opens at aren’t in the console yet.",
        ].map((text) => opens.html.includes(text)),
        go: opens.html.includes("Open Grasp for"),
      },
      conversation: [
        "Stephen has read it. What it brought stays in the company’s own Grasp.",
        "What was said stays in the company’s own Grasp: the console never shows it.",
      ].map((text) => conversation.html.includes(text)),
      // A step that isn't one opens the one the organization is at.
      unknown: stepOf(stepsOf(unknown.html), "Team leads").includes(
        'aria-current="page"'
      ),
    }).toStrictEqual({
      agreed: {
        current: true,
        states: [true, true, true, true, true],
        switches: false,
        notHere: true,
      },
      interviews: {
        shown: [true, true, true, true, true, true],
        logistics: false,
      },
      opens: { known: [true, true, true, true, true], go: false },
      conversation: [true, true],
      unknown: true,
    });
  });

  it("opens a company that has nothing yet on what is agreed, with its first conversation still to come", async () => {
    const base = await liveClient(emptyAdminSnapshot("Bakkerij Noord"));

    const { html } = await page(`${base}/steps`);
    const conversation = await page(`${base}/steps?stage=conversation`);
    const research = await page(`${base}/steps?stage=research`);
    const interviews = await page(`${base}/steps?stage=interviews`);

    expect({
      // Grasp waits on the agreements: the first step in its hands.
      current: stepOf(stepsOf(html), "Agreed").includes('aria-current="page"'),
      conversation: [
        "Not brought in yet",
        "Nothing yet. Once the transcript is in, Stephen reads it",
      ].map((text) => conversation.html.includes(text)),
      research: [
        "It starts once Stephen has read the first conversation",
        "Company register",
        "Not looked up yet",
      ].map((text) => research.html.includes(text)),
      interviews: interviews.html.includes(
        "Nobody has a link yet. They go out once everything is agreed and the company has told its team."
      ),
    }).toStrictEqual({
      current: true,
      conversation: [true, true],
      research: [true, true, true],
      interviews: true,
    });
  });

  it("shows the company's teams as cards with their figures, leads and what needs a look", async () => {
    const base = await liveClient(bakery());

    const { status, html } = await page(`${base}/organization`);
    const sales = cardOf(html, "Sales");
    const operations = cardOf(html, "Operations");
    const logistics = cardOf(html, "Logistics");

    expect({
      status,
      source: html.includes("The list as the company’s admin shared it."),
      figures: [
        "2 take part",
        "1 of 3 asked have talked",
        "Named by each team’s lead",
      ].map((text) => html.includes(text)),
      filters: ["Take part", "Left out"].map((text) => html.includes(text)),
      sales: [
        "Sells bread to shops",
        "3 people",
        "Lisa de Vries",
        "Team lead, has talked",
        "1 of 2 talked",
        `href="${base}/organization?team=sales"`,
      ].map((text) => sales.includes(text)),
      operations: [
        "Otto Smit",
        "Team lead</span>",
        "Waits for Otto to talk first.",
      ].map((text) => operations.includes(text)),
      logistics: [
        "No team lead named",
        "Does not take part",
        // Nothing to ask it in with.
        "<button",
      ].map((text) => logistics.includes(text)),
    }).toStrictEqual({
      status: 200,
      source: true,
      figures: [true, true, true],
      filters: [true, true],
      sales: [true, true, true, true, true, true],
      operations: [true, true, true],
      logistics: [true, true, false],
    });
  });

  it("opens one team whole: its lead, everyone in it with their titles and links, and its work still to be named", async () => {
    const base = await liveClient(bakery());

    const sales = await page(`${base}/organization?team=sales`);
    const logistics = await page(`${base}/organization?team=7`);
    const unknown = await page(`${base}/organization?team=bakery`);

    expect({
      sales: [
        "Sales</h2>",
        "Takes part in the interviews",
        "Links out since 5 Oct 2026",
        "Head of Sales",
        "Account manager",
        "Talking now",
        "Ann Bos",
        "Away",
        "Fewer than 5: the company never sees this team’s numbers apart.",
        "Its lead names the team’s work in their interview",
        `href="${base}/organization"`,
      ].map((text) => sales.html.includes(text)),
      logistics: [
        "Does not take part in the interviews",
        "This team does not take part: nobody in it gets a link",
      ].map((text) => logistics.html.includes(text)),
      // A team the company doesn't have: all of them.
      unknown: unknown.html.includes('aria-label="Open Sales"'),
    }).toStrictEqual({
      sales: Array.from({ length: 11 }, () => true),
      logistics: [true, true],
      unknown: true,
    });
  });

  it("says nothing is on the list yet before the company shares it", async () => {
    const base = await liveClient(emptyAdminSnapshot("Bakkerij Noord"));

    const { html } = await page(`${base}/organization`);

    expect({
      empty: html.includes(
        "Nobody is on the list yet. The company’s admin shares its staff list in their onboarding."
      ),
      cards: html.includes('aria-label="Open '),
    }).toStrictEqual({ empty: true, cards: false });
  });
});
