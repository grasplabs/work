import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { describe, expect, it } from "vite-plus/test";

import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-org-overview-5c1a90";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): the overview");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { core } = await livePlacedClient(cloudflare, release, {
    id: clientId,
    name: `Acme ${clientId}`,
    signIn: null,
  });
  return { clientId, core };
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
      failedMail: null,
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

/** What needs Grasp at the company, its whole section. */
const needsOf = (html: string): string => {
  const at = html.indexOf("Needs Grasp</h2>");
  return at === -1
    ? ""
    : html.slice(
        html.lastIndexOf("<section", at),
        html.indexOf("</section>", at)
      );
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
  useStoreSecrets({ deployer: token });

  it("lists what needs Grasp, the most pressing first, each opening the section it is settled in", async () => {
    const acme = await liveClient();
    acme.core.admin = readySnapshot("Acme");
    const base = `/organizations/${acme.clientId}`;

    const { status, html } = await page(base);
    const needs = needsOf(html);
    // The go and both agreements; a contract core doesn't hold is nothing to settle.
    const lines = [
      "The company comes in once Grasp gives its go.",
      "The agreement on handling data is not signed yet.",
      "The company has not signed off its look at the risks yet.",
    ];

    expect({
      status,
      needs: lines.map((text) => needs.includes(text)),
      contract: needs.includes("The contract is still being written."),
      opensSteps: needs.includes(`href="${base}/steps"`),
      ported: !html.includes("This section isn’t in the admin yet."),
    }).toStrictEqual({
      status: 200,
      needs: [true, true, true],
      contract: false,
      opensSteps: true,
      ported: true,
    });
  });

  it("briefs the next call with where the company stands, leaving what to bring up to what needs Grasp beside it", async () => {
    const acme = await liveClient();
    acme.core.admin = readySnapshot("Acme");

    const { html } = await page(`/organizations/${acme.clientId}`);
    const brief = briefOf(html);

    expect({
      stands: brief.includes("Agreed."),
      prepares: brief.includes("Prepare the call with Grasp"),
      // What needs Grasp stands once, in its own list.
      bringUp: brief.includes("The company comes in once Grasp gives its go."),
      // Core gives how much is known without its parts, and no drawn work.
      notKnownYet: brief.includes("Not known yet"),
      couldDoMore: brief.includes("Where Grasp could do more"),
    }).toStrictEqual({
      stands: true,
      prepares: true,
      bringUp: false,
      notKnownYet: false,
      couldDoMore: false,
    });
  });

  it("once the company is open, briefs it as open", async () => {
    const acme = await liveClient();
    acme.core.admin = openSnapshot("Acme");

    const { html } = await page(`/organizations/${acme.clientId}`);

    expect(briefOf(html)).toContain("Open since the go");
  });

  it("counts the interviews' days to the company's own plan", async () => {
    const acme = await liveClient();
    acme.core.admin = toldSnapshot("Acme");

    const { html } = await page(`/organizations/${acme.clientId}`);

    expect(html.replaceAll(/<[^>]*>/gu, "")).toMatch(/Day \d+ of 21/u);
  });
});
