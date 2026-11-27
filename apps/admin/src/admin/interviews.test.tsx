// @vitest-environment happy-dom
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { answeredAdmin, gridRow, openAdmin } from "../../test/app.tsx";
import {
  emptyAdminSnapshot,
  fact,
  interviewingSnapshot,
  linkCode,
  said,
} from "../../test/snapshots.ts";
import { formatDate } from "./words.ts";

// An organization's interviews, and Stephen across every organization in
// the Lab, as the browser shows them from the snapshots their cores
// answer. That the Worker drops what a core must never send is in
// test/admin-interviews.test.ts.

/** What of `texts` a page doesn't say. */
const missingIn = (html: string, texts: string[]) =>
  texts.filter((text) => !html.includes(text));

describe("an organization's interviews", () => {
  /** Companies opened in this test, each answering `core.admin`. */
  let made: { clientId: string; core: { admin: AdminSnapshot } }[] = [];
  beforeEach(() => {
    made = [];
  });
  /** A company, its core answering an empty snapshot until the test says otherwise. */
  const liveClient = async () => {
    const made1 = {
      clientId: `client-${made.length + 1}`,
      core: { admin: emptyAdminSnapshot("Acme") },
    };
    made.push(made1);
    return await Promise.resolve(made1);
  };
  /** The page at `path`, its markup as the browser shows it. */
  const page = async (path: string) => {
    const admins = made.map(({ clientId, core }) =>
      answeredAdmin({
        client: gridRow({ id: clientId, name: `Acme ${clientId}` }),
        snapshot: core.admin,
      })
    );
    const opened = await openAdmin(path, {
      fetchClientGrid: admins.map(({ client }) => client),
      fetchClientAdmins: admins,
      fetchClientAdmin: (data: unknown) =>
        admins.find(
          ({ client }) =>
            JSON.stringify(data) === JSON.stringify({ clientId: client.id })
        ) ?? null,
    });
    return {
      html: opened.html(),
      /** Every button on the page by its name: its `aria-label`, or else its words. */
      buttons: [...opened.container.querySelectorAll("button")].map(
        (button) =>
          button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""
      ),
    };
  };

  it("shows every team, everyone by name with their interview’s numbers, and how Stephen did, in numbers only", async () => {
    const acme = await liveClient();
    const snapshot = interviewingSnapshot();
    acme.core.admin = snapshot;
    const base = `/organizations/${acme.clientId}/interviews`;
    // The last day a link works: the plan's 14th, counting its first.
    const lastDay = new Date(`${snapshot.plan?.start ?? ""}T12:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() + 13);

    const teams = await page(base);
    const people = await page(`${base}?tab=people`);
    const interviewers = await page(`${base}?tab=interviewers`);
    const setup = await page(`${base}?tab=setup`);
    const pages = [teams, people, interviewers, setup];

    expect({
      // What each tab says that isn't there yet: every line it should show.
      missing: {
        teams: missingIn(teams.html, [
          "Where everyone stands",
          "Finance",
          "1 of 4 talked",
          "Talked, day by day",
          `The links work until ${formatDate(lastDay.toISOString())}.`,
        ]),
        people: missingIn(people.html, [
          "Ana Smit",
          "Team lead",
          "Ben Vos",
          "Stopped halfway",
          "Step by step",
          "Cleo Bakker",
          "Invited",
          "Dan Mol",
          "Talking now",
          // Each interview's minutes and what was agreed to, beside its person.
          "Minutes",
          "Facts agreed",
          ">0 of 2<",
          "What anyone said stays in the company’s own Grasp.",
          // Everyone still without their one reminder, to mark at once.
          "people can still be reminded, once each.",
        ]),
        interviewers: missingIn(interviewers.html, [
          "What people thought of it",
          "1 of 1 said how it was",
          "5.0 of 5",
          "1 of 3",
        ]),
        setup: missingIn(setup.html, [
          "How Stephen is set up here",
          "None named yet: the company’s own Grasp doesn’t say which.",
          "What he knows before he says hello",
        ]),
      },
      // Nothing anyone said, and no link's code, on any tab.
      leaked: pages.flatMap((each) =>
        [said, fact, linkCode].filter((text) => each.html.includes(text))
      ),
      toCome: pages.some((each) =>
        each.html.includes("This section isn’t in the admin yet.")
      ),
      // Everyone still without their one reminder, marked at once by one button.
      remindAll: people.buttons.filter((name) =>
        /^Mark \d+ people reminded$/u.test(name)
      ).length,
    }).toStrictEqual({
      missing: {
        teams: [],
        people: [],
        interviewers: [],
        setup: [],
      },
      leaked: [],
      toCome: false,
      remindAll: 1,
    });
  });

  it("says no interview has been held before the company told its team", async () => {
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");
    const base = `/organizations/${acme.clientId}/interviews`;

    const teams = await page(base);
    const interviewers = await page(`${base}?tab=interviewers`);

    expect([
      teams.html.includes(
        "Nobody is on the list yet. The company’s admin shares its staff list in their onboarding."
      ),
      interviewers.html.includes(
        "No interviews yet. They start once the company has told its team."
      ),
    ]).toStrictEqual([true, true]);
  });

  it("counts nobody as finished while no interview is agreed to", async () => {
    const acme = await liveClient();
    const snapshot = interviewingSnapshot();
    // Only Ben, who stopped halfway, and Dan, who is talking now, have started.
    acme.core.admin = {
      ...snapshot,
      interviews: snapshot.interviews.filter((interview) => !interview.agreed),
    };

    const { html } = await page(
      `/organizations/${acme.clientId}/interviews?tab=interviewers`
    );
    /** The figure labelled `label`: its words, its label first. */
    const figureOf = (label: string) =>
      [
        ...new DOMParser()
          .parseFromString(html, "text/html")
          .querySelectorAll('[data-slot="stat"]'),
      ]
        .map((stat) => stat.textContent ?? "")
        .find((words) => words.startsWith(label)) ?? "";

    // None of the two who started.
    expect(figureOf("Finished")).toContain("0 of 2");
  });

  it("measures Stephen across every organization in the Lab, each opening how he did there, never with what anyone said", async () => {
    const interviewing = await liveClient();
    interviewing.core.admin = interviewingSnapshot();
    const quiet = await liveClient();
    quiet.core.admin = emptyAdminSnapshot("Acme");

    const { html } = await page("/lab");
    const name = `Acme ${interviewing.clientId}`;
    const rowOf = (text: string) =>
      text.slice(
        text.indexOf(`>${name}</a>`),
        text.indexOf("</tr>", text.indexOf(`>${name}</a>`))
      );

    expect({
      figures: [
        "In the lab",
        "Finished, with real people",
        "Notes kept, with real people",
        "Rating, with real people",
      ].map((label) => html.includes(`>${label}<`)),
      // Core here doesn't say which Stephen held an interview.
      inUse: html.includes("No interview says which Stephen held it yet."),
      // No lab run is kept in this checkout. Of the three who started only Ana finished, and gave
      // it a 5: her interview is kept as held by Claire, and counts as any other.
      noRun: html.includes("No lab run is kept yet"),
      finished: html.includes(">1 of 3<"),
      rated: rowOf(html).includes("5.0 (1)"),
      // One row a company whose interviews started, opening how Stephen did there.
      opens: html.includes(
        `href="/organizations/${interviewing.clientId}/interviews?tab=interviewers"`
      ),
      quietListed: html.includes(`>Acme ${quiet.clientId}</a>`),
      quietCounted: html.includes("started interviews yet."),
      leaked: missingIn(html, [said, fact, linkCode]).length,
    }).toStrictEqual({
      figures: [true, true, true, true],
      inUse: true,
      noRun: true,
      finished: true,
      rated: true,
      opens: true,
      quietListed: false,
      quietCounted: true,
      leaked: 3,
    });

    // Every organization follows Stable here: on Edge there is no one to count.
    const edge = await page("/lab?where=edge");
    const stable = await page("/lab?where=stable");
    expect({
      edgeListed: edge.html.includes(`>${name}</a>`),
      stableListed: stable.html.includes(`>${name}</a>`),
    }).toStrictEqual({ edgeListed: false, stableListed: true });
  });
});
