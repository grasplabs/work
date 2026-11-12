import { adminSnapshotSchema } from "@grasp-os/shared/admin-snapshot";
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { describe, expect, it } from "vite-plus/test";

import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page as pageAt } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-onboarding-5c1e93";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** An active client running a new release, as a deploy made it live, whose core answers `snapshot`. */
const liveClient = async (snapshot: AdminSnapshot) => {
  const release = await placedRelease("feat(core): onboarding");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { core } = await livePlacedClient(cloudflare, release, {
    id: clientId,
    name: `Bakkerij ${clientId}`,
    signIn: null,
  });
  core.admin = snapshot;
  return `/organizations/${clientId}`;
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
        failedMail: null,
        state: "completed",
      },
      {
        person: "tom",
        sentAt: "2026-10-06T07:00:00.000Z",
        openedAt: "2026-10-14T09:40:00.000Z",
        remindedAt: null,
        deletedAt: null,
        failedMail: null,
        state: "progress",
      },
      {
        person: "otto",
        sentAt: "2026-10-05T07:00:00.000Z",
        openedAt: "2026-10-06T08:00:00.000Z",
        remindedAt: null,
        deletedAt: null,
        failedMail: null,
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

/** The row of the team named `name` among the interviews' teams. */
const teamRowOf = (html: string, name: string): string => {
  const at = html.indexOf(`aria-label="Open ${name}"`);
  return at === -1
    ? ""
    : html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
};

describe("an organization's onboarding in the admin", () => {
  useStoreSecrets({ deployer: token });

  it("lists the steps, each saying where it stands, opens the one that is next here, and sends those another section shows there", async () => {
    const base = await liveClient(bakery());

    const { status, html } = await page(`${base}/steps`);
    const steps = stepsOf(html);

    expect({
      status,
      // Operations's lead hasn't talked, which Interviews shows: Grasp opens is next here.
      current: stepOf(steps, "Grasp opens").includes('aria-current="page"'),
      // Only the open step is marked.
      marked: steps.split("aria-current=").length - 1,
      statuses: [
        stepOf(steps, "Agreed").includes(": Done"),
        stepOf(steps, "Interviews").includes(": Now"),
        stepOf(steps, "Grasp opens").includes(": Later"),
      ],
      // What was agreed is the Contract's; the leads and the interviews are Interviews'.
      elsewhere: [
        stepOf(steps, "Agreed").includes(`href="${base}/details?tab=contract"`),
        stepOf(steps, "Team leads").includes(
          `href="${base}/interviews?tab=people"`
        ),
        stepOf(steps, "Interviews").includes(`href="${base}/interviews"`),
      ],
      // The others open themselves underneath.
      opensResearch: stepOf(steps, "Research").includes(
        `href="${base}/steps?stage=research"`
      ),
      complete: html.includes("nothing is missing"),
    }).toStrictEqual({
      status: 200,
      current: true,
      marked: 1,
      statuses: [true, true, true],
      elsewhere: [true, true, true],
      opensResearch: true,
      complete: false,
    });
  });

  it("opens the step a link names, with what staff can do there", async () => {
    const base = await liveClient(bakery());

    const opens = await page(`${base}/steps?stage=open`);
    const conversation = await page(`${base}/steps?stage=conversation`);
    const unknown = await page(`${base}/steps?stage=nothing`);

    expect({
      opens: {
        known: [
          "62%",
          "Opens at 80%",
          "Not enough is known yet. It can open once it is past 80%.",
          // Grasp's switches beside its go: the share, the go, the interviews.
          "How much has to be known before it opens",
          "Pause the interviews",
          "Give the go",
        ].map((text) => opens.html.includes(text)),
        go: opens.html.includes("Open Grasp for"),
      },
      conversation: {
        current: stepOf(
          stepsOf(conversation.html),
          "First conversation"
        ).includes('aria-current="page"'),
        read: conversation.html.includes(
          "Stephen has read it. What it brought stays in the company’s own Grasp."
        ),
      },
      // A step that isn't one opens where the steps open by themselves.
      unknown: stepOf(stepsOf(unknown.html), "Grasp opens").includes(
        'aria-current="page"'
      ),
    }).toStrictEqual({
      opens: { known: [true, true, true, true, true, true], go: false },
      conversation: { current: true, read: true },
      unknown: true,
    });
  });

  it("counts the interviews' days to the length the company's plan has", async () => {
    const snapshot = bakery();
    const plan = snapshot.plan ?? { start: "2026-10-05", days: 14 };
    const base = await liveClient({ ...snapshot, plan: { ...plan, days: 21 } });

    const { html } = await page(`${base}/steps`);

    expect(html).toContain("Day 9 of 21");
  });

  it("says a team's links are out only once a colleague's link went out, not when its lead talked", async () => {
    const snapshot = bakery();
    // Lisa talked; Tom's link waits, for the team's work to be drawn.
    const base = await liveClient({
      ...snapshot,
      links: snapshot.links.map((link) =>
        link.person === "tom"
          ? { ...link, sentAt: null, openedAt: null, state: "waiting" }
          : link
      ),
      interviews: snapshot.interviews.filter(
        (interview) => interview.person !== "tom"
      ),
    });

    const sales = await page(`${base}/interviews?team=sales`);

    expect(
      ["No links out yet", "Links out since"].map((text) =>
        sales.html.includes(text)
      )
    ).toStrictEqual([true, false]);
  });

  it("says the interviews are paused while the company has paused them", async () => {
    const base = await liveClient({ ...bakery(), paused: true });

    const opens = await page(`${base}/steps?stage=open`);

    expect(opens.html).toContain(
      "The company has paused its interviews: nobody can open or go on with one until it resumes them."
    );
  });

  it("opens a company that has nothing yet on its first conversation, still to come", async () => {
    const base = await liveClient(emptyAdminSnapshot("Bakkerij Noord"));

    const { html } = await page(`${base}/steps`);
    const research = await page(`${base}/steps?stage=research`);

    expect({
      // Grasp brings the first conversation in: the first step here in its hands.
      current: stepOf(stepsOf(html), "First conversation").includes(
        'aria-current="page"'
      ),
      conversation: html.includes(
        "Once the transcript is in, Stephen reads it"
      ),
      research: [
        "It starts once Stephen has read the first conversation",
        "Company register",
        "Not looked up yet",
      ].map((text) => research.html.includes(text)),
    }).toStrictEqual({
      current: true,
      conversation: true,
      research: [true, true, true],
    });
  });

  it("lists the company's teams where its interviews are, each with where it stands, opening the team, and short enough to need no search", async () => {
    const base = await liveClient(bakery());

    const { status, html } = await page(`${base}/interviews`);
    const sales = teamRowOf(html, "Sales");
    const operations = teamRowOf(html, "Operations");
    const logistics = teamRowOf(html, "Logistics");

    expect({
      status,
      standing: html.includes("Where everyone stands"),
      // Three teams are read whole: nothing to search or narrow them with.
      search: html.includes("Find a team or a person"),
      sales: [
        "Lisa de Vries",
        "1 of 2 talked",
        `href="${base}/interviews?team=sales"`,
      ].map((text) => sales.includes(text)),
      operations: ["Waits for Otto to talk first"].map((text) =>
        operations.includes(text)
      ),
      logistics: [
        "Does not take part",
        // Asked in from its row, while the interviews run.
        "Ask Logistics in",
      ].map((text) => logistics.includes(text)),
    }).toStrictEqual({
      status: 200,
      standing: true,
      search: false,
      sales: [true, true, true],
      operations: [true],
      logistics: [true, true],
    });
  });

  it("opens one team whole: its lead, everyone in it with their titles and links, and its work still to be named", async () => {
    const base = await liveClient(bakery());

    const sales = await page(`${base}/interviews?team=sales`);
    const logistics = await page(`${base}/interviews?team=7`);
    const unknown = await page(`${base}/interviews?team=bakery`);
    // The teams' old address leads to where they are now, its team with it.
    const old = await pageAt(`${base}/organization?team=sales`);

    expect({
      sales: [
        "Sales</h2>",
        "Takes part in the interviews",
        // Tom's link went out the day after Lisa talked.
        "Links out since 6 Oct 2026",
        "Head of Sales",
        "Account manager",
        "Talking now",
        "Ann Bos",
        "Away",
        "Fewer than 5: the company never sees this team’s numbers apart.",
        "Its lead names the team’s work in their interview",
        `href="${base}/interviews"`,
      ].map((text) => sales.html.includes(text)),
      logistics: [
        "Does not take part in the interviews",
        "This team does not take part: nobody in it gets a link",
      ].map((text) => logistics.html.includes(text)),
      // A team the company doesn't have: all of them.
      unknown: unknown.html.includes('aria-label="Open Sales"'),
      old: old.html.includes("Sales</h2>"),
      // Where a person's link stands is still read out on a phone, where it isn't shown.
      phone: [
        sales.html.includes('class="max-sm:sr-only">Talking now'),
        sales.html.includes('class="max-sm:hidden">Talking now'),
      ],
    }).toStrictEqual({
      sales: Array.from({ length: 11 }, () => true),
      logistics: [true, true],
      phone: [true, false],
      unknown: true,
      old: true,
    });
  });

  it("says nothing is on the list yet before the company shares it", async () => {
    const base = await liveClient(emptyAdminSnapshot("Bakkerij Noord"));

    const { html } = await page(`${base}/interviews`);

    expect({
      empty: html.includes(
        "Nobody is on the list yet. The company’s admin shares its staff list in their onboarding."
      ),
      teams: html.includes('aria-label="Open '),
    }).toStrictEqual({ empty: true, teams: false });
  });
});
