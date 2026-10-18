import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { formatDate } from "../src/admin/words.ts";
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

const token = "test-deployer-token-admin-interviews-5c1a97";
const tenantToken = "test-tenant-admin-token-admin-interviews-0e6b38";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): interviews" });
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
  return { clientId, account };
};

const minute = 60_000;
const day = 24 * 60 * minute;

/** What someone said, and their link's code: what core never sends, and the console must never show. */
const said = "We key every supplier invoice in by hand on Fridays";
const fact = "Invoices wait for the controller's second signature";
const linkCode = "7k3f-q2mp-secret-link-code";

/** A time, as core sends one. */
const at = (ms: number) => new Date(ms).toISOString();

/** What of `texts` a page doesn't say. */
const missingIn = (html: string, texts: string[]) =>
  texts.filter((text) => !html.includes(text));

/**
 * A company three days into its interviews, with one team of three: its
 * lead Ana talked to Claire for 12 minutes and gave it a 5; Ben typed to
 * Stephen for 7 minutes and stopped at the steps; Cleo has her link; and
 * Dan has been talking to Stephen for 4 minutes, still at his story.
 * Its core also answers with what a core must never send (what was said,
 * the facts' words and a link's code), as an older or broken one might:
 * the console's read drops it.
 */
const interviewingSnapshot = (): AdminSnapshot => {
  const empty = emptyAdminSnapshot("Acme");
  const now = Date.parse(empty.now);
  const start = at(now - 3 * day);
  const link = (
    person: string,
    state: AdminSnapshot["links"][number]["state"]
  ) => ({
    person,
    sentAt: start,
    openedAt: state === "invited" ? null : start,
    remindedAt: null,
    deletedAt: null,
    state,
    code: linkCode,
    url: `https://acme.grasp.test/i/${linkCode}`,
  });
  const ana = {
    person: "p-ana",
    kind: "lead" as const,
    startedAt: at(now - 2 * day),
    completedAt: at(now - 2 * day + 12 * minute),
    updatedAt: at(now - 2 * day + 12 * minute),
    agreed: true,
    phase: "readback" as const,
    stoppedAt: null,
    minutes: 12,
    facts: 4,
    out: 1,
    confirmed: 4,
    rating: 5,
    typed: false,
    interviewer: "claire" as const,
    lines: [{ who: "person", text: said }],
    transcript: said,
    factTexts: [fact],
  };
  const ben = {
    person: "p-ben",
    kind: "own" as const,
    startedAt: at(now - day),
    completedAt: null,
    updatedAt: at(now - day + 7 * minute),
    agreed: false,
    phase: "steps" as const,
    stoppedAt: "steps" as const,
    minutes: 7,
    facts: 2,
    out: 0,
    confirmed: 0,
    rating: null,
    typed: true,
    interviewer: "stephen" as const,
    transcript: said,
  };
  // Core sends the part a live interview is in as where it stands, the
  // same as for one that stopped: only the link says he is talking now.
  const dan = {
    ...ben,
    person: "p-dan",
    startedAt: at(now - 4 * minute),
    updatedAt: at(now),
    phase: "story" as const,
    stoppedAt: "story" as const,
    minutes: 4,
    facts: 1,
    typed: false,
  };
  return {
    ...empty,
    roster: {
      teams: [
        {
          id: "t-finance",
          name: "Finance",
          lead: "p-ana",
          does: "",
          off: false,
        },
      ],
      people: [
        {
          id: "p-ana",
          name: "Ana Smit",
          email: "",
          team: "t-finance",
          title: "",
          away: false,
        },
        {
          id: "p-ben",
          name: "Ben Vos",
          email: "",
          team: "t-finance",
          title: "",
          away: false,
        },
        {
          id: "p-cleo",
          name: "Cleo Bakker",
          email: "",
          team: "t-finance",
          title: "",
          away: false,
        },
        {
          id: "p-dan",
          name: "Dan Mol",
          email: "",
          team: "t-finance",
          title: "",
          away: false,
        },
      ],
    },
    plan: { start: start.slice(0, 10), days: 14, at: start },
    agreed: true,
    told: true,
    links: [
      link("p-ana", "completed"),
      link("p-ben", "incomplete"),
      link("p-cleo", "invited"),
      link("p-dan", "progress"),
    ],
    interviews: [ana, ben, dan],
  };
};

describe("an organization's interviews", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });

  it("shows every team, everyone by name, every interview, and how Stephen and Claire did, in numbers only", async () => {
    const acme = await liveClient();
    const snapshot = interviewingSnapshot();
    acme.account.admin = snapshot;
    const base = `/admin/organizations/${acme.clientId}/interviews`;
    // The last day a link works: the plan's 14th, counting its first.
    const lastDay = new Date(`${snapshot.plan?.start ?? ""}T12:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() + 13);

    const teams = await page(base);
    const people = await page(`${base}?tab=people`);
    const transcripts = await page(`${base}?tab=transcripts`);
    const interviewers = await page(`${base}?tab=interviewers`);
    const setup = await page(`${base}?tab=setup`);
    const pages = [teams, people, transcripts, interviewers, setup];

    expect({
      statuses: pages.map((each) => each.status),
      // What each tab says that isn't there yet: every line it should show.
      missing: {
        teams: missingIn(teams.html, [
          "Where everyone stands",
          "Finance",
          "1 of 4 talked",
          "Talked, day by day",
          `The links work until ${formatDate(lastDay.toISOString())}.`,
        ]),
        people: missingIn(people.html, [
          "Ana Smit",
          "Team lead",
          "Ben Vos",
          "Stopped halfway",
          "Step by step",
          "Cleo Bakker",
          "Invited",
          "Dan Mol",
          "Talking now",
        ]),
        transcripts: missingIn(transcripts.html, [
          "Ana Smit",
          "Ben Vos",
          "Stopped at: Step by step",
          "Dan Mol",
          "Talking now",
          "the console is sent none of it, so no transcript is read here",
        ]),
        interviewers: missingIn(interviewers.html, [
          "What people thought of it",
          "1 of 1 said how it was",
          "5.0 of 5",
          "1 of 3",
          "23 minutes in all",
          "Who people chose",
          "Stephen",
          "Claire",
          "1 interview stopped halfway and was not picked up again.",
          "Up to 10 minutes",
          "11–15 minutes",
        ]),
        setup: missingIn(setup.html, [
          "How Stephen and Claire are set up here",
          "None named yet: the company’s own Grasp doesn’t say which.",
          "What they know before they say hello",
        ]),
      },
      // Nothing anyone said, and no link's code, on any tab.
      // Dan is talking now: he stopped nowhere.
      danStopped: transcripts.html.includes("Stopped at: Your story"),
      leaked: pages.flatMap((each) =>
        [said, fact, linkCode].filter((text) => each.html.includes(text))
      ),
      toCome: pages.some((each) =>
        each.html.includes("This section isn’t in the console yet.")
      ),
    }).toStrictEqual({
      statuses: [200, 200, 200, 200, 200],
      missing: {
        teams: [],
        people: [],
        transcripts: [],
        interviewers: [],
        setup: [],
      },
      danStopped: false,
      leaked: [],
      toCome: false,
    });
  });

  it("says no interview has been held before the company told its team", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");
    const base = `/admin/organizations/${acme.clientId}/interviews`;

    const teams = await page(base);
    const transcripts = await page(`${base}?tab=transcripts`);
    const interviewers = await page(`${base}?tab=interviewers`);

    expect([
      teams.html.includes(
        "Nobody is known here yet. The people come with the company’s own list."
      ),
      transcripts.html.includes(
        "No interviews yet. They start once the company has told its team."
      ),
      interviewers.html.includes(
        "No interviews yet. They start once the company has told its team."
      ),
    ]).toStrictEqual([true, true, true]);
  });

  it("gives no share of voice or of what was left in while no interview is finished", async () => {
    const acme = await liveClient();
    const snapshot = interviewingSnapshot();
    // Only Ben, who stopped halfway, and Dan, who is talking now, have started.
    acme.account.admin = {
      ...snapshot,
      interviews: snapshot.interviews.filter((interview) => !interview.agreed),
    };

    const { html } = await page(
      `/admin/organizations/${acme.clientId}/interviews?tab=interviewers`
    );
    /** The figure labelled `label`: its label up to the line under its number. */
    const figureOf = (label: string) => {
      const start = html.indexOf(`>${label}</span>`);
      return start === -1
        ? ""
        : html.slice(start, html.indexOf("</div>", start));
    };

    expect(
      ["Finished", "Left in", "By voice"].map((label) => ({
        label,
        shown: [">0 of 2<", ">–<", ">0%<"].filter((text) =>
          figureOf(label).includes(text)
        ),
      }))
    ).toStrictEqual([
      // Its ring says the share too: none of the two who started.
      { label: "Finished", shown: [">0 of 2<", ">0%<"] },
      { label: "Left in", shown: [">–<"] },
      { label: "By voice", shown: [">–<"] },
    ]);
  });
});
