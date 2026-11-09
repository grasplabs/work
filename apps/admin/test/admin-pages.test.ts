import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { clientDeploys, clients } from "../src/db/schema.ts";
import { pinClient } from "../src/rollout/channels.ts";
import { mockAccess } from "./access.ts";
import {
  cloudflare,
  token,
  db,
  tags,
  spaces,
  daysAgo,
  staff,
  recordClient,
  liveClient,
  readySnapshot,
  toldSnapshot,
  rowOf,
  sidebarOf,
} from "./admin-frame.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: the sidebar, the table of apps asked for, the overview and today's
// list; the overview's counts and filters in admin-pages-overview.test.ts,
// an organization's page in admin-pages-organization.test.ts and its
// sections in admin-pages-sections.test.ts.

mockCloudflareApi(token, cloudflare);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

describe("the admin's frame", () => {
  useStoreSecrets({ deployer: token });
  // Only each test's own clients are listed: an earlier test's accounts
  // are gone from the fake, and the overview counts every client.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("gives staff the admin's own sidebar with every organization, one not read now marked as such, and no admin bar", async () => {
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");
    const down = await liveClient();
    down.core.unhealthy = 1000;
    const waiting = await recordClient("provisioning");

    const { status, html } = await page("/platform");
    const sidebar = sidebarOf(html);

    const places = [
      "Overview",
      "Apps asked for",
      "Platform",
      "Ask Grasp",
      "Stephen Lab",
      "Organizations",
    ].map((text) => sidebar.indexOf(text));
    const [organizations = -1] = places.slice(-1);
    /** Where `name` is in the sidebar, and what its entry says besides. */
    const entryOf = (name: string) => {
      const at = sidebar.indexOf(name);
      return {
        // Under the organizations' label.
        listed: at > organizations,
        entry: sidebar.slice(at, sidebar.indexOf("</li>", at)),
      };
    };
    const [acmeEntry, downEntry, waitingEntry] = [acme, down, waiting].map(
      ({ name }) => entryOf(name)
    );

    expect({
      status,
      // Every place, in the prototype's order, the organizations last.
      placesInOrder:
        places.every((position) => position >= 0) &&
        places.toSorted((a, b) => a - b).every((at, i) => at === places[i]),
      listed: [acmeEntry, downEntry, waitingEntry].map((each) => each?.listed),
      acmeUnread: acmeEntry?.entry.includes("unreachable"),
      downUnreachable: downEntry?.entry.includes("unreachable"),
      waitingNotDeployed: waitingEntry?.entry.includes("not deployed"),
      opensAcme: html.includes(`href="/organizations/${acme.clientId}"`),
      // Its mark explains itself while the sidebar is open, too.
      downExplained: downEntry?.entry.includes('data-slot="tooltip-trigger"'),
      // The admin is the one frame: no bar of the old console's, and no way
      // back to it.
      oldBar:
        html.includes('aria-label="Console"') ||
        html.includes("Back to the console"),
      readers: acme.core.adminReaders,
    }).toStrictEqual({
      status: 200,
      placesInOrder: true,
      listed: [true, true, true],
      acmeUnread: false,
      downUnreachable: true,
      waitingNotDeployed: true,
      opensAcme: true,
      downExplained: true,
      oldBar: false,
      readers: ["staff@grasp.test"],
    });
  });

  it("says nothing is asked for yet where the table of apps goes, with nothing to act on", async () => {
    const { status, html } = await page("/integrations");

    expect({
      status,
      title: html.includes(">Apps asked for</h1>"),
      nothingAsked: html.includes("Nothing asked for yet"),
      table: html.includes("<table"),
      buttons: html
        .slice(html.indexOf(">Apps asked for</h1>"))
        .includes("<button"),
    }).toStrictEqual({
      status: 200,
      title: true,
      nothingAsked: true,
      table: false,
      buttons: false,
    });
  });

  it("lists every app the companies asked Grasp for once, most asked first, and every company's request leading to it", async () => {
    const acme = await liveClient();
    const globex = await liveClient();
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- the test's own, kept beside it; it reads the shared harness
    const asked = (name: string, ago: number) => ({
      id: crypto.randomUUID(),
      name,
      askedAt: daysAgo(ago),
    });
    // Two companies ask for Exact Online, spelled their own way; one asks
    // for Twinfield first.
    acme.core.admin = {
      ...readySnapshot("Acme"),
      asked: [asked("Twinfield", 9), asked("Exact Online", 4)],
    };
    globex.core.admin = {
      ...readySnapshot("Globex"),
      asked: [asked("exact  online", 2)],
    };

    const { status, html } = await page("/integrations");
    const company = await page(
      `/organizations/${globex.clientId}/integrations`
    );
    const text = html.replaceAll(tags, " ").replaceAll(spaces, " ");
    const exact = text.indexOf("Exact Online");
    const twinfield = text.indexOf("Twinfield");
    const rowText = (key: string) => {
      const at = html.indexOf(`href="/integrations?app=${key}"`);
      return at === -1
        ? ""
        : html
            .slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at))
            .replaceAll(tags, " ")
            .replaceAll(spaces, " ");
    };

    expect({
      status: [status, company.status],
      // Once each, the one two companies asked for first.
      rows: (html.match(/<tr/gu) ?? []).length - 1,
      order: exact !== -1 && twinfield > exact,
      exact: rowText("exact-online").includes(
        `Acme ${acme.clientId} and Acme ${globex.clientId}`
      ),
      twinfield: rowText("twinfield").includes(`Acme ${acme.clientId}`),
      sidebar: sidebarOf(html).includes("2 apps asked for"),
      nothingAsked: html.includes("Nothing asked for yet"),
      // Its own request, on the company's Integrations, leads to the app.
      companyAsked: company.html.includes(
        `href="/integrations?app=exact-online"`
      ),
      companyWords: company.html.includes("Asked of Grasp"),
    }).toStrictEqual({
      status: [200, 200],
      rows: 2,
      order: true,
      exact: true,
      twinfield: true,
      sidebar: true,
      nothingAsked: false,
      companyAsked: true,
      companyWords: true,
    });
  });

  it("lists every organization on the overview: one that answered with where it stands and what needs Grasp, one that didn't with why and no numbers", async () => {
    const acme = await liveClient();
    acme.core.admin = readySnapshot("Acme");
    const down = await liveClient();
    down.core.unhealthy = 1000;
    const waiting = await recordClient("provisioning");

    const { status, html } = await page("/");
    const main = html.slice(html.indexOf("<main"));
    const [acmeRow, downRow, waitingRow] = [acme, down, waiting].map(
      ({ clientId }) => rowOf(main, clientId)
    );
    const acmeEntry = sidebarOf(html).slice(sidebarOf(html).indexOf(acme.name));

    expect({
      status,
      title: main.includes("Organizations</h1>"),
      // Where Acme stands, as the model works it out of its snapshot.
      acme: [
        "Agreed",
        "Not signed yet",
        "85% known. Ready for Grasp’s go",
        "Not known yet",
        'text-status-attention tabular-nums">3<',
      ].map((text) => acmeRow?.includes(text)),
      acmeNamed: acmeRow?.includes(acme.name),
      // What needs Grasp at Acme, said, and a way to it.
      goToGive: main.includes(
        "85% of what Grasp needs is known: enough to open at 80%. The company comes in once Grasp gives its go."
      ),
      // The model has no such need for a company that answered nothing.
      noTranscript: !main.includes("Bring in the first conversation"),
      // A core that didn't answer says why, and nothing the model would.
      down: {
        named: downRow?.includes(down.name),
        why: downRow?.includes("Unreachable"),
        numbers: ["% known", "Being written", "€"].some((text) =>
          (downRow ?? "").includes(text)
        ),
      },
      waiting: {
        named: waitingRow?.includes(waiting.name),
        why: waitingRow?.includes("Not deployed"),
        numbers: ["% known", "Being written", "€"].some((text) =>
          (waitingRow ?? "").includes(text)
        ),
      },
      // Only Acme is counted in the numbers above the list.
      counted: main.includes(
        "Counted from the 1 that answered now: 2 didn’t, and aren’t in these numbers."
      ),
      // Fees core doesn't hold yet are not known, not nothing; the hours
      // freed are counted from the work core sends.
      unknownSums: ["a month under contract", "hours a week freed"].map(
        (label) => {
          const tile = main.slice(0, main.indexOf(label));
          return tile.slice(tile.lastIndexOf("<div")).includes("—");
        }
      ),
      // In the sidebar, how many things need Grasp at Acme.
      acmeCount: acmeEntry
        .slice(0, acmeEntry.indexOf("</li>"))
        .includes('3<span class="sr-only">things need Grasp</span>'),
    }).toStrictEqual({
      status: 200,
      title: true,
      acme: [true, true, true, true, true],
      acmeNamed: true,
      goToGive: true,
      noTranscript: true,
      down: { named: true, why: true, numbers: false },
      waiting: { named: true, why: true, numbers: false },
      counted: true,
      unknownSums: [true, false],
      acmeCount: true,
    });
  });

  it("says when Grasp paused the interviews, and marks where Grasp opens even at the last dot", async () => {
    const paused = await liveClient();
    const told = toldSnapshot("Paused", {
      days: 14,
      daysIn: 3,
      leadTalked: true,
    });
    paused.core.admin = {
      ...told,
      paused: true,
      gate: { ...told.gate, threshold: 98 },
    };

    const { html } = await page("/");
    const main = html.slice(html.indexOf("<main"));
    const row = rowOf(main, paused.clientId);

    expect({
      paused: main.includes(
        "The interviews are paused: nobody can open or finish theirs until Grasp resumes them."
      ),
      // The one mark where Grasp opens, after the last of the dots.
      marks: row.split("h-3.5 w-px").length - 1,
    }).toStrictEqual({ paused: true, marks: 1 });
  });

  it("puts every organization's most pressing need in today's list before any one's next", async () => {
    // Three needs each: nine, past the eight the list shows.
    const companies = await Promise.all(
      ["Acme", "Birch", "Cobalt"].map(async (name) => {
        const client = await liveClient();
        client.core.admin = readySnapshot(name);
        return client;
      })
    );

    const { html } = await page("/");
    const listed = (text: string) => {
      const start = html.indexOf("Needs Grasp today");
      return html
        .slice(start, html.indexOf("</section>", start))
        .includes(text);
    };

    expect(
      companies.map(({ name }) => listed(`Open at ${name}:`))
    ).toStrictEqual([true, true, true]);
  });

  it("puts a live organization's failed deploy and its falling behind first in today's list, each opening its Setup", async () => {
    const failing = await liveClient();
    failing.core.admin = readySnapshot("Failing");
    // Its deploy of a newer release failed, and nobody retried it.
    const next = await placedRelease("feat(core): failed to deploy");
    const now = new Date();
    await db.insert(clientDeploys).values({
      clientId: failing.clientId,
      releaseId: next,
      runId: `run-${crypto.randomUUID()}`,
      status: "failed",
      error: "attempt_lost: core",
      startedAt: now,
      endedAt: now,
    });
    // Three releases on, pinned to the last: three behind.
    await placedRelease("feat(core): one on");
    const last = await placedRelease("feat(core): three on");
    await pinClient(env, staff, {
      clientId: failing.clientId,
      releaseId: last,
    });
    const current = await liveClient();
    current.core.admin = readySnapshot("Current");

    const { html } = await page("/");
    const start = html.indexOf("Needs Grasp today");
    const section = html.slice(start, html.indexOf("</section>", start));
    // Each item of the list, as its words and where it opens.
    const items = section
      .split("<li")
      .slice(1)
      .map((item) => ({
        text: item.replaceAll(tags, " ").replaceAll(spaces, " "),
        setup: item.includes("/setup"),
      }));
    const at = (name: string) =>
      items.filter(({ text }) => text.includes(`${name} `));

    expect({
      // Its own platform first, then what its core says; both open its Setup.
      failing: at(failing.name)
        .slice(0, 2)
        .map(({ text, setup }) => ({
          deploy: text.includes(
            `Its deploy of ${next} failed (attempt_lost: core). Retry it on its Setup once what stopped it is fixed.`
          ),
          behind: text.includes(
            "It runs 3 releases behind the one it should. Look at its Setup."
          ),
          setup,
        })),
      // A client on its release has neither.
      current: at(current.name).some(({ setup }) => setup),
    }).toStrictEqual({
      failing: [
        { deploy: true, behind: false, setup: true },
        { deploy: false, behind: true, setup: true },
      ],
      current: false,
    });
  });
});
