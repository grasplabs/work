import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env, exports } from "cloudflare:workers";
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

const token = "test-deployer-token-admin-frame-3b7e21";
const tenantToken = "test-tenant-admin-token-admin-frame-8d0f54";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A client recorded as `status`, on a new account in the fake. */
const recordClient = async (
  status: "provisioning" | "active",
  clientId = `client-${crypto.randomUUID().slice(0, 8)}`
) => {
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
        status,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return { clientId, name: `Acme ${clientId}`, account };
};

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): the frame" });
  await importReleases(env.RELEASES, db);
  const client = await recordClient("active");
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, client.clientId, release.id)
  );
  return client;
};

/**
 * A company whose first conversation Stephen read and of which 85% is
 * known, past the 80% it opens at, with nothing signed yet: as the model
 * has it, at the agreements, ready for Grasp's go, and with four things
 * that need Grasp (the go and both agreements; its contract core doesn't
 * hold, so nothing is known of it).
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
 * A company told `daysIn` days ago, on a plan of `days` days, with one
 * team: its lead Lisa and Tom, both sent their link; Lisa has talked
 * when `leadTalked`.
 */
const toldSnapshot = (
  name: string,
  {
    days,
    daysIn,
    leadTalked,
  }: { days: number; daysIn: number; leadTalked: boolean }
): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  const at = (back: number, hour: number) =>
    new Date(
      Date.parse(empty.now) - back * 86_400_000 + hour * 3_600_000
    ).toISOString();
  const told = at(daysIn, 0);
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
    plan: { start: told.slice(0, 10), days, at: told },
    agreements: { processing: true, assessment: true, council: "none" },
    agreed: true,
    told: true,
    links: ["lisa", "tom"].map((person) => ({
      person,
      sentAt: told,
      openedAt: null,
      remindedAt: null,
      deletedAt: null,
      state: person === "lisa" && leadTalked ? "completed" : "waiting",
    })),
    interviews: leadTalked
      ? [
          {
            person: "lisa",
            kind: "lead",
            startedAt: at(daysIn, 1),
            completedAt: at(daysIn, 2),
            updatedAt: at(daysIn, 2),
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
        ]
      : [],
  };
};

/** The overview's row for client `clientId`, in its table of organizations. */
const rowOf = (html: string, clientId: string): string => {
  const table = html.indexOf("<table");
  const at = html.indexOf(`href="/admin/organizations/${clientId}"`, table);
  return at === -1 || table === -1
    ? ""
    : html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
};

/** The text of `html` between the admin's sidebar and the page beside it. */
const sidebarOf = (html: string): string =>
  html.slice(html.indexOf('data-slot="sidebar"'), html.indexOf("<main"));

describe("the admin's frame", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // Only each test's own clients are listed: an earlier test's accounts
  // are gone from the fake, and the overview counts every client.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("gives staff the admin's own sidebar with every organization, one not read now marked as such, and no console bar", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");
    const down = await liveClient();
    down.account.unhealthy = 1000;
    const waiting = await recordClient("provisioning");

    const { status, html } = await page("/admin/platform");
    const sidebar = sidebarOf(html);

    const places = [
      "Overview",
      "Integrations to build",
      "Platform",
      "Ask Grasp",
      "Sources",
      "Stephen Lab",
      "Organizations",
      "Back to the console",
    ].map((text) => sidebar.indexOf(text));
    const [organizations = -1, back = -1] = places.slice(-2);
    /** Where `name` is in the sidebar, and what its entry says besides. */
    const entryOf = (name: string) => {
      const at = sidebar.indexOf(name);
      return {
        // Under the organizations' label and above the way back.
        listed: at > organizations && at < back,
        entry: sidebar.slice(at, sidebar.indexOf("</li>", at)),
      };
    };
    const [acmeEntry, downEntry, waitingEntry] = [acme, down, waiting].map(
      ({ name }) => entryOf(name)
    );

    expect({
      status,
      // Every place, in the prototype's order, the way back last.
      placesInOrder:
        places.every((position) => position >= 0) &&
        places.toSorted((a, b) => a - b).every((at, i) => at === places[i]),
      listed: [acmeEntry, downEntry, waitingEntry].map((each) => each?.listed),
      acmeUnread: acmeEntry?.entry.includes("unreachable"),
      downUnreachable: downEntry?.entry.includes("unreachable"),
      waitingNotDeployed: waitingEntry?.entry.includes("not deployed"),
      opensAcme: html.includes(`href="/admin/organizations/${acme.clientId}"`),
      // Its mark explains itself while the sidebar is open, too.
      downExplained: downEntry?.entry.includes('data-slot="tooltip-trigger"'),
      // The console's own bar is not part of the admin.
      consoleBar: html.includes('aria-label="Console"'),
      readers: acme.account.adminReaders,
    }).toStrictEqual({
      status: 200,
      placesInOrder: true,
      listed: [true, true, true],
      acmeUnread: false,
      downUnreachable: true,
      waitingNotDeployed: true,
      opensAcme: true,
      downExplained: true,
      consoleBar: false,
      readers: ["staff@grasp.test"],
    });
  });

  it("lists every organization on the overview: one that answered with where it stands and what needs Grasp, one that didn't with why and no numbers", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const down = await liveClient();
    down.account.unhealthy = 1000;
    const waiting = await recordClient("provisioning");

    const { status, html } = await page("/admin");
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
      // Fees and hours core doesn't hold yet are not known, not nothing.
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
      unknownSums: [true, true],
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
    paused.account.admin = {
      ...told,
      paused: true,
      gate: { ...told.gate, threshold: 98 },
    };

    const { html } = await page("/admin");
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
        client.account.admin = readySnapshot(name);
        return client;
      })
    );

    const { html } = await page("/admin");
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

  it("counts only leads who talked, and the days of each company's own plan", async () => {
    const waiting = await liveClient();
    waiting.account.admin = toldSnapshot("Waiting", {
      days: 21,
      daysIn: 3,
      leadTalked: false,
    });
    const talking = await liveClient();
    talking.account.admin = toldSnapshot("Talking", {
      days: 21,
      daysIn: 3,
      leadTalked: true,
    });

    const { html } = await page("/admin");
    const main = html.slice(html.indexOf("<main"));

    expect({
      // Tom's link went out without Lisa: she still hasn't talked.
      waiting: rowOf(main, waiting.clientId).includes("0 of 1 talked"),
      // Three weeks, as its plan has it.
      talking: rowOf(main, talking.clientId).includes(" of 21. "),
    }).toStrictEqual({ waiting: true, talking: true });
  });

  it("shows only the organizations in a phase when one is chosen", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const empty = await liveClient();
    empty.account.admin = emptyAdminSnapshot("Empty");
    const waiting = await recordClient("provisioning");

    const ready = await page("/admin?phase=ready");
    const agreements = await page("/admin?phase=agreements");
    const rows = (html: string) =>
      [acme, empty, waiting].map(
        ({ clientId }) => rowOf(html, clientId) !== ""
      );

    expect({
      ready: rows(ready.html),
      agreements: rows(agreements.html),
    }).toStrictEqual({
      ready: [true, false, false],
      agreements: [false, true, false],
    });
  });

  it("opens an organization the console knows, and has no page for one it doesn't", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");

    // Named like one of the admin's sections, and still its own page.
    const platform = await recordClient("provisioning", "platform");

    const known = await page(`/admin/organizations/${acme.clientId}`);
    const named = await page("/admin/organizations/platform");
    const unknown = await page("/admin/organizations/client-unknown");

    expect({
      known: known.status,
      title: known.html.includes(`${acme.name}</h1>`),
      named: named.status,
      namedTitle: named.html.includes(`${platform.name}</h1>`),
      unknown: unknown.status,
    }).toStrictEqual({
      known: 200,
      title: true,
      named: 200,
      namedTitle: true,
      unknown: 404,
    });
  });

  it("gives a request Access doesn't vouch for nothing, asking no core", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");

    const answers = await Promise.all(
      [
        "/admin",
        "/admin?phase=ready",
        "/admin/platform",
        `/admin/organizations/${acme.clientId}`,
      ].map(async (path) => {
        const response = await exports.default.fetch(
          `https://console.grasp.test${path}`
        );
        return { status: response.status, body: await response.text() };
      })
    );

    expect({
      answers,
      readers: acme.account.adminReaders,
    }).toStrictEqual({
      answers: [403, 403, 403, 403].map((status) => ({
        status,
        body: "Forbidden",
      })),
      readers: [],
    });
  });
});
