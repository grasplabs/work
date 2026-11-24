import { draftErrors } from "@grasp-os/shared/drafts";
import { failureText } from "@grasp-os/shared/errors";
import type {
  DiagramTask,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import type { WorkflowDraft } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  CheckIcon,
  CodeIcon,
  Icon,
  PlayIcon,
  TableIcon,
} from "@grasp-os/ui/lib/icons";
import {
  colors,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import {
  FitToScreenIcon,
  SplitIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./icons.ts";
import { stepFieldsAt } from "./step-body.ts";
import { WorkflowDiagramView } from "./workflow-diagram.tsx";
import type { Layout } from "./workflow-diagram.tsx";

// A workflow's Flow (GRA-1402): the page opens on its definition drawn,
// as the prototype's workflow canvas has it. On a dotted ground, with
// fit, zoom and layout at its top left, it reads from where it starts,
// through its steps (the diagram core drew from the draft, while it has
// no problems, `workflow-diagram.tsx`), to where it ends. Its builders open a step to
// change it (core's `define`, GRA-514), saved as the draft's next
// revision and checked like any edit; the JSON behind it stays one click
// away, in its Settings' Definition. Its toolbar, its sheet and its empty
// state are Damsko's; its dotted ground, its zoom and its nodes'
// cards are laid out here, on Damsko's tokens.

/** How many lines a step's field shows before its text scrolls. */
const STEP_ROWS = 16;

const styles = stylex.create({
  // The toolbar over the canvas, at its top left, and Edit JSON at its top right.
  controls: {
    position: "absolute",
    insetBlockStart: space["3"],
    insetInlineStart: space["3"],
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    padding: space["1"],
    borderRadius: radius.base,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
  },
  // Edit JSON, at the canvas's top right: a Button takes its layout from
  // what holds it.
  json: {
    position: "absolute",
    insetBlockStart: space["3"],
    insetInlineEnd: space["3"],
    zIndex: 1,
  },
  empty: { margin: "auto", maxWidth: size.emptyMeasure },
  form: { display: "flex", flexDirection: "column", gap: space["4"] },
  conflict: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["2"],
  },
  attention: { margin: 0, color: colors.warning },
  caption: {
    margin: 0,
    paddingInline: space["4"],
    paddingBlockEnd: space["3"],
    color: colors.warning,
  },
  muted: { color: colors.mutedForeground },
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
  done: { color: colors.success },
  // The dotted ground the steps lie on: a fine grid of dots in the page's
  // own hairline ink, on its soft surface.
  ground: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: "24rem",
    overflow: "auto",
    paddingInline: space["8"],
    paddingBlockStart: space["20"],
    paddingBlockEnd: space["12"],
    backgroundColor: colors.muted,
    backgroundImage: `radial-gradient(circle at center, ${colors.border} 1px, transparent 1.4px)`,
    backgroundSize: `${space["4"]} ${space["4"]}`,
  },
  // In the middle of the ground while it fits; from its start once larger.
  drawing: { margin: "auto", width: "max-content" },
  // A node: a small sheet lifted off the dotted ground.
  node: {
    display: "flex",
    flexShrink: 0,
    backgroundColor: colors.card,
    borderRadius: radius.base,
    cornerShape: radius.shape,
    boxShadow: shadow.sm,
  },
  starts: {
    width: "14rem",
    alignItems: "flex-start",
    gap: space["3"],
    padding: space["3"],
  },
  startsText: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
  },
  ends: {
    alignItems: "center",
    gap: space["2"],
    paddingInline: space["3"],
    paddingBlock: space["2"],
  },
  // CSS zoom, not a transform: the drawing takes the room it shows at, so
  // it centres and scrolls as it is seen.
  zoom50: { zoom: 0.5 },
  zoom75: { zoom: 0.75 },
  zoom90: { zoom: 0.9 },
  zoom100: { zoom: 1 },
  zoom110: { zoom: 1.1 },
  zoom125: { zoom: 1.25 },
  zoom150: { zoom: 1.5 },
});

/** The zooms the canvas steps through, each a scale of its own. */
const zooms = [
  { scale: 0.5, style: styles.zoom50 },
  { scale: 0.75, style: styles.zoom75 },
  { scale: 0.9, style: styles.zoom90 },
  { scale: 1, style: styles.zoom100 },
  { scale: 1.1, style: styles.zoom110 },
  { scale: 1.25, style: styles.zoom125 },
  { scale: 1.5, style: styles.zoom150 },
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
    <div {...stylex.props(styles.node, styles.starts)}>
      <span {...stylex.props(styles.muted)}>
        <Icon icon={PlayIcon} />
      </span>
      <div {...stylex.props(styles.startsText)}>
        <Text as="span" color="muted" size="xs">
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
    <div {...stylex.props(styles.node, styles.ends)}>
      <span {...stylex.props(styles.done)}>
        <Icon icon={CheckIcon} />
      </span>
      <Text as="span" size="sm" weight="medium">
        {t({ message: "Done", context: "where a workflow ends" })}
      </Text>
    </div>
  );
};

/** What the last change of a step came to, when it didn't simply pass. */
type Outcome =
  | { kind: "conflict" }
  | { kind: "failing" }
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
          await session.workflowResources.define(workflow, {
            revision: draft.revision,
            edit: { kind: "change", pointer: task.pointer, step: changed },
          })
      );
    } catch (error) {
      setOutcome(
        draftErrors.codeOf(error) === "draft.conflict"
          ? { kind: "conflict" }
          : { kind: "failed", reason: failureText(error) }
      );
      setBusy(false);
      return;
    }
    setBusy(false);
    onDraft(saved);
    if (saved.diagram === null) {
      setOutcome({ kind: "failing" });
    } else {
      onDone();
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
        <Button disabled={busy} type="submit">
          {busy ? t`Checking…` : t`Check and save`}
        </Button>
      </div>
      {/* Saved, and it doesn't pass: the sheet stays open. */}
      {outcome?.kind === "failing" ? (
        <p {...stylex.props(styles.attention)}>
          {t`Saved, but it doesn't pass yet: Definition says what to fix.`}
        </p>
      ) : null}
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
            variant="outline"
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
    task === null ? undefined : stepFieldsAt(draft.source, task.pointer);
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
        <SheetHeader>
          <SheetTitle>{task?.id ?? ""}</SheetTitle>
          <SheetDescription>{task?.label ?? task?.kind ?? ""}</SheetDescription>
        </SheetHeader>
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
        onClick={onFit}
        size="icon-sm"
        variant="ghost"
      >
        <Icon icon={FitToScreenIcon} />
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
        <Icon icon={ZoomOutIcon} />
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
        <Icon icon={ZoomInIcon} />
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
          <Icon icon={TableIcon} />
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
          <Icon icon={SplitIcon} />
        </Button>
      )}
    </div>
  );
};

/**
 * Why a step can't be changed, while the draft doesn't pass: the Flow
 * then still draws it as it last passed here.
 */
const Caption = () => {
  const { t } = useLingui();
  return (
    <p {...stylex.props(styles.caption)}>
      {t`The draft doesn't pass yet: fix it under Definition to change steps here. The Flow shows it as it last passed.`}
    </p>
  );
};

/**
 * The diagram to draw: the draft's, or, while it has problems and none,
 * the one drawn last on this page.
 */
const useDrawn = (draft: WorkflowDraft): WorkflowDiagram | null => {
  const [drawn, setDrawn] = useState(draft.diagram);
  if (draft.diagram !== null && draft.diagram !== drawn) {
    setDrawn(draft.diagram);
  }
  return draft.diagram ?? drawn;
};

/**
 * The Flow of a workflow, drawn from its draft, for its builders:
 * `onDraft` takes each draft a change here saves.
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
  const diagram = useDrawn(draft);
  // A step is changed on the draft it was drawn from: while the draft
  // doesn't pass, the drawing is of an earlier one, and stays as it is.
  const changeable = draft.diagram !== null;

  const fit = (): void => {
    setZoom(fitting(drawing.current, room.current));
    room.current?.scrollTo({ left: 0, top: 0 });
  };
  // As the prototype's canvas opens: the whole of it in view.
  useEffect(() => {
    setZoom(fitting(drawing.current, room.current));
  }, []);

  const { style: scale } = zooms[zoom] ?? zooms[unzoomed];
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
        <div {...stylex.props(styles.json)}>
          <Button onClick={onDefinition} size="sm" variant="outline">
            <Icon icon={CodeIcon} />
            {t`Edit JSON`}
          </Button>
        </div>
        <div {...stylex.props(styles.ground)} data-ground="" ref={room}>
          {diagram === null ? (
            // Nothing passed yet, as a new workflow starts: its builders
            // tell Grasp how the work runs, in its chat beside the Flow.
            <Empty size="sm" style={styles.empty}>
              <EmptyHeader>
                <EmptyDescription>{t`Nothing is drawn yet. Tell Grasp in the chat how this work runs and its steps come here.`}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            // In the middle of the ground while it fits; from its start
            // once it is larger, so all of it scrolls into view.
            <div {...stylex.props(styles.drawing, scale)} ref={drawing}>
              <WorkflowDiagramView
                canvas={{
                  layout,
                  start: <Starts onTriggers={onTriggers} />,
                  end: <Done />,
                  onStep: changeable ? setStep : undefined,
                }}
                diagram={diagram}
                label={t`Diagram`}
              />
            </div>
          )}
        </div>
      </div>
      {changeable ? null : <Caption />}
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
