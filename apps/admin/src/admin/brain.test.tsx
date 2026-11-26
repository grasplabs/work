// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import {
  answeredAdmin,
  gridRow,
  openAdmin,
  settle,
  until,
} from "../../test/app.tsx";
import { brainReport, heardSnapshot } from "../../test/snapshots.ts";

// An organization's Brain section around its report, as the browser shows
// it: what it says of the brain from the snapshot, and the rest of the
// section while its core is slow. How the report itself reads is tested
// from real reports in test/admin-brain.test.ts.

const acme = gridRow({ id: "acme", name: "Acme" });

describe("an organization's brain", () => {
  it("says the brain itself isn't shared, and makes up no source's share", async () => {
    const { main } = await openAdmin("/organizations/acme/brain", {
      fetchClientGrid: [acme],
      fetchClientAdmin: answeredAdmin({
        client: acme,
        snapshot: heardSnapshot("Acme"),
      }),
      fetchBrainReport: brainReport(1_000_000),
    });
    const page = main();

    expect({
      toCome: page.includes("This section isn’t in the admin yet."),
      notShared: page.includes(
        "Acme doesn’t share its brain with Grasp’s staff, so only its counts show here."
      ),
      // Core counts what is known as one number: no source's share is made up.
      sources: page.includes("How much of each source is in"),
      sourcesWhy: page.includes(
        "The company’s own Grasp counts what is known as one number"
      ),
    }).toStrictEqual({
      toCome: false,
      notShared: true,
      sources: false,
      sourcesWhy: true,
    });
  });

  it("shows the rest of the section while its core is slow, and the report once it answers", async () => {
    const held = Promise.withResolvers<ReturnType<typeof brainReport>>();
    const reading = "Reading how its Brain is doing from its core";
    const { container, main } = await openAdmin(
      "/organizations/acme/brain",
      {
        fetchClientGrid: [acme],
        fetchClientAdmin: answeredAdmin({
          client: acme,
          snapshot: heardSnapshot("Acme"),
        }),
        fetchBrainReport: async () => await held.promise,
      },
      { rest: false }
    );
    // Its core held: everything but the report shows.
    await until(() => main().includes(reading));
    const headings = () =>
      [...container.querySelectorAll("main h2")].map((h) => h.textContent);
    const beforeAnswer = {
      counts: headings().includes("What it stands on"),
      reading: main().includes(reading),
      report:
        container.querySelector('[aria-label="The Brain at work"]') !== null,
    };
    held.resolve(brainReport(1_000_000));
    await settle();

    expect({
      beforeAnswer,
      report:
        container.querySelector('[aria-label="The Brain at work"]') !== null,
    }).toStrictEqual({
      beforeAnswer: { counts: true, reading: true, report: false },
      report: true,
    });
  });
});
