import { useWorkflow } from "@grasp-os/sdk/react";
import type { WorkflowViewOf } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";

import { workflows } from "#grasp";

import type { DraftSource } from "./intake";

/** A reading this screen started: its run, and what it keeps it as. */
export interface Reading {
  /** The run of `extract` reading it. */
  id: string;
  title: string;
  /** The source its statements are kept under, its notes included. */
  source: DraftSource;
  /** Whether it is a stakeholder's chat, whose words are untrusted. */
  guest: boolean;
}

type ExtractView = WorkflowViewOf<typeof workflows.extract>;

/** What a finished reading found: the claims in the notes. */
export type Found = Extract<ExtractView, { status: "completed" }>["output"];

/** What a reading of notes is doing, in words. */
const statusOf = (run: ExtractView): string => {
  switch (run.status) {
    case "idle":
    case "loading": {
      return "Starting";
    }
    case "completed": {
      return "Ready to review";
    }
    case "failed": {
      return `Failed: ${run.error.message}`;
    }
    case "cancelled": {
      return "Cancelled";
    }
    case "queued": {
      return "Waiting its turn to read the notes";
    }
    case "running":
    case "waiting":
    case "paused":
    case "compensating": {
      return "Reading the notes";
    }
    default: {
      return run satisfies never;
    }
  }
};

/**
 * One reading, followed by its run's ID, however many runs came since.
 * Once its run is done, reviewing it keeps what it found as a draft.
 */
const ReadingItem = ({
  read,
  onReview,
  onDismiss,
}: {
  read: Reading;
  onReview: (read: Reading, found: Found) => void;
  onDismiss: (run: string) => void;
}) => {
  const run = useWorkflow(workflows.extract, { runId: read.id });
  const ended = run.status === "failed" || run.status === "cancelled";
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{read.title}</span>
      <span>{statusOf(run)}</span>
      {run.status === "completed" ? (
        <Button
          variant="outline"
          aria-label={`Review the statements from ${read.title}`}
          onClick={() => {
            onReview(read, run.output);
          }}
        >
          Review
        </Button>
      ) : null}
      {ended ? (
        <Button
          variant="ghost"
          onClick={() => {
            onDismiss(read.id);
          }}
        >
          Dismiss
        </Button>
      ) : null}
    </li>
  );
};

/**
 * The notes this screen sent to be read, newest first, each as its run
 * says it is doing: reading, failed, or ready to review as a draft. What
 * a reading found becomes a draft only once it is reviewed here: one this
 * screen let go of (closed or reloaded before it was reviewed) keeps
 * nothing.
 */
export const Extractions = ({
  started,
  onReview,
  onDismiss,
}: {
  /** The readings this screen started, newest first. */
  started: Reading[];
  onReview: (read: Reading, found: Found) => void;
  onDismiss: (run: string) => void;
}) =>
  started.length === 0 ? null : (
    <section aria-label="Notes being read" className="flex flex-col gap-2">
      <h2 className="font-medium">Notes being read</h2>
      <ul className="flex flex-col gap-2">
        {started.map((read) => (
          <ReadingItem
            key={read.id}
            read={read}
            onReview={onReview}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
    </section>
  );
