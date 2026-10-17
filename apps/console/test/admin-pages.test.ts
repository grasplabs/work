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
 * that need Grasp (the go, both agreements and the contract).
 */
const readySnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  return {
    ...empty,
    kickoff: { at: empty.now, known: 0.5 },
    gate: { ...empty.gate, known: 85, ready: true },
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
        "Being written",
        'text-status-attention tabular-nums">4<',
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
      // In the sidebar, how many things need Grasp at Acme.
      acmeCount: acmeEntry
        .slice(0, acmeEntry.indexOf("</li>"))
        .includes('4<span class="sr-only">things need Grasp</span>'),
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
      acmeCount: true,
    });
  });

  it("puts every organization's most pressing need in today's list before any one's next", async () => {
    // Four needs each: twelve, past the eight the list shows.
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
      // The go and the agreements wait under Steps, the contract under Contract.
      waits: ["Steps", "Contract", "Members", "Interviews"].map((title) =>
        columnEntryOf(column, title).includes("Something waits for Grasp")
      ),
      source: html.includes("From the company’s own Grasp."),
      // Every need of Acme, with where it is settled.
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
      waits: [true, true, false, false],
      source: true,
      needs: [true, true],
      opensContract: true,
    });
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

  it("shows an organization's contract as still being written, its agreements as core has them, and no invoices", async () => {
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
        contract: html.includes("Being written"),
        notSent: html.includes("not sent yet"),
        seats: html.includes("taken; the contract gives none yet"),
        // A draft has no agreed term or fee: the model's placeholders aren't shown.
        runs: html.includes("Still runs"),
        fee: html.includes("Fee a month"),
      },
      terms: [
        partOf("The terms").includes(
          "Nothing is agreed yet: the contract is still being written."
        ),
        partOf("The terms").includes(
          "Once Rooms is connected, this fills in by itself."
        ),
      ],
      gives: [
        partOf("What it gives the company").includes(
          "None agreed yet; 2 are taken."
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
        "None yet. There is no signed contract."
      ),
    }).toStrictEqual({
      status: 200,
      toCome: false,
      summary: {
        contract: true,
        notSent: true,
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
      answers: [403, 403, 403, 403, 403].map((status) => ({
        status,
        body: "Forbidden",
      })),
      readers: [],
    });
  });
});
