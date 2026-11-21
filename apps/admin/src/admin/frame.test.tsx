// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { FailedError, gridRow, openAdmin, settle } from "../test-app.tsx";

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
      brand: container.textContent?.includes("Grasp"),
    }).toStrictEqual({ loading: "Loading…", brand: true });
  });

  it("says an address no page has isn't there, in the frame with the way back", async () => {
    const { main, text } = await openAdmin("/no-such-page", {
      fetchClientGrid: [gridRow()],
    });

    expect({
      title: main().includes("This page is not here"),
      back: main().includes("Back to the admin"),
      sidebar: text().includes("Organizations"),
    }).toStrictEqual({ title: true, back: true, sidebar: true });
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
