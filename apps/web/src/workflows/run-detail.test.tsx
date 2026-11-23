import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RunResultView, StartedWithout } from "./run-detail.tsx";

// What an opened run says of its result: what it returned, or why it
// failed, as core gave them (its panel's section names which); for a
// reader core keeps them from, that only the person it ran for and the
// admins see them; nothing while it runs.

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
const textOf = (
  shown: WorkflowResourceRun,
  seesResult = true,
  builder = false
): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <RunResultView builder={builder} run={shown} seesResult={seesResult} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("an opened run's result", () => {
  it("shows what it returned, as JSON", () => {
    expect(textOf(run({ result: { status: "sent", count: 2 } }))).toContain(
      '{ "status": "sent", "count": 2 }'
    );
  });

  it("says why it failed in core's words, its code only to its builders, under Details", () => {
    const failed = run({
      status: "failed",
      error: { code: "workflow.task_failed", message: "The task failed." },
    });
    expect({
      user: textOf(failed),
      builder: textOf(failed, true, true),
    }).toStrictEqual({
      user: "The task failed.",
      builder: "The task failed. Details workflow.task_failed",
    });
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

/** What an opened run says of the kept values it started without. */
const withoutText = (shown: WorkflowResourceRun): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <StartedWithout run={shown} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("an opened run's kept values", () => {
  it("says how many it started without, and nothing when it started with all", () => {
    expect({
      one: withoutText(run({ stateWithheld: 1 })),
      two: withoutText(run({ stateWithheld: 2 })),
      none: withoutText(run()),
    }).toStrictEqual({
      one: "It started without 1 kept value: the run that kept it read something that is no longer there to read.",
      two: "It started without 2 kept values: the runs that kept them read something that is no longer there to read.",
      none: "",
    });
  });
});
