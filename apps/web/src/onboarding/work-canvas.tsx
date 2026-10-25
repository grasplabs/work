import type { StaffDrawing } from "@grasp-os/shared/admin/org-record";
import { Badge } from "@grasp-os/ui/components/badge";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

// A piece of work on the canvas, as it runs today (prototype
// `work-record.tsx`, `WorkCanvas`, and `workflowOfDrawn` in
// `drawn-workflow.ts`): its steps in blocks, as a workflow's diagram shows
// its tasks (../workflows/workflow-diagram.tsx), and under a step the cases
// that go off the usual way after it.
// Staff see numbers only, never what anyone said (GRA-1084): each step by
// its place, how many told it, and its minutes once 5 or more gave them. A
// step opens how many told it, beside the canvas.

/**
 * How long a normal one of a step takes, once at least 5 people told the step: fewer, and staff
 * read only that (GRA-1079). Never one person's minutes.
 */
const MinutesBadge = ({
  minutes,
}: {
  minutes: StaffDrawing["steps"][number]["minutes"];
}) => {
  const { t } = useLingui();
  if (minutes.people === 0) {
    return null;
  }
  const { value } = minutes;
  return (
    <Badge variant="outline">
      {value === null ? t`Fewer than 5 people` : t`${value} min`}
    </Badge>
  );
};

/** A case that goes off the usual way after a step: how often, never what it is (GRA-1084). */
const Case = ({ each }: { each: StaffDrawing["differently"][number] }) => {
  const { t } = useLingui();
  const share = each.outOfTen.value;
  // Held back below 5 people (GRA-1079): only that shows.
  let shareText = t`How often is not known`;
  if (share !== null) {
    shareText = t`About ${share} in 10`;
  } else if (each.outOfTen.people !== 0) {
    shareText = t`Fewer than 5 people`;
  }
  return (
    <li className="bg-card flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3">
      <span className="text-muted-foreground">{t`A case off the usual way`}</span>
      <Badge variant="outline">{shareText}</Badge>
    </li>
  );
};

export const WorkCanvas = ({
  drawn,
  selected,
  onSelect,
}: {
  drawn: StaffDrawing | null;
  /** The step that is open, from 0. */
  selected: number | null;
  onSelect: (step: number | null) => void;
}) => {
  const { t } = useLingui();
  if (drawn === null || drawn.steps.length === 0) {
    return (
      <p className="text-muted-foreground m-auto max-w-sm px-5 py-10 text-center">
        {t`No steps yet. They are drawn once someone who does this work has agreed to their interview.`}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-4">
      <ol aria-label={t`The steps`} className="flex flex-col gap-2">
        {drawn.steps.map((step, index) => {
          const number = index + 1;
          const { people } = step;
          const cases = drawn.differently.flatMap((each, at) =>
            each.after === index ? [{ each, at }] : []
          );
          const open = selected === index;
          return (
            <li className="flex flex-col gap-2" key={number}>
              <button
                aria-pressed={open}
                className={cn(
                  "bg-card hover:bg-muted/50 focus-visible:ring-ring/50 flex flex-col gap-2 rounded-lg border p-3 text-left outline-none focus-visible:ring-3",
                  open ? "border-foreground" : undefined
                )}
                onClick={() => {
                  onSelect(open ? null : index);
                }}
                type="button"
              >
                <span className="flex gap-3">
                  <span className="text-muted-foreground w-4 flex-none text-right tabular-nums">
                    {number}
                  </span>
                  <span className="min-w-0">{t`Step ${number}`}</span>
                </span>
                <span className="flex flex-wrap gap-1.5 pl-7">
                  <Badge variant="secondary">
                    {plural(people, {
                      one: "Told by # person",
                      other: "Told by # people",
                    })}
                  </Badge>
                  <MinutesBadge minutes={step.minutes} />
                </span>
              </button>
              {cases.length === 0 ? null : (
                <ul
                  aria-label={t`Off the usual way after step ${number}`}
                  className="ml-7 flex flex-col gap-2 border-l pl-3"
                >
                  {cases.map(({ each, at }) => (
                    <Case each={each} key={at} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};
