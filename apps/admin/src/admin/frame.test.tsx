// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { FailedError, gridRow, openAdmin, settle } from "../../test/app.tsx";

// What the browser shows around every page, now that it renders the admin
// alone: while the admin's own records come, an address no page has, an
// organization the admin doesn't know, and a page that fails, which is
// also reported to the Worker's logs.

/** An answer that never comes. */
const never = async (): Promise<never> =>
  // oxlint-disable-next-line promise/avoid-new -- a read that never answers
  await new Promise<never>(() => {
    // Never settled.
  });

describe("the admin's frame in the browser", () => {
  it("shows the frame as skeletons, announced as loading, until its records come", async () => {
    const { container } = await openAdmin(
      "/",
      { fetchClientGrid: never },
      { rest: false }
    );

    const loading = container.querySelector('output[aria-busy="true"]');
    expect({
      loading: loading?.getAttribute("aria-label"),
      brand: container.querySelector('[aria-label="Grasp admin"]') !== null,
    }).toStrictEqual({ loading: "Loading…", brand: true });
  });

  it("says an address no page has isn't there, in the frame with the way back", async () => {
    const { main, text } = await openAdmin("/no-such-page", {
      fetchClientGrid: [gridRow()],
    });

    expect({
      title: main().includes("This page is not here"),
      says: main().includes("There's no such page."),
      back: main().includes("Back to the admin"),
      sidebar: text().includes("Organizations"),
    }).toStrictEqual({ title: true, says: true, back: true, sidebar: true });
  });

  it("says an organization the admin doesn't know isn't there", async () => {
    const { main } = await openAdmin("/organizations/nobody", {
      fetchClientGrid: [gridRow()],
      fetchClientAdmin: null,
    });

    expect(main()).toContain("This page is not here");
  });

  it("reports a page that failed to the Worker with its route's pattern, never its address, once", async () => {
    const { calls, main } = await openAdmin("/platform/releases", {
      fetchReleases: () => {
        throw new FailedError();
      },
    });
    await settle();

    const reports = calls.filter(({ fn }) => fn === "reportPageErrorFn");
    expect({
      shown: main().includes("This page didn’t load"),
      reports: reports.map(({ data }) => data),
    }).toStrictEqual({
      shown: true,
      reports: [
        expect.objectContaining({
          kind: "render",
          route: "/platform/releases/",
        }),
      ],
    });
  });
});

/** Throws `message` where nothing catches it, as the browser reports it to the page, `times` times. */
const throwUncaught = async (message: string, times: number) => {
  const error = new Error(message);
  for (let time = 0; time < times; time += 1) {
    window.dispatchEvent(new ErrorEvent("error", { error }));
    // oxlint-disable-next-line no-await-in-loop -- each report answered before the next comes
    await settle();
  }
};

describe("the page's error reports", () => {
  it("sends an error the Worker refused as past its limit no second time within the minute", async () => {
    const { calls } = await openAdmin("/platform/offboarded", {
      fetchOffboardedClients: [],
      reportPageErrorFn: { logged: false },
    });

    await throwUncaught("refused while past the limit", 3);

    expect(calls.filter(({ fn }) => fn === "reportPageErrorFn")).toHaveLength(
      1
    );
  });

  it("sends an error again when its report wasn't answered", async () => {
    const { calls } = await openAdmin("/platform/offboarded", {
      fetchOffboardedClients: [],
      reportPageErrorFn: () => {
        throw new FailedError();
      },
    });

    await throwUncaught("not answered", 2);

    expect(calls.filter(({ fn }) => fn === "reportPageErrorFn")).toHaveLength(
      2
    );
  });
});
