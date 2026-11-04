import type { DecisionView } from "@grasp-os/shared/decisions";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { decisionSource } from "./decision-source.ts";

// The decision page's "From" crumb: a link to the page of the workflow
// that asks, an App's or an independent one's, only where core confirmed
// the reader may open it, its name alone otherwise.

/** A decision `source`'s run asks, its source `opens` or not. */
const decisionOf = (
  source: Pick<DecisionView, "app" | "workflowResource">,
  opens: boolean
): DecisionView => ({
  id: "decision-1",
  ...source,
  workflow: workflowIdSchema.parse(
    source.app === undefined ? "Quotes" : "approval"
  ),
  run: runIdSchema.parse("run-1"),
  description: "Approve the quote?",
  status: "open",
  expiresAt: "2026-11-05T09:00:00.000Z",
  revision: "revision",
  ...(opens ? { opens: true as const } : {}),
});

const independent = {
  workflowResource: {
    id: workflowResourceIdSchema.parse("workflow-quotes"),
    name: "Quotes",
  },
};

const ofApp = {
  app: { id: appIdSchema.parse("app-approvals"), name: "Approvals" },
};

describe("a decision's source crumb", () => {
  it("links an independent workflow's page only for a reader core says may open it", () => {
    expect({
      opens: decisionSource(decisionOf(independent, true)),
      closed: decisionSource(decisionOf(independent, false)),
    }).toStrictEqual({
      opens: {
        label: "Quotes",
        to: "/workflows/$workflow",
        params: { workflow: "workflow-quotes" },
      },
      closed: { label: "Quotes" },
    });
  });

  it("links an App's workflow only for a reader core says may open the App", () => {
    expect({
      opens: decisionSource(decisionOf(ofApp, true)),
      closed: decisionSource(decisionOf(ofApp, false)),
    }).toStrictEqual({
      opens: {
        label: "approval",
        to: "/workflows/$app/$workflow",
        params: { app: "app-approvals", workflow: "approval" },
      },
      closed: { label: "approval" },
    });
  });
});
