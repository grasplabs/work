import type { DecisionView } from "@grasp-os/shared/decisions";
import {
  runIdSchema,
  workflowIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { decisionSource } from "./decision-source.ts";

// The decision page's "From" crumb for an independent workflow's run:
// a link to the workflow's page only where core confirmed the reader may
// open it, its name alone otherwise.

/** A decision an independent workflow's run asks, its source `opens` or not. */
const decisionOf = (opens: boolean): DecisionView => ({
  id: "decision-1",
  workflowResource: {
    id: workflowResourceIdSchema.parse("workflow-quotes"),
    name: "Quotes",
    ...(opens ? { opens: true as const } : {}),
  },
  workflow: workflowIdSchema.parse("Quotes"),
  run: runIdSchema.parse("run-1"),
  description: "Approve the quote?",
  status: "open",
  expiresAt: "2026-11-05T09:00:00.000Z",
  revision: "revision",
});

describe("a decision's source crumb", () => {
  it("links an independent workflow's page only for a reader core says may open it", () => {
    expect({
      opens: decisionSource(decisionOf(true)),
      closed: decisionSource(decisionOf(false)),
    }).toStrictEqual({
      opens: {
        label: "Quotes",
        to: "/workflows/$workflow",
        params: { workflow: "workflow-quotes" },
      },
      closed: { label: "Quotes" },
    });
  });
});
