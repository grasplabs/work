import { env } from "cloudflare:workers";

import { orgSections } from "../src/admin/sections.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { fakeCloudflareApi } from "./cloudflare-api.ts";
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
