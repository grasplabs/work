import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import { describe, expect, it } from "vite-plus/test";

import { goLiveChoiceOf, statusOf } from "./workflow-status.tsx";

// What the status beside a workflow's name offers: Pause only while it is
// live and runs, Resume only while it is paused, "Ask to go live" only for
// a published version not live nor waiting already, and none of them to
// someone core doesn't let change it. And the version waiting to go live,
// to approve or send back, only for whoever core lets decide it.

const lifecycle = (
  changes: Partial<WorkflowLifecycle> = {}
): WorkflowLifecycle => ({
  workflowId: "w1",
  revision: 4,
  stage: "live",
  stageSet: false,
  draft: null,
  publishedVersion: 2,
  live: {
    version: 2,
    approvedBy: "owner",
    approvedAt: "2026-10-20T09:00:00.000Z",
    selfApproved: false,
  },
  paused: null,
  goLive: null,
  canChange: true,
  canDecide: false,
  ...changes,
});

describe(statusOf, () => {
  it("offers Pause on a live workflow that runs", () => {
    expect(statusOf(lifecycle())).toMatchObject({
      shows: "live",
      liveSince: "2026-10-20T09:00:00.000Z",
      canPause: true,
      canResume: false,
      askable: null,
    });
  });

  it("offers Resume, never Pause, on a paused workflow", () => {
    expect(
      statusOf(
        lifecycle({ paused: { by: "builder", at: "2026-10-21T09:00:00Z" } })
      )
    ).toMatchObject({ shows: "paused", canPause: false, canResume: true });
  });

  it("shows the stage word before a version went live, with no Pause", () => {
    expect(statusOf(lifecycle({ stage: "testing", live: null }))).toMatchObject(
      {
        shows: "stage",
        liveSince: null,
        canPause: false,
        askable: 2,
      }
    );
  });

  it("offers to ask for the newest published version only when it isn't live or waiting", () => {
    expect(statusOf(lifecycle({ publishedVersion: 3 })).askable).toBe(3);
    expect(
      statusOf(
        lifecycle({
          publishedVersion: 3,
          goLive: {
            version: 3,
            requestedBy: "builder",
            requestedAt: "2026-10-22T09:00:00Z",
            onlyApprover: false,
          },
        })
      )
    ).toMatchObject({ askable: null, waiting: 3 });
    expect(
      statusOf(lifecycle({ stage: "designed", publishedVersion: null })).askable
    ).toBeNull();
  });

  it("offers nothing to change to someone core doesn't let change it", () => {
    for (const paused of [null, { by: "builder", at: "2026-10-21T09:00Z" }]) {
      expect(
        statusOf(lifecycle({ canChange: false, paused, publishedVersion: 3 }))
      ).toMatchObject({ canPause: false, canResume: false, askable: null });
    }
  });
});

/** A version waiting to go live, changed by `changes`. */
const waiting = (
  changes: Partial<NonNullable<WorkflowLifecycle["goLive"]>> = {}
): WorkflowLifecycle["goLive"] => ({
  version: 3,
  requestedBy: "builder",
  requestedAt: "2026-10-22T09:00:00Z",
  onlyApprover: false,
  ...changes,
});

describe(goLiveChoiceOf, () => {
  it("offers the version waiting to whoever core lets decide it, as a change while another is live", () => {
    expect(
      goLiveChoiceOf(lifecycle({ goLive: waiting(), canDecide: true }), "owner")
    ).toStrictEqual({ version: 3, change: true, selfApproval: false });
    expect(
      goLiveChoiceOf(
        lifecycle({ live: null, goLive: waiting(), canDecide: true }),
        "owner"
      )
    ).toStrictEqual({ version: 3, change: false, selfApproval: false });
  });

  it("says when whoever asked decides it themselves, as nobody else may", () => {
    expect(
      goLiveChoiceOf(
        lifecycle({
          goLive: waiting({ onlyApprover: true }),
          canDecide: true,
        }),
        "builder"
      )?.selfApproval
    ).toBeTruthy();
  });

  it("offers nothing when nothing waits or core doesn't let the reader decide", () => {
    expect({
      nothingWaits: goLiveChoiceOf(lifecycle({ canDecide: true }), "owner"),
      mayNotDecide: goLiveChoiceOf(
        lifecycle({ goLive: waiting(), canDecide: false }),
        "builder"
      ),
    }).toStrictEqual({ nothingWaits: null, mayNotDecide: null });
  });
});
