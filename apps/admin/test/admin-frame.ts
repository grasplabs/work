import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env } from "cloudflare:workers";

import { orgSections } from "../src/admin/sections.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { fakeCloudflareApi, emptyAdminSnapshot } from "./cloudflare-api.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";

/**
 * The admin's frame, shared by the admin-pages*.test.ts files that render
 * it: the fake Cloudflare API and Access they go through, clients recorded
 * or placed live, the snapshots their cores answer, and how a page's parts
 * are read.
 */

export const token = "test-deployer-token-admin-frame-3b7e21";
/**
 * The fake Cloudflare API each file puts in place of `fetch` with
 * `mockCloudflareApi(token, cloudflare)`, registering its own hooks.
 */
export const cloudflare = fakeCloudflareApi(token);

export const db = adminDatabase(env.DB);
export const tags = /<[^>]*>/gu;
export const spaces = /\s+/gu;

/** The moment `ago` days before now. */
export const daysAgo = (ago: number) =>
  new Date(Date.now() - ago * 86_400_000).toISOString();
export const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A client recorded as `status`, its core on the fake. */
export const recordClient = async (
  status: "provisioning" | "offboarded",
  clientId = `client-${crypto.randomUUID().slice(0, 8)}`
) => {
  const core = cloudflare.coreOf(clientId);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        status,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return { clientId, name: `Acme ${clientId}`, core };
};

/** A live placed client running a new release, as its operation made it. */
export const liveClient = async () => {
  const release = await placedRelease("feat(core): the frame");
  const { clientId, core } = await livePlacedClient(cloudflare, release, {
    signIn: null,
  });
  return { clientId, name: `Acme ${clientId}`, core };
};

/**
 * A company whose first conversation Stephen read and of which 85% is
 * known, past the 80% it opens at, with nothing signed yet: as the model
 * has it, at the agreements, ready for Grasp's go, and with four things
 * that need Grasp (the go and both agreements; its contract core doesn't
 * hold, so nothing is known of it).
 */
export const readySnapshot = (name: string): AdminSnapshot => {
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
export const toldSnapshot = (
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
      failedMail: null,
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
export const rowOf = (html: string, clientId: string): string => {
  const table = html.indexOf("<table");
  const at = html.indexOf(`href="/organizations/${clientId}"`, table);
  return at === -1 || table === -1
    ? ""
    : html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
};

/** The text of `html` between the admin's sidebar and the page beside it. */
export const sidebarOf = (html: string): string =>
  html.slice(html.indexOf('data-slot="sidebar"'), html.indexOf("<main"));

/** An organization's column of sections, named `name`; empty when the page has none. */
export const columnOf = (html: string, name: string): string => {
  const at = html.indexOf(`<nav aria-label="${name}"`);
  return at === -1 ? "" : html.slice(at, html.indexOf("</nav>", at));
};

/** The entry titled `title` in a column: from its link's start to its end. */
export const columnEntryOf = (column: string, title: string): string => {
  const at = column.indexOf(`>${title}</span>`);
  return at === -1
    ? ""
    : column.slice(column.lastIndexOf("<a", at), column.indexOf("</a>", at));
};

/** What an Integrations section says, part by part. */
export const integrationsOf = ({
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
  toCome: html.includes("This section isn’t in the admin yet."),
});

/** Each section as an organization not read shows it. */
export const unread = (state: string[]) =>
  orgSections
    .filter((each) => each !== "setup")
    .map((section) => ({
      section,
      status: 200,
      title: true,
      column: true,
      failed: false,
      fromCore: false,
      toSetup: true,
      state,
    }));
