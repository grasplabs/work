import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RunResultView } from "./run-detail.tsx";

// What an opened run says of its result: what it returned, or why it
// failed, as core gave them; for a reader core keeps them from, that only
// the person it ran for and the admins see them; nothing while it runs.

/** A run that completed, changed by `change`. */
const run = (
  change: Partial<WorkflowResourceRun> = {}
): WorkflowResourceRun => ({
  id: "run-1",
  workflowId: "workflow-1",
  version: 2,
  manifestHash: "manifest",
  buildHash: "build",
  principal: "ada",
  status: "completed",
  createdAt: "2026-10-28T09:00:00.000Z",
  endedAt: "2026-10-28T09:01:00.000Z",
  ...change,
});

/** The view's text, as a person reads it: tags gone, spaces collapsed. */
const textOf = (shown: WorkflowResourceRun, seesResult = true): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <RunResultView run={shown} seesResult={seesResult} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("an opened run's result", () => {
  it("shows what it returned, as JSON", () => {
    expect(textOf(run({ output: { status: "sent", count: 2 } }))).toBe(
      'What it returned { "status": "sent", "count": 2 }'
    );
  });

  it("says why it failed in core's words, with the code", () => {
    expect(
      textOf(
        run({
          status: "failed",
          error: { code: "workflow.task_failed", message: "The task failed." },
        })
      )
    ).toBe("Why it failed The task failed. workflow.task_failed");
  });

  it("tells a reader core keeps the result from who sees it, and says nothing more to one who may", () => {
    expect({
      keptFrom: textOf(run(), false),
      sees: textOf(run(), true),
    }).toStrictEqual({
      keptFrom:
        "Only the person it ran for and the organization's admins see what it returned or why it failed.",
      sees: "",
    });
  });

  it("says nothing of a result while it runs", () => {
    expect(textOf(run({ status: "running", endedAt: null }), false)).toBe("");
  });
});
