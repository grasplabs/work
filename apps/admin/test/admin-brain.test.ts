import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { describe, expect, it } from "vite-plus/test";

import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-brain-5c2d90";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): the brain");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name: `Acme ${clientId}`,
    signIn: null,
  });
  return { clientId, name: `Acme ${clientId}`, account };
};

/** An interview `person` agreed to, with `facts` kept and none taken out. */
const agreedInterview = (
  person: string,
  kind: "own" | "lead",
  facts: number,
  at: string
): AdminSnapshot["interviews"][number] => ({
  person,
  kind,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  agreed: true,
  phase: "readback",
  stoppedAt: null,
  minutes: 30,
  facts,
  out: 0,
  confirmed: facts,
  rating: null,
  typed: false,
  interviewer: null,
});

/** When the interviews started, and every link went out. */
const started = "2026-10-05T07:00:00.000Z";

/** Someone in `team`. */
const person = (id: string, team: string) => ({
  id,
  name: `Person ${id}`,
  email: `${id}@acme.test`,
  team,
  title: "",
  away: false,
});

/** The link `id` was sent at the interviews' start, and where they stand. */
const link = (id: string, state: "completed" | "opened") => ({
  person: id,
  sentAt: started,
  openedAt: started,
  remindedAt: null,
  deletedAt: null,
  state,
});

/**
 * A company told about its interviews, with two teams taking part and one
 * that doesn't: in Sales two people agreed to theirs (6 and 4 facts), in
 * Operations nobody has yet.
 */
const heardSnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  const at = "2026-10-06T09:00:00.000Z";
  return {
    ...empty,
    roster: {
      teams: [
        { id: "sales", name: "Sales", lead: "lisa", does: "", off: false },
        { id: "ops", name: "Operations", lead: "otto", does: "", off: false },
        { id: "legal", name: "Legal", lead: null, does: "", off: true },
      ],
      people: [
        person("lisa", "sales"),
        person("tom", "sales"),
        person("otto", "ops"),
        person("lena", "legal"),
      ],
    },
    plan: { start: "2026-10-05", days: 14, at: started },
    agreed: true,
    told: true,
    mapped: ["sales", "ops"],
    links: [
      link("lisa", "completed"),
      link("tom", "completed"),
      link("otto", "opened"),
    ],
    interviews: [
      agreedInterview("lisa", "lead", 6, at),
      agreedInterview("tom", "own", 4, at),
    ],
    gate: { ...empty.gate, known: 42 },
  };
};

/** The cells of the row of the team named `team`, as text. */
const teamRowOf = (html: string, team: string): string[] => {
  const at = html.indexOf(`>${team}`, html.indexOf("Team by team"));
  if (at === -1) {
    return [];
  }
  const row = html.slice(
    html.lastIndexOf("<tr", at),
    html.indexOf("</tr>", at)
  );
  return [...row.matchAll(/<td[^>]*>(?<cell>[\s\S]*?)<\/td>/gu)].map(
    ({ groups }) =>
      (groups?.cell ?? "")
        .replaceAll(/<[^>]+>/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim()
  );
};

/**
 * The first key figure after a label: the kit's `Stat`, by the slot it
 * names itself with, however the page lays it out around it.
 */
const statAfterLabel = /data-slot="stat"[^>]*>(?<value>[^<]*)</u;

describe("an organization's brain", () => {
  useStoreSecrets({ deployer: token });

  it("counts what the brain stands on, team by team, and says the brain itself isn't shared", async () => {
    const acme = await liveClient();
    acme.account.admin = heardSnapshot("Acme");

    const { status, html } = await page(
      `/organizations/${acme.clientId}/brain`
    );
    const numbers = html.slice(
      html.indexOf('aria-label="The brain in numbers"'),
      html.indexOf("</section>", html.indexOf("The brain in numbers"))
    );
    const figureOf = (label: string): string => {
      const at = numbers.indexOf(`>${label}</span>`);
      return at === -1
        ? ""
        : (statAfterLabel.exec(numbers.slice(at))?.groups?.value ?? "");
    };

    expect({
      status,
      toCome: html.includes("This section isn’t in the admin yet."),
      figures: [
        "Known",
        "Teams heard",
        "Agreed interviews",
        "Facts agreed to",
        "Still open",
      ].map(figureOf),
      opensAt: numbers.includes("Opens at 80%"),
      notShared: html.includes(
        `${acme.name} doesn’t share its brain with Grasp’s staff, so only its counts show here.`
      ),
      // Core counts what is known as one number: no source's share is made up.
      sources: html.includes("How much of each source is in"),
      sourcesWhy: html.includes(
        "The company’s own Grasp counts what is known as one number"
      ),
      teams: {
        sales: teamRowOf(html, "Sales"),
        operations: teamRowOf(html, "Operations"),
        legal: teamRowOf(html, "Legal"),
      },
    }).toStrictEqual({
      status: 200,
      toCome: false,
      figures: ["42%", "1 of 2", "2", "10", "0"],
      opensAt: true,
      notShared: true,
      sources: false,
      sourcesWhy: true,
      teams: {
        sales: ["Sales", "2 of 2", "10", "–", "0"],
        operations: ["Operations", "0 of 1", "0", "–", "0"],
        legal: ["Legal Does not take part", "–", "0", "–", "0"],
      },
    });
  });

  it("warns of the teams not heard once the interviews have closed", async () => {
    const acme = await liveClient();
    const heard = heardSnapshot("Acme");
    // Two weeks from January: long closed, before anyone talked.
    acme.account.admin = {
      ...heard,
      plan: { start: "2026-01-05", days: 14, at: "2026-01-05T07:00:00.000Z" },
    };

    const { html } = await page(`/organizations/${acme.clientId}/brain`);
    const numbers = html.slice(
      html.indexOf('aria-label="The brain in numbers"'),
      html.indexOf("</section>", html.indexOf("The brain in numbers"))
    );

    expect(
      numbers.includes("2 teams not heard before the interviews closed")
    ).toBeTruthy();
  });

  it("says a company without teams yet has none, with nothing counted", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");

    const { status, html } = await page(
      `/organizations/${acme.clientId}/brain`
    );

    expect({
      status,
      noTeams: html.includes("No teams yet: they come with who works where."),
      table: html.includes("<table"),
      teamsHeard: html.includes(">0 of 0<"),
    }).toStrictEqual({
      status: 200,
      noTeams: true,
      table: false,
      teamsHeard: true,
    });
  });
});
