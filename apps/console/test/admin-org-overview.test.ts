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
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-org-overview-5c1a90";
const tenantToken = "test-tenant-admin-token-org-overview-27e4bd";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): the overview" });
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

/**
 * A company of which 85% is known, past the 80% it opens at, with nothing
 * signed yet: at the agreements, ready for Grasp's go.
 */
const readySnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  return {
    ...empty,
    kickoff: { at: empty.now, known: 0.5 },
    gate: { ...empty.gate, known: 85, ready: true },
  };
};

/** A company whose people came in through its sign-in, its lead not named yet. */
const peopleInSnapshot = (name: string): AdminSnapshot => ({
  ...readySnapshot(name),
  roster: {
    teams: [{ id: "t-sales", name: "Sales", lead: null, does: "", off: false }],
    people: [
      {
        id: "p-anna",
        name: "Anna",
        email: "anna@acme.test",
        team: "t-sales",
        title: "",
        away: false,
      },
    ],
  },
});

/**
 * A company told three days ago, on a plan of 21 days, with one team: its
 * lead Lisa, who has talked, and Tom, both sent their link.
 */
const toldSnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  const at = (back: number, hour: number) =>
    new Date(
      Date.parse(empty.now) - back * 86_400_000 + hour * 3_600_000
    ).toISOString();
  const told = at(3, 0);
  return {
    ...empty,
    roster: {
      teams: [
        { id: "sales", name: "Sales", lead: "lisa", does: "", off: false },
      ],
      people: [
        ["lisa", "Lisa"],
        ["tom", "Tom"],
      ].map(([id = "", person = ""]) => ({
        id,
        name: person,
        email: "",
        team: "sales",
        title: "",
        away: false,
      })),
    },
    plan: { start: told.slice(0, 10), days: 21, at: told },
    agreements: { processing: true, assessment: true, council: "none" },
    agreed: true,
    told: true,
    links: ["lisa", "tom"].map((person) => ({
      person,
      sentAt: told,
      openedAt: null,
      remindedAt: null,
      deletedAt: null,
      state: person === "lisa" ? "completed" : "waiting",
    })),
    interviews: [
      {
        person: "lisa",
        kind: "lead",
        startedAt: at(3, 1),
        completedAt: at(3, 2),
        updatedAt: at(3, 2),
        agreed: true,
        phase: "readback",
        stoppedAt: null,
        minutes: 40,
        facts: 4,
        out: 0,
        confirmed: 4,
        rating: 5,
        typed: false,
        interviewer: "stephen",
      },
    ],
  };
};

/** A company Grasp gave its go to a week ago, its platform open. */
const openSnapshot = (name: string): AdminSnapshot => {
  const ready = readySnapshot(name);
  const weekAgo = new Date(Date.parse(ready.now) - 7 * 86_400_000);
  return {
    ...ready,
    gate: { ...ready.gate, open: true, openedAt: weekAgo.toISOString() },
  };
};

/** The health signal named `area`, from its link's start to its end. */
const signalOf = (html: string, area: string): string => {
  const start = html.indexOf('aria-label="How the company is doing"');
  const at = html.indexOf(`aria-label="${area}: `, start);
  return start === -1 || at === -1
    ? ""
    : html.slice(html.lastIndexOf("<a", at), html.indexOf("</a>", at));
};

/** The brief for the next call, its whole section. */
const briefOf = (html: string): string => {
  const at = html.indexOf("Before the next call</h2>");
  return at === -1
    ? ""
    : html.slice(
        html.lastIndexOf("<section", at),
        html.indexOf("</section>", at)
      );
};

describe("an organization's overview", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });

  it("says how the company is doing, each signal opening its section, and what core doesn't hold as not found yet rather than none", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const base = `/admin/organizations/${acme.clientId}`;

    const { status, html } = await page(base);

    expect({
      status,
      // Name, level and line, as each signal is announced; and where it goes.
      signals: [
        "Connections: Not yet. Sign-in not connected yet",
        "Interviews: Not yet. Not started",
        "Brain: Good. 85% known, opens at 80%",
        "Workflows: Not yet. No workflows found yet",
        "Account: Needs Grasp. Contract not signed",
      ].map((label) => html.includes(`aria-label="${label}"`)),
      opens: [
        ["Connections", `${base}/integrations`],
        ["Interviews", `${base}/interviews`],
        ["Brain", `${base}/brain`],
        ["Workflows", `${base}/workflows`],
        ["Account", `${base}/contract`],
      ].map(([area = "", to]) => signalOf(html, area).includes(`href="${to}"`)),
      // Nothing core doesn't hold is counted as zero.
      noZeros: !["0 connected", "0 of 0 known"].some((text) =>
        html.includes(text)
      ),
      ported: !html.includes("This section isn’t in the console yet."),
    }).toStrictEqual({
      status: 200,
      signals: [true, true, true, true, true],
      opens: [true, true, true, true, true],
      noZeros: true,
      ported: true,
    });
  });

  it("briefs the next call: where the company stands, and the most pressing of what to bring up, each opening where it is settled", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const base = `/admin/organizations/${acme.clientId}`;

    const { html } = await page(base);
    const brief = briefOf(html);

    expect({
      stands: brief.includes(
        "Agreed<!-- -->. <!-- -->85<!-- -->% of what Grasp needs is known."
      ),
      // The go and both agreements; the contract is fourth, past the three a brief holds.
      bringUp: [
        "The company comes in once Grasp gives its go.",
        "The agreement on handling data is not signed yet.",
        "The company has not signed off its look at the risks yet.",
        "The contract is still being written.",
      ].map((text) => brief.includes(text)),
      opensSteps: brief.includes(`href="${base}/steps"`),
      // Core gives how much is known without its parts, and no drawn work.
      notKnownYet: brief.includes("Not known yet"),
      couldDoMore: brief.includes("Where Grasp could do more"),
    }).toStrictEqual({
      stands: true,
      bringUp: [true, true, true, false],
      opensSteps: true,
      notKnownYet: false,
      couldDoMore: false,
    });
  });

  it("once the company is open, briefs it as open and sends its workflows to the hours they free, without calling none live a worry", async () => {
    const acme = await liveClient();
    acme.account.admin = openSnapshot("Acme");
    const base = `/admin/organizations/${acme.clientId}`;

    const { html } = await page(base);

    expect({
      open: briefOf(html).includes("Open since the go"),
      workflows: html.includes(
        'aria-label="Workflows: Not yet. No workflows found yet"'
      ),
      toHours: signalOf(html, "Workflows").includes(`href="${base}/hours"`),
    }).toStrictEqual({ open: true, workflows: true, toHours: true });
  });

  it("says the sign-in is connected once the company's people are in, before its team leads are named", async () => {
    const acme = await liveClient();
    acme.account.admin = peopleInSnapshot("Acme");

    const { html } = await page(`/admin/organizations/${acme.clientId}`);

    expect(html).toContain(
      'aria-label="Connections: Not yet. Sign-in connected, team leads not named yet"'
    );
  });

  it("counts the interviews' days to the company's own plan", async () => {
    const acme = await liveClient();
    acme.account.admin = toldSnapshot("Acme");

    const { html } = await page(`/admin/organizations/${acme.clientId}`);

    expect(signalOf(html, "Interviews")).toMatch(/talked, day \d+ of 21"/u);
  });
});
