import { failureText } from "@grasp-os/shared/errors";
import type { DiagramTask } from "@grasp-os/shared/workflow-diagrams";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type { WorkflowDraft } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Label } from "@grasp-os/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { cn } from "@grasp-os/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  BracesIcon,
  CheckIcon,
  Columns3Icon,
  LocateFixedIcon,
  Rows3Icon,
  ZapIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import { withHeldCheckpoint } from "./definition-editor.tsx";
import { stepBodyAt } from "./step-body.ts";
import { WorkflowDiagramView } from "./workflow-diagram.tsx";
import type { Layout } from "./workflow-diagram.tsx";

// A workflow's Flow (GRA-1402): the page opens on its definition drawn,
// as the prototype's workflow canvas has it. On a dotted ground, with
// fit, zoom and layout at its top left, it reads from where it starts,
// through its steps (the diagram core drew from the draft's checkpoint,
// `workflow-diagram.tsx`), to where it ends. Its builders open a step to
// change it (core's `editStep`, GRA-514), saved as the draft's next
// revision and checked like any edit; the JSON behind it stays one click
// away, on Definition.

/** The zooms the canvas steps through, each a scale of its own. */
const zooms = [
  { scale: 0.5, className: "zoom-50" },
  { scale: 0.75, className: "zoom-75" },
  { scale: 0.9, className: "zoom-90" },
  { scale: 1, className: "zoom-100" },
  { scale: 1.1, className: "zoom-110" },
  { scale: 1.25, className: "zoom-125" },
  { scale: 1.5, className: "zoom-150" },
] as const;

/** Where the canvas starts: as drawn, unzoomed. */
const unzoomed = 3;

/** The room the canvas keeps around the drawing, in pixels, each way. */
const margin = 96;

/**
 * The largest zoom at which `drawing`, as drawn, fits in `room`, never
 * above as drawn; the smallest when none fits. Unzoomed while either
 * isn't there.
 */
const fitting = (
  drawing: HTMLElement | null,
  room: HTMLElement | null
): number => {
  if (drawing === null || room === null) {
    return unzoomed;
  }
  // As drawn: an element's offset size leaves its zoom out.
  const width = drawing.offsetWidth;
  const height = drawing.offsetHeight;
  const ratio = Math.min(
    width === 0 ? 1 : (room.clientWidth - margin) / width,
    height === 0 ? 1 : (room.clientHeight - margin) / height
  );
  let chosen = 0;
  for (const [index, zoom] of zooms.entries()) {
    if (zoom.scale <= Math.min(ratio, 1)) {
      chosen = index;
    }
  }
  return chosen;
};

/** Where it starts, at the head of the drawing: its triggers, or by hand. */
const Starts = ({ onTriggers }: { onTriggers: () => void }) => (
  <div className="bg-card node-sheet flex w-56 flex-none items-start gap-3 rounded-xl p-3">
    <ZapIcon aria-hidden="true" className="text-muted-foreground mt-1 size-4" />
    <div className="flex flex-col items-start gap-1">
      <span className="text-muted-foreground text-xs">
        <Trans context="where a workflow starts">Starts</Trans>
      </span>
      <Button onClick={onTriggers} size="inline" variant="hint">
        <Trans>See what starts it</Trans>
      </Button>
    </div>
  </div>
);

/** Where it ends, at the foot of the drawing. */
const Done = () => (
  <div className="bg-card node-sheet flex flex-none items-center gap-2 rounded-xl px-3 py-2">
    <CheckIcon aria-hidden="true" className="text-status-agreed size-4" />
    <span className="font-medium">
      <Trans context="where a workflow ends">Done</Trans>
    </span>
  </div>
);

/** What the last change of a step came to, when it didn't simply pass. */
type Outcome =
  | { kind: "conflict" }
  | { kind: "failing"; revision: number }
  | { kind: "failed"; reason: string };

/** A step's body as JSON, changed and saved as the draft's next revision. */
const StepForm = ({
  workflow,
  draft,
  task,
  body,
  onDraft,
  onDone,
}: {
  workflow: string;
  draft: WorkflowDraft;
  task: DiagramTask;
  body: Record<string, unknown>;
  onDraft: (draft: WorkflowDraft) => void;
  onDone: () => void;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const id = useId();
  const [text, setText] = useState(() => JSON.stringify(body, null, 2));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  const save = async (): Promise<void> => {
    let changed: unknown;
    try {
      changed = JSON.parse(text);
    } catch {
      changed = undefined;
    }
    if (
      typeof changed !== "object" ||
      changed === null ||
      Array.isArray(changed)
    ) {
      setOutcome({ kind: "failed", reason: t`A step is a JSON object.` });
      return;
    }
    setBusy(true);
    setOutcome(undefined);
    let saved: WorkflowDraft;
    try {
      saved = await core.withSession(
        async (session) =>
          await session.workflowResources.editStep(workflow, {
            expectedRevision: draft.revision,
            edit: { kind: "change", pointer: task.pointer, body: changed },
          })
      );
    } catch (error) {
      setOutcome(
        workflowResourceErrors.codeOf(error) === "workflow.draft_conflict"
          ? { kind: "conflict" }
          : { kind: "failed", reason: failureText(error) }
      );
      setBusy(false);
      return;
    }
    setBusy(false);
    onDraft(withHeldCheckpoint(draft, saved));
    if (saved.checkpoint?.revision === saved.revision) {
      onDone();
    } else {
      setOutcome({ kind: "failing", revision: saved.revision });
    }
  };

  // Someone saved the draft since it was read: read it again, and the
  // step is opened afresh on what they saved.
  const reload = async (): Promise<void> => {
    setBusy(true);
    try {
      const latest = await core.withSession(
        async (session) => await session.workflowResources.draft(workflow)
      );
      onDraft(latest);
      onDone();
    } catch (error) {
      setOutcome({ kind: "failed", reason: failureText(error) });
    }
    setBusy(false);
  };

  // Saved, and the revision it saved doesn't pass: the sheet stays open.
  const savedRevision = outcome?.kind === "failing" ? outcome.revision : null;
  return (
    <form
      className="flex flex-col gap-4 px-6 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>
          <Trans>The step, as JSON</Trans>
        </Label>
        <Textarea
          className="min-h-72"
          id={id}
          onChange={(event) => {
            setText(event.target.value);
          }}
          spellCheck={false}
          value={text}
          variant="code"
        />
      </div>
      <Button className="self-start" disabled={busy} type="submit">
        {busy ? t`Checking…` : t`Check and save`}
      </Button>
      {savedRevision === null ? null : (
        <p className="text-status-attention">
          {t`Saved as revision ${savedRevision}, but it doesn't pass yet: Definition says what to fix.`}
        </p>
      )}
      {outcome?.kind === "conflict" ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorText>
            {t`Someone changed this draft since you read it. Read it again, then change the step.`}
          </ErrorText>
          <Button
            disabled={busy}
            onClick={() => {
              void reload();
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Read it again</Trans>
          </Button>
        </div>
      ) : null}
      <ErrorText>
        {outcome?.kind === "failed" ? outcome.reason : undefined}
      </ErrorText>
    </form>
  );
};

/** The step opened from the canvas, beside it. */
const StepSheet = ({
  workflow,
  draft,
  task,
  onDraft,
  onClose,
}: {
  workflow: string;
  draft: WorkflowDraft;
  task: DiagramTask | null;
  onDraft: (draft: WorkflowDraft) => void;
  onClose: () => void;
}) => {
  const body =
    task === null || draft.checkpoint === null
      ? undefined
      : stepBodyAt(draft.checkpoint.source, task.pointer);
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={task !== null}
    >
      <SheetContent>
        <div className="flex flex-col gap-1 border-b px-6 py-5 pr-14">
          <SheetTitle>{task?.id}</SheetTitle>
          <SheetDescription>{task?.label ?? task?.kind}</SheetDescription>
        </div>
        {task === null || body === undefined ? null : (
          <StepForm
            body={body}
            draft={draft}
            // Each step, and each revision of it, opens afresh.
            key={`${task.pointer} ${draft.revision}`}
            onDone={onClose}
            onDraft={onDraft}
            task={task}
            workflow={workflow}
          />
        )}
      </SheetContent>
    </Sheet>
  );
};

/** Fit, zoom and how it reads, at the canvas's top left. */
const Controls = ({
  zoom,
  layout,
  onFit,
  onZoom,
  onLayout,
}: {
  zoom: number;
  layout: Layout;
  onFit: () => void;
  onZoom: (next: number) => void;
  onLayout: (next: Layout) => void;
}) => {
  const { t } = useLingui();
  return (
    <div className="bg-card node-sheet absolute top-3 left-3 z-10 flex items-center gap-0.5 rounded-lg p-1">
      <Button
        aria-label={t`Fit to view`}
        onClick={onFit}
        size="icon-sm"
        variant="ghost"
      >
        <LocateFixedIcon aria-hidden="true" />
      </Button>
      <Button
        aria-label={t`Zoom out`}
        disabled={zoom === 0}
        onClick={() => {
          onZoom(zoom - 1);
        }}
        size="icon-sm"
        variant="ghost"
      >
        <ZoomOutIcon aria-hidden="true" />
      </Button>
      <Button
        aria-label={t`Zoom in`}
        disabled={zoom === zooms.length - 1}
        onClick={() => {
          onZoom(zoom + 1);
        }}
        size="icon-sm"
        variant="ghost"
      >
        <ZoomInIcon aria-hidden="true" />
      </Button>
      {layout === "side" ? (
        <Button
          aria-label={t`Lay it out top to bottom`}
          onClick={() => {
            onLayout("stacked");
          }}
          size="icon-sm"
          variant="ghost"
        >
          <Rows3Icon aria-hidden="true" />
        </Button>
      ) : (
        <Button
          aria-label={t`Lay it out left to right`}
          onClick={() => {
            onLayout("side");
          }}
          size="icon-sm"
          variant="ghost"
        >
          <Columns3Icon aria-hidden="true" />
        </Button>
      )}
    </div>
  );
};

/** What the drawing shows, in words, and why a step can't be changed. */
const Caption = ({
  draft,
  checkpointRevision,
}: {
  draft: WorkflowDraft;
  checkpointRevision: number;
}) => {
  const { t } = useLingui();
  const { revision } = draft;
  return (
    <div className="text-muted-foreground flex flex-col gap-1">
      <p>
        {checkpointRevision === 0
          ? t`Diagram of the current version`
          : t`Diagram of revision ${checkpointRevision}`}
      </p>
      {checkpointRevision === revision ? null : (
        <p className="text-status-attention">
          {t`Revision ${revision} doesn't pass yet: fix it under Definition to change steps here.`}
        </p>
      )}
    </div>
  );
};

/**
 * The Flow of a workflow, drawn from its draft's checkpoint, for its
 * builders: `onDraft` takes each draft a change here saves.
 */
export const WorkflowFlow = ({
  workflow,
  draft,
  onDraft,
  onDefinition,
  onTriggers,
}: {
  workflow: string;
  draft: WorkflowDraft;
  onDraft: (draft: WorkflowDraft) => void;
  /** Shows the JSON behind it, on Definition. */
  onDefinition: () => void;
  /** Shows what starts it, on Triggers. */
  onTriggers: () => void;
}) => {
  const { t } = useLingui();
  const [zoom, setZoom] = useState(unzoomed);
  const [layout, setLayout] = useState<Layout>("side");
  const [step, setStep] = useState<DiagramTask | null>(null);
  const room = useRef<HTMLDivElement>(null);
  const drawing = useRef<HTMLDivElement>(null);
  const { checkpoint } = draft;
  // A step is changed on the revision it was drawn from: while the latest
  // doesn't pass, the drawing is of an earlier one, and stays as it is.
  const changeable =
    checkpoint !== null && checkpoint.revision === draft.revision;

  const fit = (): void => {
    setZoom(fitting(drawing.current, room.current));
    room.current?.scrollTo({ left: 0, top: 0 });
  };
  // As the prototype's canvas opens: the whole of it in view.
  useEffect(() => {
    setZoom(fitting(drawing.current, room.current));
  }, []);

  const { className: scale } = zooms[zoom] ?? zooms[unzoomed];
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Controls
          layout={layout}
          onFit={fit}
          onLayout={setLayout}
          onZoom={setZoom}
          zoom={zoom}
        />
        <Button
          className="absolute top-3 right-3 z-10"
          onClick={onDefinition}
          size="sm"
          variant="outline"
        >
          <BracesIcon aria-hidden="true" data-icon="inline-start" />
          <Trans>Edit JSON</Trans>
        </Button>
        <div
          className="dot-ground flex h-128 flex-col overflow-auto rounded-xl border px-8 pt-20 pb-12"
          data-ground=""
          ref={room}
        >
          {checkpoint === null ? (
            <p className="text-muted-foreground text-center">
              <Trans>
                It is drawn once a revision passes the check: check and save it
                under Definition.
              </Trans>
            </p>
          ) : (
            // In the middle of the ground while it fits; from its start
            // once it is larger, so all of it scrolls into view.
            <div className={cn("m-auto w-max", scale)} ref={drawing}>
              <WorkflowDiagramView
                canvas={{
                  layout,
                  start: <Starts onTriggers={onTriggers} />,
                  end: <Done />,
                  onStep: changeable ? setStep : undefined,
                }}
                diagram={checkpoint.diagram}
                label={t`Diagram`}
              />
            </div>
          )}
        </div>
      </div>
      {checkpoint === null ? null : (
        <Caption checkpointRevision={checkpoint.revision} draft={draft} />
      )}
      <StepSheet
        draft={draft}
        onClose={() => {
          setStep(null);
        }}
        onDraft={onDraft}
        task={step}
        workflow={workflow}
      />
    </div>
  );
};
