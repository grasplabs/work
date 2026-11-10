import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import {
  cloudflare,
  token,
  db,
  recordClient,
  liveClient,
  readySnapshot,
  toldSnapshot,
  rowOf,
} from "./admin-frame.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: the overview's counts and filters, and opening or adding an
// organization from it; the rest in the other admin-pages*.test.ts files.

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

  it("counts only leads who talked, and the days of each company's own plan", async () => {
    const waiting = await liveClient();
    waiting.core.admin = toldSnapshot("Waiting", {
      days: 21,
      daysIn: 3,
      leadTalked: false,
    });
    const talking = await liveClient();
    talking.core.admin = toldSnapshot("Talking", {
      days: 21,
      daysIn: 3,
      leadTalked: true,
    });

    const { html } = await page("/");
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
    company.core.admin = toldSnapshot("Company", {
      days: 21,
      daysIn: 3,
      leadTalked: true,
    });

    const { status, html } = await page(`/organizations/${company.clientId}`);

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
    acme.core.admin = readySnapshot("Acme");
    const empty = await liveClient();
    empty.core.admin = emptyAdminSnapshot("Empty");
    const waiting = await recordClient("provisioning");

    const ready = await page("/?phase=ready");
    const agreements = await page("/?phase=agreements");
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

  it("opens an organization the admin knows, and has no page for one it doesn't", async () => {
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");

    // Named like one of the admin's sections, and still its own page.
    const platform = await recordClient("provisioning", "platform");

    const known = await page(`/organizations/${acme.clientId}`);
    const named = await page("/organizations/platform");
    const unknown = await page("/organizations/client-unknown");

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

  it("offers to add an organization from the overview, asking its name, web address, email domain, first admin and hosting", async () => {
    const overview = await page("/");
    const { status, html } = await page("/new-organization");
    const mainAt = html.indexOf("<main");
    /** Whether the page's main part says `text`. */
    const says = (text: string): boolean => html.includes(text, mainAt);
    expect({
      link: overview.html.includes('href="/new-organization"'),
      status,
      title: says("New organization</h1>"),
      labels: [
        "Name",
        "Web address",
        "Company email domain",
        "First admin&#x27;s email",
        "Grasp Cloud",
        "On-premises",
        "Keep data in the EU",
      ].map(says),
      // Its platform's domain after the web address.
      suffix: says(".grasp.test"),
    }).toStrictEqual({
      link: true,
      status: 200,
      title: true,
      labels: [true, true, true, true, true, true, true],
      suffix: true,
    });
  });
});
