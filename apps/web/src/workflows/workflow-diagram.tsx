import type {
  DiagramNext,
  DiagramScope,
  DiagramTask,
  TraceState,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import { DoorBadge, DoorSheet, DoorsMenu } from "./diagram-doors.tsx";
import { doorsOf, partsOf } from "./diagram-parts.ts";
import type { DiagramPart, DoorPlace } from "./diagram-parts.ts";
import { flowWires } from "./flow-lines.ts";
import type { Box, Drawn } from "./flow-lines.ts";

// A workflow's diagram as core drew it from a definition that passed the
// profile: every task in order, by its ID, with every case, branch and
// list it declares, and where each goes next. The page draws nothing of
// its own: no task, branch or path that isn't in the diagram core sent.
// A run's trace, when given, marks the tasks that run's journal reached.
// Showing it runs nothing. A workflow drawn in named parts shows each as
// a frame, stacked or side by side as the reader chooses, joined by the
// line of the work (flow-lines.ts); its doors to other workflows are
// listed beside the drawing's controls (diagram-doors.tsx).

/** Where a task or case goes once done, in words; nothing for "next". */
const NextText = ({ next }: { next: DiagramNext | null }) => {
  const { t } = useLingui();
  if (next === null || next.kind === "continue") {
    return null;
  }
  if (next.kind === "end") {
    return <Badge variant="outline">{t`Ends the workflow`}</Badge>;
  }
  if (next.kind === "exit") {
    return <Badge variant="outline">{t`Leaves this list`}</Badge>;
  }
  const { task } = next;
  return <Badge variant="outline">{t`Then ${task}`}</Badge>;
};

/** How a run's journal left a task, in words. */
const StateBadge = ({ state }: { state: TraceState | undefined }) => {
  const { t } = useLingui();
  if (state === undefined) {
    return null;
  }
  const label = {
    reached: t`Reached`,
    running: t({ message: "Running", context: "an attempt of a step" }),
    waiting: t`Waiting`,
    failed: t`Failed`,
  }[state];
  return (
    <Badge variant={state === "failed" ? "attention" : "secondary"}>
      {label}
    </Badge>
  );
};

/** What a scope is, in words: a case and its condition, a branch, a loop. */
const ScopeHeading = ({ scope }: { scope: DiagramScope }) => {
  const { t } = useLingui();
  const name = scope.name ?? "";
  const heading = {
    case: scope.guarded
      ? t`Case ${name}, when it holds`
      : t`Otherwise: ${name}`,
    branch: t`Branch ${name}`,
    each: scope.guarded
      ? t`For each ${name}, while it holds`
      : t`For each ${name}`,
    try: t`Try`,
    catch: t`If it fails`,
    do: t`Steps`,
  }[scope.kind];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{heading}</span>
      <NextText next={scope.next} />
    </div>
  );
};

/** What a run's journal says of its tasks, by ID. */
interface Marks {
  states: ReadonlyMap<string, TraceState>;
  /** How many attempts each made; a task with one shows none. */
  attempts: ReadonlyMap<string, number>;
  /** The tasks to show, by pointer: those that lead through a door gone to. */
  shown: ReadonlySet<string>;
}

const TaskList = ({
  tasks,
  marks,
}: {
  tasks: readonly DiagramTask[];
  marks: Marks;
}) => (
  <ol className="flex flex-col gap-2">
    {tasks.map((task) => (
      // eslint-disable-next-line no-use-before-define -- tasks nest in tasks
      <TaskItem key={task.pointer} marks={marks} task={task} />
    ))}
  </ol>
);

const TaskItem = ({ task, marks }: { task: DiagramTask; marks: Marks }) => {
  const { t } = useLingui();
  const state = marks.states.get(task.id);
  const attempts = marks.attempts.get(task.id) ?? 0;
  return (
    <li
      aria-label={task.id}
      className={cn(
        "bg-card flex flex-col gap-2 rounded-lg border p-3 transition-shadow",
        marks.shown.has(task.pointer) && "ring-ring/50 ring-3"
      )}
      data-pointer={task.pointer}
      data-state={state ?? "none"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-medium">{task.id}</code>
        <Badge variant="outline">{task.kind}</Badge>
        {task.label === null ? null : <span>{task.label}</span>}
        {task.detail === null ? null : (
          <span className="text-muted-foreground">{task.detail}</span>
        )}
        {task.guarded ? (
          <Badge variant="outline">{t`Only if its condition holds`}</Badge>
        ) : null}
        <NextText next={task.next} />
        <StateBadge state={state} />
        {attempts > 1 ? (
          <Badge variant="outline">
            <Plural one="# attempt" other="# attempts" value={attempts} />
          </Badge>
        ) : null}
        {(task.doors ?? []).map((door) => (
          <DoorBadge
            door={door}
            key={`${door.workflowId ?? ""} ${door.flow}`}
          />
        ))}
      </div>
      {task.scopes.length === 0 ? null : (
        <div className="flex flex-col gap-3 border-l pl-3">
          {task.scopes.map((scope) => (
            <div
              className="flex flex-col gap-2"
              key={`${scope.kind} ${scope.name ?? ""}`}
            >
              <ScopeHeading scope={scope} />
              {scope.tasks.length === 0 ? null : (
                <TaskList marks={marks} tasks={scope.tasks} />
              )}
            </div>
          ))}
        </div>
      )}
    </li>
  );
};

/** No run shown: no task marked. */
const noStates: ReadonlyMap<string, TraceState> = new Map();
const noAttempts: ReadonlyMap<string, number> = new Map();

/** How the parts stand: one under the other, or side by side. */
type Layout = "stacked" | "side";

/** Where each part's frame stands in the drawing, measured, for its lines. */
const useFrameLines = () => {
  const drawing = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<Drawn[]>([]);
  useEffect(() => {
    // Measured whenever the drawing or any frame in it changes size:
    // parts stacked or side by side, a task opened in one frame (which
    // moves the frames after it without resizing the drawing); and each
    // frame watched as it comes, a part more or less.
    const observer = new ResizeObserver(() => {
      const element = drawing.current;
      if (element === null) {
        return;
      }
      const origin = element.getBoundingClientRect();
      const boxes = [...element.querySelectorAll("[data-part]")].map(
        (frame, index) => {
          const rect = frame.getBoundingClientRect();
          const box: Box = {
            left: rect.left - origin.left + element.scrollLeft,
            top: rect.top - origin.top,
            right: rect.right - origin.left + element.scrollLeft,
            bottom: rect.bottom - origin.top,
          };
          return {
            id: String(index),
            box,
            foot: box.bottom,
            order: index,
            frame: box,
          };
        }
      );
      setWires(flowWires(boxes));
    });
    const watch = (): void => {
      const element = drawing.current;
      if (element === null) {
        return;
      }
      observer.disconnect();
      observer.observe(element);
      for (const frame of element.querySelectorAll("[data-part]")) {
        observer.observe(frame);
      }
    };
    const parts = new MutationObserver(watch);
    if (drawing.current !== null) {
      parts.observe(drawing.current, { childList: true });
    }
    watch();
    return () => {
      parts.disconnect();
      observer.disconnect();
    };
  }, []);
  return { drawing, wires };
};

/** The workflow in its named parts, each a frame, joined by the line of the work. */
const PartsFrames = ({
  parts,
  layout,
  marks,
}: {
  parts: readonly DiagramPart[];
  layout: Layout;
  marks: Marks;
}) => {
  const { t } = useLingui();
  const { drawing, wires } = useFrameLines();
  return (
    <div
      className={cn(
        "relative flex gap-12 p-1",
        layout === "side" ? "flex-row items-start overflow-x-auto" : "flex-col"
      )}
      ref={drawing}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        {wires.map((wire) => (
          <path
            className="stroke-border"
            d={wire.d}
            fill="none"
            key={wire.key}
            strokeWidth={1.5}
          />
        ))}
      </svg>
      {parts.map((part) => {
        const { n } = part;
        const name = part.name === "" ? t`Before the first part` : part.name;
        return (
          <section
            aria-label={t`Part ${n}: ${name}`}
            className={cn(
              "bg-muted/40 relative flex flex-col gap-3 rounded-xl border p-3",
              layout === "side" ? "w-96 flex-none" : "w-full"
            )}
            data-part={n}
            id={`workflow-part-${n}`}
            key={part.tasks[0]?.pointer ?? n}
          >
            <header className="flex flex-col gap-0.5">
              <h3 className="flex items-baseline gap-2 font-medium">
                <span className="text-muted-foreground tabular-nums">{n}</span>
                {name}
              </h3>
              {part.purpose === null ? null : (
                <p className="text-muted-foreground text-pretty">
                  {part.purpose}
                </p>
              )}
            </header>
            <TaskList marks={marks} tasks={part.tasks} />
          </section>
        );
      })}
    </div>
  );
};

/** Marks the tasks that lead through `door`, and brings the first into view. */
const showDoor = (door: DoorPlace): void => {
  const [first] = door.tasks;
  if (first === undefined) {
    return;
  }
  document
    .querySelector(`[data-pointer="${CSS.escape(first)}"]`)
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
};

/**
 * `diagram`, with the tasks a run reached marked as `states` says, and
 * the attempts each made: none when no run is shown. In named parts, as
 * frames; with its doors beside its controls.
 */
export const WorkflowDiagramView = ({
  diagram,
  states = noStates,
  attempts = noAttempts,
  label,
}: {
  diagram: WorkflowDiagram;
  states?: ReadonlyMap<string, TraceState>;
  attempts?: ReadonlyMap<string, number>;
  label: string;
}) => {
  const { t } = useLingui();
  const [layout, setLayout] = useState<Layout>("stacked");
  const [door, setDoor] = useState<DoorPlace | null>(null);
  const parts = partsOf(diagram);
  const doors = doorsOf(diagram);
  const marks: Marks = {
    states,
    attempts,
    shown: new Set(door?.tasks),
  };
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      {parts.length > 0 || doors.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {parts.length > 0 ? (
            <ToggleGroup
              aria-label={t`How the parts stand`}
              onValueChange={(value: unknown[]) => {
                const [next] = value;
                if (next === "stacked" || next === "side") {
                  setLayout(next);
                }
              }}
              size="sm"
              value={[layout]}
              variant="outline"
            >
              <ToggleGroupItem value="stacked">
                {t({
                  message: "Stacked",
                  context: "parts one under the other",
                })}
              </ToggleGroupItem>
              <ToggleGroupItem value="side">
                {t({ message: "Side by side", context: "parts in a row" })}
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          <DoorsMenu
            doors={doors}
            onGo={(chosen) => {
              setDoor(chosen);
              showDoor(chosen);
            }}
          />
        </div>
      ) : null}
      {diagram.tasks.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>It declares no tasks.</Trans>
        </p>
      ) : null}
      {diagram.tasks.length > 0 && parts.length === 0 ? (
        <TaskList marks={marks} tasks={diagram.tasks} />
      ) : null}
      {parts.length > 0 ? (
        <PartsFrames layout={layout} marks={marks} parts={parts} />
      ) : null}
      <DoorSheet
        door={door}
        onClose={() => {
          setDoor(null);
        }}
      />
    </section>
  );
};
