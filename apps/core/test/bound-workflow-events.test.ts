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
  it("are the browser-callable types with their data, and the listen tasks waiting on them", () => {
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
        "await-upload": ["documentUploaded"],
        "await-job": ["jobEvents"],
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
});
