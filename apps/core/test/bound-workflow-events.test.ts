import { v } from "@grasp-os/sdk";
import { describe, expect, it } from "vite-plus/test";

import { boundEventsOf } from "../src/bound-workflow-events.ts";

// What an App's references carry of a bound workflow's events (spec
// 10.4.6): pure logic over a pinned version's event bindings and listen
// tasks, so a unit test. Only browser-callable events become references,
// typed by their contract's data, and only the listen tasks waiting on
// them become event waits.

const uploaded = v.object({ fileId: v.string() });
const completed = v.object({ jobId: v.string() });

describe("a bound workflow's events", () => {
  it("are the browser-callable types with their data, and the listen tasks waiting only on them", () => {
    const bound = boundEventsOf(
      [
        {
          alias: "documentUploaded",
          events: {
            "invoice.document.uploaded": {
              data: JSON.stringify(uploaded.descriptor),
              browser: true,
            },
            "invoice.document.scanned": {
              data: JSON.stringify(uploaded.descriptor),
              browser: false,
            },
          },
        },
        {
          alias: "jobEvents",
          events: {
            "grasp.job.completed": {
              data: JSON.stringify(completed.descriptor),
              browser: false,
            },
          },
        },
      ],
      {
        "await-upload": {
          alias: "documentUploaded",
          types: ["invoice.document.uploaded"],
        },
        // The same binding, another of its types: no screen sends it.
        "await-scan": {
          alias: "documentUploaded",
          types: ["invoice.document.scanned"],
        },
        // An `any` mixing the two: not every type is a screen's.
        "await-either": {
          alias: "documentUploaded",
          types: ["invoice.document.scanned", "invoice.document.uploaded"],
        },
        "await-job": { alias: "jobEvents", types: ["grasp.job.completed"] },
      }
    );
    expect(bound).toStrictEqual({
      events: {
        documentUploaded: {
          type: "invoice.document.uploaded",
          data: uploaded.descriptor,
        },
      },
      listens: { "await-upload": ["documentUploaded"] },
    });
  });

  it("refuse a contract with two types a screen sends as corrupt", () => {
    const data = JSON.stringify(uploaded.descriptor);
    expect(() =>
      boundEventsOf(
        [
          {
            alias: "documentUploaded",
            events: {
              "invoice.document.uploaded": { data, browser: true },
              "invoice.document.replaced": { data, browser: true },
            },
          },
        ],
        {}
      )
    ).toThrow("admits more than one type a screen sends");
  });
});
