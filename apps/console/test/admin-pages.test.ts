import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env, exports } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

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

const token = "test-deployer-token-admin-frame-3b7e21";
const tenantToken = "test-tenant-admin-token-admin-frame-8d0f54";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const tags = /<[^>]*>/gu;
const spaces = /\s+/gu;

/** The moment `ago` days before now. */
const daysAgo = (ago: number) =>
  new Date(Date.now() - ago * 86_400_000).toISOString();
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

/** An organization's column of sections, named `name`; empty when the page has none. */
const columnOf = (html: string, name: string): string => {
  const at = html.indexOf(`<nav aria-label="${name}"`);
  return at === -1 ? "" : html.slice(at, html.indexOf("</nav>", at));
};

/** The entry titled `title` in a column: from its link's start to its end. */
const columnEntryOf = (column: string, title: string): string => {
  const at = column.indexOf(`>${title}</span>`);
  return at === -1
    ? ""
    : column.slice(column.lastIndexOf("<a", at), column.indexOf("</a>", at));
};

/** What an Integrations section says, part by part. */
const integrationsOf = ({
  status,
  html,
}: {
  status: number;
  html: string;
}) => ({
  status,
  nothing: html.includes("Nothing connected yet</h2>"),
  waits: html.includes("Grasp waits on the company’s own admin."),
  connected: html.includes("What the company connected</h2>"),
  notReported: html.includes(
    "The company’s own Grasp doesn’t report what it connected yet."
  ),
  stillToConnect: html.includes("Still to connect</h2>"),
  needsNotReported: html.includes(
    "The company’s own Grasp doesn’t report what its workflows need yet."
  ),
  source: html.includes(
    "What the company connected: the company’s own Grasp doesn’t hold it yet. What its workflows still need connected: from Composio, once it is connected."
  ),
  toCome: html.includes("This section isn’t in the console yet."),
});

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

  it("says there is nothing to build yet where the integrations' table goes, and how a build goes, with no build to move on", async () => {
    const { status, html } = await page("/admin/integrations");
    const text = html.replaceAll(tags, " ").replaceAll(spaces, " ");
    const steps = [
      "A company’s workflow needs an app Composio does not have.",
      "Build it starts Grasp’s agent on a branch of its own.",
      "A person registers Grasp with the app and puts the keys in the console.",
      "The agent writes the connection and its tests",
      "The merge goes into the next release",
    ].map((step) => text.indexOf(step));

    expect({
      status,
      title: html.includes(">Integrations to build</h1>"),
      nothingToBuild: html.includes("Nothing to build yet"),
      howItIsBuilt: html.includes(">How it is built</h2>"),
      stepsInOrder:
        steps.every((at) => at >= 0) &&
        steps.toSorted((a, b) => a - b).every((at, i) => at === steps[i]),
      // No sample builds, and nothing that would move one on.
      table: html.includes("<table"),
      buttons: html
        .slice(html.indexOf(">Integrations to build</h1>"))
        .includes("<button"),
      // Connect signs in with OAuth2 and API keys now (GRA-688).
      firstByHand: text.includes("First, by hand"),
    }).toStrictEqual({
      status: 200,
      title: true,
      nothingToBuild: true,
      howItIsBuilt: true,
      stepsInOrder: true,
      table: false,
      buttons: false,
      firstByHand: false,
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

  it("counts an organization's days to its own plan beside its page", async () => {
    const company = await liveClient();
    company.account.admin = toldSnapshot("Company", {
      days: 21,
      daysIn: 3,
      leadTalked: true,
    });

    const { status, html } = await page(
      `/admin/organizations/${company.clientId}`
    );

    expect({
      status,
      days: /Day (?:<!-- -->)?\d+(?:<!-- -->)? of (?:<!-- -->)?21/u.test(html),
    }).toStrictEqual({
      status: 200,
      days: true,
    });
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

  it("offers to add an organization from the overview: by hand, with Attio and Rooms shown but not yet to start from, on the newest release", async () => {
    await publishRelease({ notes: "feat(core): older" });
    const newest = await publishRelease({ notes: "feat(core): newest" });
    await importReleases(env.RELEASES, db);

    const overview = await page("/admin");
    const { status, html } = await page("/admin/new-organization");
    const main = html.slice(html.indexOf("<main"));
    /** The choice `label` makes, up to the next one. */
    const choiceOf = (label: string): string => {
      const at = main.indexOf(label);
      const start = main.lastIndexOf("<label", at);
      return main.slice(start, main.indexOf("</label>", at));
    };
    const [hand, attio, rooms] = [
      "By hand",
      "A deal won in Attio",
      "A proposal signed in Rooms",
    ].map((label) => {
      const choice = choiceOf(label);
      return {
        chosen: choice.includes('aria-checked="true"'),
        disabled: choice.includes('aria-disabled="true"'),
      };
    });
    const selected = main.slice(
      main.lastIndexOf("<option", main.indexOf(" selected")),
      main.indexOf("</option>", main.indexOf(" selected"))
    );

    expect({
      link: overview.html.includes('href="/admin/new-organization"'),
      status,
      title: main.includes("New organization</h1>"),
      choices: { hand, attio, rooms },
      why: [
        "Not yet: the console isn&#x27;t connected to Attio.",
        "Not yet: the console isn&#x27;t connected to Rooms.",
      ].map((text) => main.includes(text)),
      fields: [
        "name",
        "clientId",
        "admins",
        "domains",
        "entraTenantId",
        "googleHostedDomain",
        "releaseId",
        "ring",
        "accountId",
      ].every((field) => main.includes(`name="${field}"`)),
      newest: selected.includes(`value="${newest.id}"`),
    }).toStrictEqual({
      link: true,
      status: 200,
      title: true,
      choices: {
        hand: { chosen: true, disabled: false },
        attio: { chosen: false, disabled: true },
        rooms: { chosen: false, disabled: true },
      },
      why: [true, true],
      fields: true,
      newest: true,
    });
  });

  it("lays out an organization as the prototype does: its column of sections in order, what waits where, and where the overview comes from", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");

    const { status, html } = await page(
      `/admin/organizations/${acme.clientId}`
    );
    const column = columnOf(html, acme.name);
    const titles = [
      "Overview",
      "Company",
      "Details",
      "Contract",
      "Members",
      "Onboarding",
      "Steps",
      "Organization",
      "Interviews",
      "Workflows",
      "Platform",
      "Setup",
      "Integrations",
      "AI use",
      "Hours",
      "Records",
      "Brain",
      "Data",
      "Log",
    ];
    const positions = titles.map((title) => column.indexOf(`>${title}</span>`));

    expect({
      status,
      inOrder:
        positions.every((at) => at >= 0) &&
        positions
          .toSorted((a, b) => a - b)
          .every((at, i) => at === positions[i]),
      // The overview is where the page is, under the company's own name.
      onOverview: columnEntryOf(column, "Overview").includes(
        'aria-current="page"'
      ),
      title: html.includes(`${acme.name}</h1>`),
      known: column.includes("85% known. Ready for Grasp’s go"),
      // The go and the agreements wait under Steps; a contract core doesn't hold waits nowhere.
      waits: ["Steps", "Contract", "Members", "Interviews"].map((title) =>
        columnEntryOf(column, title).includes("Something waits for Grasp")
      ),
      source: html.includes("From the company’s own Grasp."),
      // Every need of Acme, with where it is settled; none for a contract nobody knows of yet.
      needs: [
        "85% of what Grasp needs is known: enough to open at 80%. The company comes in once Grasp gives its go.",
        "The contract is still being written.",
      ].map((text) => html.includes(text)),
      opensContract: html.includes(
        `href="/admin/organizations/${acme.clientId}/contract"`
      ),
    }).toStrictEqual({
      status: 200,
      inOrder: true,
      onOverview: true,
      title: true,
      known: true,
      waits: [true, false, false, false],
      source: true,
      needs: [true, false],
      opensContract: true,
    });
  });

  it("says the interviews closed on the last day their links worked", async () => {
    const closed = await liveClient();
    const snapshot = toldSnapshot("Closed", {
      days: 5,
      daysIn: 10,
      leadTalked: true,
    });
    closed.account.admin = snapshot;
    // Five days from day 0: the links worked until the fifth, day 4.
    const last = new Date(`${snapshot.plan?.start ?? ""}T12:00:00Z`);
    last.setUTCDate(last.getUTCDate() + 4);

    const { html } = await page(`/admin/organizations/${closed.clientId}`);

    expect(
      html.includes(
        `The interviews closed on ${formatDate(last.toISOString().slice(0, 10))}`
      )
    ).toBeTruthy();
  });

  it("sends what needs Grasp at a paused organization to its steps", async () => {
    const paused = await liveClient();
    paused.account.admin = {
      ...toldSnapshot("Paused", { days: 14, daysIn: 3, leadTalked: true }),
      paused: true,
    };

    const { status, html } = await page(
      `/admin/organizations/${paused.clientId}`
    );
    const main = html.slice(html.indexOf("<main"));
    const at = main.indexOf("The interviews are paused");
    const item = at === -1 ? "" : main.slice(at, main.indexOf("</li>", at));

    expect({
      status,
      paused: at !== -1,
      toSteps: item.includes(
        `href="/admin/organizations/${paused.clientId}/steps"`
      ),
    }).toStrictEqual({ status: 200, paused: true, toSteps: true });
  });

  it("shows a section under its own path, titled, saying where what it shows comes from", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const base = `/admin/organizations/${acme.clientId}`;

    const contract = await page(`${base}/contract`);
    const usage = await page(`${base}/ai-use`);
    const setup = await page(`${base}/setup`);

    expect({
      statuses: [contract, usage, setup].map(({ status }) => status),
      contract: {
        title: contract.html.includes("Contract</h1>"),
        about: contract.html.includes(
          "What was signed, what it gives the company, and what is billed."
        ),
        // Core holds no contract yet: it comes from Rooms and Stripe.
        source: contract.html.includes(
          "The contract: from Rooms, once it is connected. Its invoices: from Stripe, once it is connected."
        ),
        current: columnEntryOf(
          columnOf(contract.html, acme.name),
          "Contract"
        ).includes('aria-current="page"'),
        overviewCurrent: columnEntryOf(
          columnOf(contract.html, acme.name),
          "Overview"
        ).includes('aria-current="page"'),
      },
      usage: [
        usage.html.includes("AI use</h1>"),
        usage.html.includes("From the company’s own Grasp."),
      ],
      setup: [
        setup.html.includes("Setup</h1>"),
        setup.html.includes("From this console."),
      ],
    }).toStrictEqual({
      statuses: [200, 200, 200],
      contract: {
        title: true,
        about: true,
        source: true,
        current: true,
        overviewCurrent: false,
      },
      usage: [true, true],
      setup: [true, true],
    });
  });

  it("says nothing is known of a contract core doesn't hold, with no draft or fee, beside the agreements as core has them", async () => {
    const acme = await liveClient();
    const empty = emptyAdminSnapshot("Acme");
    acme.account.admin = {
      ...empty,
      agreements: {
        processing: true,
        assessment: false,
        council: "waiting",
        processingOn: "2026-09-02",
      },
      members: [
        {
          userId: "user-anna",
          name: "Anna",
          email: "anna@acme.test",
          role: "admin",
          joinedAt: "2026-09-03T09:00:00.000Z",
        },
        {
          userId: "user-bram",
          name: "Bram",
          email: "bram@acme.test",
          role: "user",
          joinedAt: "2026-09-04T09:00:00.000Z",
        },
      ],
    };

    const { status, html } = await page(
      `/admin/organizations/${acme.clientId}/contract`
    );
    /** The part of the page titled `title`, up to the next part. */
    const partOf = (title: string): string => {
      const at = html.indexOf(`>${title}</h2>`);
      return at === -1 ? "" : html.slice(at, html.indexOf("</section>", at));
    };
    /** The agreement named `name`, up to the next one. */
    const agreementOf = (name: string): string => {
      const part = partOf("Agreed before the first interview");
      const at = part.indexOf(name);
      return at === -1 ? "" : part.slice(at, part.indexOf("</li>", at));
    };

    expect({
      status,
      toCome: html.includes("This section isn’t in the console yet."),
      summary: {
        contract: html.includes("Not known yet"),
        // Core holds no contract: it is neither a draft nor a fee of nothing.
        draft: ["Being written", "not sent yet", "€0"].some((text) =>
          html.includes(text)
        ),
        seats: html.includes("taken; the contract isn’t known yet"),
        runs: html.includes("Still runs"),
        fee: html.includes("Fee a month"),
      },
      terms: [
        partOf("The terms").includes(
          "Nothing is known about the contract yet."
        ),
        partOf("The terms").includes(
          "Once Rooms is connected, this fills in by itself."
        ),
      ],
      gives: [
        partOf("What it gives the company").includes(
          "Not known yet; 2 are taken."
        ),
        // What the model works out of AI use isn't what was used: the AI use section says what it is.
        partOf("What it gives the company").includes("was used this month"),
      ],
      agreements: {
        open: partOf("Agreed before the first interview").includes(
          "Without all three, nobody is invited. 2 are still open."
        ),
        processing: agreementOf("Agreement on handling data").includes(
          "In place since 2 Sep 2026"
        ),
        assessment: agreementOf(
          "The company’s look at the risks to its people"
        ).includes("Not signed yet"),
        council: agreementOf("Works council").includes("Still deciding"),
        others: partOf("Agreed before the first interview").includes(
          "Who else handles the data"
        ),
      },
      invoices: partOf("Invoices").includes(
        "None known yet: nothing is known about the contract."
      ),
    }).toStrictEqual({
      status: 200,
      toCome: false,
      summary: {
        contract: true,
        draft: false,
        seats: true,
        runs: false,
        fee: false,
      },
      terms: [true, true],
      gives: [true, false],
      agreements: {
        open: true,
        processing: true,
        assessment: true,
        council: true,
        others: true,
      },
      invoices: true,
    });
  });

  it("says the agreements aren't recorded yet while core holds nothing of them, instead of reading that as no works council", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");

    const { html } = await page(
      `/admin/organizations/${acme.clientId}/contract`
    );
    const at = html.indexOf(">Agreed before the first interview</h2>");
    const part =
      at === -1 ? "" : html.slice(at, html.indexOf("</section>", at));

    expect({
      description: part.includes(
        "Nothing is recorded of them yet. Without all three, nobody is invited."
      ),
      notRecorded: part.split("Not recorded yet").length - 1,
      noCouncil: part.includes("No works council"),
    }).toStrictEqual({ description: true, notRecorded: 3, noCouncil: false });
  });

  it("shows what a company connected only once it signed in, says core doesn't report its connections yet, and that what is still to connect comes from Composio", async () => {
    const before = await liveClient();
    before.account.admin = emptyAdminSnapshot("Before");
    const signed = await liveClient();
    const empty = emptyAdminSnapshot("Signed");
    // Its directory is in, with every team's lead named: past its sign-in.
    signed.account.admin = {
      ...empty,
      roster: {
        teams: [
          { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
        ],
        people: [
          {
            id: "lea",
            name: "Lea Lund",
            email: "",
            team: "sales",
            title: "",
            away: false,
          },
        ],
      },
    };

    const beforePage = await page(
      `/admin/organizations/${before.clientId}/integrations`
    );
    const signedPage = await page(
      `/admin/organizations/${signed.clientId}/integrations`
    );

    expect({
      before: integrationsOf(beforePage),
      signed: integrationsOf(signedPage),
    }).toStrictEqual({
      before: {
        status: 200,
        nothing: true,
        waits: true,
        connected: false,
        notReported: false,
        stillToConnect: true,
        needsNotReported: true,
        source: true,
        toCome: false,
      },
      signed: {
        status: 200,
        nothing: false,
        waits: false,
        connected: true,
        notReported: true,
        stillToConnect: true,
        needsNotReported: true,
        source: true,
        toCome: false,
      },
    });
  });

  it("shows what a company connected, the app a workflow is bound to that isn't connected any more, and the workflow waiting on it", async () => {
    const acme = await liveClient();
    const empty = emptyAdminSnapshot("Acme");
    const crmSync = { id: "workflow-crm", name: "CRM sync" };
    acme.account.admin = {
      ...empty,
      // Past its sign-in: its directory is in, every team's lead named.
      roster: {
        teams: [
          { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
        ],
        people: [
          {
            id: "lea",
            name: "Lea Lund",
            email: "",
            team: "sales",
            title: "",
            away: false,
          },
        ],
      },
      // As core sends it once a workflow's HubSpot was disconnected.
      integrations: {
        connected: [
          {
            source: "composio",
            provider: "google_drive",
            state: "works",
            hidden: false,
            connectedBy: "Anna de Vries",
            connectedAt: daysAgo(3),
            account: null,
            tools: ["GOOGLEDRIVE_LIST_FILES"],
          },
        ],
        personal: [
          { source: "native", provider: "microsoft", people: 4, again: 1 },
        ],
        needed: [
          {
            workflow: crmSync,
            alias: "crm",
            app: { source: "composio", provider: "hubspot" },
            state: "missing",
          },
          { workflow: crmSync, alias: "mail", app: null, state: "unbound" },
        ],
        requests: [
          {
            source: "native",
            provider: "microsoft",
            decidedBy: "person",
            waiting: 2,
            since: daysAgo(1),
          },
        ],
      },
    };

    const integrations = await page(
      `/admin/organizations/${acme.clientId}/integrations`
    );
    const workflows = await page(
      `/admin/organizations/${acme.clientId}/workflows`
    );
    const overview = await page(`/admin/organizations/${acme.clientId}`);

    const { html } = integrations;
    expect({
      status: [integrations.status, workflows.status, overview.status],
      drive: html.includes(
        `Connected by Anna de Vries on ${formatDate(daysAgo(3))}.`
      ),
      microsoft: html.includes("4 people connected their own"),
      again: html.includes("1 needs signing in again"),
      // Core sends the toolkit's slug, not the catalog's name for it.
      hubspot: html.includes("Hubspot"),
      forCrmSync: html.includes("For CRM sync"),
      notConnected: html.includes("Not connected"),
      asked: html.includes(
        `Asked for in 2 chats since ${formatDate(daysAgo(1))}, waiting on the person in the chat`
      ),
      notReported: html.includes("doesn’t report"),
      source: html.includes("From the company’s own Grasp and Composio."),
      waiting: workflows.html.includes("Waiting on a connection</h2>"),
      crm: workflows.html.includes("crm: Hubspot, not connected"),
      mail: workflows.html.includes("mail: No connection approved yet"),
      health: overview.html.includes("1 stopped: someone must sign in again"),
    }).toStrictEqual({
      status: [200, 200, 200],
      drive: true,
      microsoft: true,
      again: true,
      hubspot: true,
      forCrmSync: true,
      notConnected: true,
      asked: true,
      notReported: false,
      source: true,
      waiting: true,
      crm: true,
      mail: true,
      health: true,
    });
  });

  it("lists an organization's members with where each stands and their role, ready before Grasp opens and in after", async () => {
    const empty = emptyAdminSnapshot("Acme");
    const members: AdminSnapshot["members"] = [
      {
        userId: "user-anna",
        name: "Anna de Vries",
        email: "anna@acme.test",
        role: "admin",
        joinedAt: daysAgo(3),
      },
      {
        userId: "user-ben",
        name: "Ben Okafor",
        email: "ben@acme.test",
        role: "builder",
        joinedAt: daysAgo(1),
      },
    ];
    const closed = await liveClient();
    closed.account.admin = { ...empty, members };
    const open = await liveClient();
    open.account.admin = {
      ...empty,
      members,
      gate: { ...empty.gate, open: true, openedAt: empty.now },
    };
    const nobody = await liveClient();
    nobody.account.admin = empty;

    const closedPage = await page(
      `/admin/organizations/${closed.clientId}/members`
    );
    const openPage = await page(
      `/admin/organizations/${open.clientId}/members`
    );
    const nobodyPage = await page(
      `/admin/organizations/${nobody.clientId}/members`
    );
    /** The text of the list item naming `name`. */
    const rowOfMember = (html: string, name: string): string => {
      const at = html.indexOf(`>${name}</span>`);
      return at === -1
        ? ""
        : html
            .slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at))
            .replaceAll(tags, " ")
            .replaceAll(spaces, " ")
            .trim();
    };
    const joined = formatDate(daysAgo(3));

    expect({
      statuses: [closedPage, openPage, nobodyPage].map(({ status }) => status),
      closed: {
        anna: rowOfMember(closedPage.html, "Anna de Vries"),
        ben: rowOfMember(closedPage.html, "Ben Okafor").includes("Builder"),
        ready: closedPage.html.includes("are ready for when Grasp opens"),
        seats: closedPage.html.includes(
          "seats taken; the contract that gives them isn’t read yet"
        ),
        toCome: closedPage.html.includes(
          "This section isn’t in the console yet."
        ),
      },
      open: {
        anna: rowOfMember(openPage.html, "Anna de Vries"),
        in: openPage.html.includes("are in"),
      },
      nobody: nobodyPage.html.includes("Nobody has made an account yet."),
    }).toStrictEqual({
      statuses: [200, 200, 200],
      closed: {
        anna: `AV Anna de Vries anna@acme.test Ready Made an account on ${joined}. Comes in when Grasp opens. Role: Admin`,
        ben: true,
        ready: true,
        seats: true,
        toCome: false,
      },
      open: {
        anna: `AV Anna de Vries anna@acme.test In In since ${joined}. Role: Admin`,
        in: true,
      },
      nobody: true,
    });
  });

  it("shows an organization whose core didn't answer by its name and why, with no sections", async () => {
    const down = await liveClient();
    down.account.unhealthy = 1000;
    const waiting = await recordClient("provisioning");

    const downPage = await page(`/admin/organizations/${down.clientId}`);
    const downMembers = await page(
      `/admin/organizations/${down.clientId}/members`
    );
    const waitingPage = await page(`/admin/organizations/${waiting.clientId}`);
    /** What the page says of `name`: its title, why, and whether any section is there. */
    const pageOf = (
      { status, html }: { status: number; html: string },
      name: string
    ) => ({
      status,
      title: html.includes(`${name}</h1>`),
      column: columnOf(html, name) !== "",
      sections: [
        "Members</h1>",
        "Needs Grasp",
        "% known",
        "From the company",
      ].some((text) => html.includes(text)),
    });

    expect({
      down: pageOf(downPage, down.name),
      downWhy: downPage.html.includes("Its Grasp can’t be read now:"),
      downMembers: pageOf(downMembers, down.name),
      waiting: pageOf(waitingPage, waiting.name),
      waitingWhy: waitingPage.html.includes(
        "Its Grasp isn’t deployed yet, so there is nothing of it to read."
      ),
    }).toStrictEqual({
      down: { status: 200, title: true, column: false, sections: false },
      downWhy: true,
      downMembers: { status: 200, title: true, column: false, sections: false },
      waiting: { status: 200, title: true, column: false, sections: false },
      waitingWhy: true,
    });
  });

  it("has no page for a section an organization doesn't have", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");

    const missing = await page(`/admin/organizations/${acme.clientId}/nothing`);
    const unknown = await page("/admin/organizations/client-unknown/members");

    expect([missing.status, unknown.status]).toStrictEqual([404, 404]);
  });

  it("gives a request Access doesn't vouch for nothing, asking no core", async () => {
    const acme = await liveClient();
    acme.account.admin = emptyAdminSnapshot("Acme");

    const answers = await Promise.all(
      [
        "/admin",
        "/admin?phase=ready",
        "/admin/platform",
        "/admin/new-organization",
        `/admin/organizations/${acme.clientId}`,
        `/admin/organizations/${acme.clientId}/contract`,
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
      answers: [403, 403, 403, 403, 403, 403].map((status) => ({
        status,
        body: "Forbidden",
      })),
      readers: [],
    });
  });
});
