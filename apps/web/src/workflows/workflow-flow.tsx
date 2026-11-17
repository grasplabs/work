import { failureText } from "@grasp-os/shared/errors";
import type { DiagramTask } from "@grasp-os/shared/workflow-diagrams";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type { WorkflowDraft } from "@grasp-os/shared/workflow-resources";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { Button } from "../grasp/button/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import {
  Code,
  Fit,
  Icon,
  Play,
  Rows,
  Split,
  Tick,
  ZoomIn,
  ZoomOut,
} from "../grasp/icons/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";
import { withHeldCheckpoint } from "./definition-editor.tsx";
import { stepFieldsAt } from "./step-body.ts";
import { WorkflowDiagramView } from "./workflow-diagram.tsx";
import type { Layout } from "./workflow-diagram.tsx";

// A workflow's Flow (GRA-1402): the page opens on its definition drawn,
// as the prototype's workflow canvas has it. On a dotted ground, with
// fit, zoom and layout at its top left, it reads from where it starts,
// through its steps (the diagram core drew from the draft's checkpoint,
// `workflow-diagram.tsx`), to where it ends. Its builders open a step to
// change it (core's `editStep`, GRA-514), saved as the draft's next
// revision and checked like any edit; the JSON behind it stays one click
// away, in its Settings' Definition. Its toolbar, its sheet and its empty
// state are the library's; the canvas itself (its dotted ground, its zoom
// and its nodes' cards) keeps its Tailwind classes until it moves whole.

/** How many lines a step's field shows before its text scrolls. */
const STEP_ROWS = 16;

const styles = stylex.create({
  // The toolbar over the canvas, at its top left, and Edit JSON at its top right.
  controls: {
    position: "absolute",
    insetBlockStart: grasp.space3,
    insetInlineStart: grasp.space3,
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    padding: grasp.space1,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
  },
  json: {
    position: "absolute",
    insetBlockStart: grasp.space3,
    insetInlineEnd: grasp.space3,
    zIndex: 1,
  },
  empty: { margin: "auto", maxWidth: grasp.emptyMeasure },
  form: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  conflict: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space2,
  },
  attention: { margin: 0, color: grasp.attention },
  caption: {
    margin: 0,
    paddingInline: grasp.space4,
    paddingBlockEnd: grasp.space3,
    color: grasp.attention,
  },
  muted: { color: grasp.muted },
  // It fills the room the page gives it; the canvas's controls stand over it.
  flow: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
  },
  over: { position: "relative" },
  done: { color: grasp.success },
});

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
const Starts = ({ onTriggers }: { onTriggers: () => void }) => {
  const { t } = useLingui();
  return (
    <div className="bg-card node-sheet flex w-56 flex-none items-start gap-3 rounded-xl p-3">
      <span {...stylex.props(styles.muted)}>
        <Icon icon={Play} />
      </span>
      <div className="flex flex-col items-start gap-1">
        <Text element="span" size="xs" tone="muted">
          {t({ message: "Starts", context: "where a workflow starts" })}
        </Text>
        <Button onClick={onTriggers} size="xs" variant="ghost">
          {t`See what starts it`}
        </Button>
      </div>
    </div>
  );
};

/** Where it ends, at the foot of the drawing. */
const Done = () => {
  const { t } = useLingui();
  return (
    <div className="bg-card node-sheet flex flex-none items-center gap-2 rounded-xl px-3 py-2">
      <span {...stylex.props(styles.done)}>
        <Icon icon={Tick} />
      </span>
      <Text element="span" size="sm" weight="medium">
        {t({ message: "Done", context: "where a workflow ends" })}
      </Text>
    </div>
  );
};

/** What the last change of a step came to, when it didn't simply pass. */
type Outcome =
  | { kind: "conflict" }
  | { kind: "failing"; revision: number }
  | { kind: "failed"; reason: string };

/** A step's fields as JSON, changed and saved as the draft's next revision. */
const StepForm = ({
  workflow,
  draft,
  task,
  fields,
  onDraft,
  onDone,
}: {
  workflow: string;
  draft: WorkflowDraft;
  task: DiagramTask;
  fields: Record<string, unknown>;
  onDraft: (draft: WorkflowDraft) => void;
  onDone: () => void;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [text, setText] = useState(() => JSON.stringify(fields, null, 2));
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
            edit: { kind: "change", pointer: task.pointer, step: changed },
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
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      {...stylex.props(styles.form)}
    >
      <Field>
        <FieldLabel>{t`The step, as JSON`}</FieldLabel>
        <Textarea
          autoResize={false}
          onValueChange={setText}
          rows={STEP_ROWS}
          spellCheck={false}
          value={text}
        />
      </Field>
      <div>
        <Button disabled={busy} type="submit" variant="ink">
          {busy ? t`Checking…` : t`Check and save`}
        </Button>
      </div>
      {savedRevision === null ? null : (
        <p {...stylex.props(styles.attention)}>
          {t`Saved as revision ${savedRevision}, but it doesn't pass yet: Definition says what to fix.`}
        </p>
      )}
      {outcome?.kind === "conflict" ? (
        <div {...stylex.props(styles.conflict)}>
          <ErrorText>
            {t`Someone changed this draft since you read it. Read it again, then change the step.`}
          </ErrorText>
          <Button
            disabled={busy}
            onClick={() => {
              void reload();
            }}
            size="sm"
            variant="quiet"
          >
            {t`Read it again`}
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
  const fields =
    task === null || draft.checkpoint === null
      ? undefined
      : stepFieldsAt(draft.checkpoint.source, task.pointer);
  const { t } = useLingui();
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={task !== null}
    >
      <SheetContent closeLabel={t`Close`}>
        <SheetTitle>{task?.id ?? ""}</SheetTitle>
        <SheetDescription>{task?.label ?? task?.kind ?? ""}</SheetDescription>
        <SheetBody>
          {task === null || fields === undefined ? null : (
            <StepForm
              draft={draft}
              fields={fields}
              // Each step, and each revision of it, opens afresh.
              key={`${task.pointer} ${draft.revision}`}
              onDone={onClose}
              onDraft={onDraft}
              task={task}
              workflow={workflow}
            />
          )}
        </SheetBody>
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
    <div {...stylex.props(styles.controls)}>
      <Button
        aria-label={t`Fit to view`}
        icon={Fit}
        onClick={onFit}
        size="sm"
        variant="ghost"
      />
      <Button
        aria-label={t`Zoom out`}
        disabled={zoom === 0}
        icon={ZoomOut}
        onClick={() => {
          onZoom(zoom - 1);
        }}
        size="sm"
        variant="ghost"
      />
      <Button
        aria-label={t`Zoom in`}
        disabled={zoom === zooms.length - 1}
        icon={ZoomIn}
        onClick={() => {
          onZoom(zoom + 1);
        }}
        size="sm"
        variant="ghost"
      />
      {layout === "side" ? (
        <Button
          aria-label={t`Lay it out top to bottom`}
          icon={Rows}
          onClick={() => {
            onLayout("stacked");
          }}
          size="sm"
          variant="ghost"
        />
      ) : (
        <Button
          aria-label={t`Lay it out left to right`}
          icon={Split}
          onClick={() => {
            onLayout("side");
          }}
          size="sm"
          variant="ghost"
        />
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
  // Said only while the draft's newest revision doesn't pass: the Flow
  // then still draws the last one that did.
  return checkpointRevision === revision ? null : (
    <p {...stylex.props(styles.caption)}>
      {t`Revision ${revision} doesn't pass yet: fix it under Definition to change steps here. The Flow shows revision ${checkpointRevision}.`}
    </p>
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
  /** Shows the JSON behind it, in its Settings' Definition. */
  onDefinition: () => void;
  /** Shows what starts it, in its Settings' Triggers. */
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
  // It fills the room the page gives it, edge to edge, the ground taking
  // what its caption leaves.
  return (
    <div {...stylex.props(styles.flow)}>
      <div {...stylex.props(styles.flow, styles.over)}>
        <Controls
          layout={layout}
          onFit={fit}
          onLayout={setLayout}
          onZoom={setZoom}
          zoom={zoom}
        />
        <Button
          icon={Code}
          layout={styles.json}
          onClick={onDefinition}
          size="sm"
          variant="quiet"
        >
          {t`Edit JSON`}
        </Button>
        <div
          className="dot-ground flex min-h-96 flex-1 flex-col overflow-auto px-8 pt-20 pb-12"
          data-ground=""
          ref={room}
        >
          {checkpoint === null ? (
            // Nothing passed yet, as a new workflow starts: its builders
            // tell Grasp how the work runs, in its chat beside the Flow.
            <Empty layout={styles.empty} size="inline">
              {t`Nothing is drawn yet. Tell Grasp in the chat how this work runs and its steps come here.`}
            </Empty>
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
