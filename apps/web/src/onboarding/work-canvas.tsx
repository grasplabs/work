import type { DrawnWork } from "@grasp-os/shared/admin/org-record";
import { Badge } from "@grasp-os/ui/components/badge";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";

// A piece of work on the canvas, as it runs today (prototype
// `work-record.tsx`, `WorkCanvas`, and `workflowOfDrawn` in
// `drawn-workflow.ts`): its steps in blocks, as a workflow's diagram shows
// its tasks (../workflows/workflow-diagram.tsx), with who does each and
// where, and under a step the cases that go off the usual way after it.
// Nothing here can be changed: it is what was said. A step opens who told
// it, beside the canvas.

/** How long a step takes, as people said it: a normal one, and the quickest and longest when they differ. */
const MinutesBadge = ({
  minutes,
}: {
  minutes: [number, number, number] | null;
}) => {
  const { t } = useLingui();
  if (minutes === null) {
    return null;
  }
  const [quickest, usual, longest] = minutes;
  return (
    <Badge variant="outline">
      {quickest === longest
        ? t`${usual} min`
        : t`${usual} min, ${quickest} to ${longest}`}
    </Badge>
  );
};

/** A case that goes off the usual way after a step. */
const Case = ({ each }: { each: DrawnWork["differently"][number] }) => {
  const { t } = useLingui();
  const share = each.outOfTen;
  const { when } = each;
  return (
    <li className="bg-card flex flex-col gap-1 rounded-lg border border-dashed p-3">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{t`When ${when}`}</span>
        <Badge variant="outline">
          {share === null ? t`How often is not known` : t`About ${share} in 10`}
        </Badge>
      </span>
      {each.does === "" ? null : <span>{each.does}</span>}
    </li>
  );
};

export const WorkCanvas = ({
  drawn,
  selected,
  onSelect,
}: {
  drawn: DrawnWork | null;
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
  const { starts } = drawn;
  return (
    <div className="flex flex-col gap-2 p-4">
      {starts === "" ? null : (
        <p className="text-muted-foreground">{t`Starts when: ${starts}`}</p>
      )}
      <ol aria-label={t`The steps`} className="flex flex-col gap-2">
        {drawn.steps.map((step, index) => {
          const number = index + 1;
          const cases = drawn.differently.filter(
            ({ after }) => after === index
          );
          const open = selected === index;
          return (
            <li className="flex flex-col gap-2" key={`${number} ${step.text}`}>
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
                  <span className="min-w-0">{step.text}</span>
                </span>
                <span className="flex flex-wrap gap-1.5 pl-7">
                  {step.who === "" ? null : (
                    <Badge variant="secondary">{step.who}</Badge>
                  )}
                  {step.tool === "" ? null : (
                    <Badge variant="outline">{step.tool}</Badge>
                  )}
                  <MinutesBadge minutes={step.minutes} />
                  {drawn.differs?.step === index ? (
                    <Badge variant="outline">{t`Told two ways`}</Badge>
                  ) : null}
                </span>
              </button>
              {cases.length === 0 ? null : (
                <ul
                  aria-label={t`Off the usual way after step ${number}`}
                  className="ml-7 flex flex-col gap-2 border-l pl-3"
                >
                  {cases.map((each) => (
                    <Case each={each} key={each.when} />
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
