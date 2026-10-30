import type { ToolClassAudience } from "@grasp-os/shared/connect";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import type { StephenWeek } from "@grasp-os/shared/stephen-requests";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Switch } from "@grasp-os/ui/components/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatNumber, formatPercent } from "../format.ts";
import { useAskGrasp } from "../workflows/requests/request-needs.tsx";
import { AudienceControl, audienceOf, chosenOf } from "./stephen-audience.tsx";

// Stephen himself, on top of Settings › Stephen, as the prototype's
// `components/stephen/stephen-card.tsx`: his name, whether he is on
// outside Grasp, who can talk to him wherever they reach him, how he is
// doing (core's `stephenRequests.week`), and what five or more people
// asked that he did not know, with the role to ask. Counts only: never
// what anyone wrote, and never per person.

/** A bar's height by its share of the tallest week: static classes, no inline style. */
const barHeights = [
  "h-1",
  "h-1.5",
  "h-2",
  "h-3",
  "h-4",
  "h-5",
  "h-6",
  "h-7",
  "h-8",
  "h-9",
  "h-10",
] as const;

/** People who asked him something, a bar per week, this week in ink. The words beside it say the numbers. */
const WeekBars = ({ weeks }: { weeks: StephenWeek["weeks"] }) => {
  const most = Math.max(1, ...weeks.map(({ people }) => people));
  return (
    <div aria-hidden="true" className="flex h-10 flex-none items-end gap-1">
      {weeks.map((each, index) => (
        <span
          className={cn(
            "w-3 rounded-xs",
            barHeights[
              Math.round((each.people / most) * (barHeights.length - 1))
            ],
            index === weeks.length - 1
              ? "bg-foreground"
              : "bg-muted-foreground/40"
          )}
          key={each.week}
        />
      ))}
    </div>
  );
};

/** How he is doing: who asked him this week against who can, and the share of questions he answered. */
const Usage = ({ week }: { week: StephenWeek }) => {
  const { t } = useLingui();
  if (week.questions === 0) {
    return (
      <p className="text-muted-foreground border-t pt-3">
        <Trans>Nobody asked him anything yet.</Trans>
      </p>
    );
  }
  const asked = formatNumber(week.asked);
  const reach = formatNumber(week.reach);
  const share = formatPercent(week.answeredShare ?? 0);
  const answered = formatNumber(week.answered);
  const questions = formatNumber(week.questions);
  return (
    <div className="flex items-center gap-5 border-t pt-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">{t`${asked} of ${reach} asked him this week`}</p>
        <Tooltip>
          <TooltipTrigger
            render={<p className="text-muted-foreground w-fit" />}
          >
            {t`${share} of questions answered · 30 days`}
          </TooltipTrigger>
          <TooltipContent>{t`${answered} of ${questions} questions`}</TooltipContent>
        </Tooltip>
      </div>
      <WeekBars weeks={week.weeks} />
    </div>
  );
};

/** One question he did not know: how many asked and who knows, and Grasp asks that role in the corner chat. */
const UnknownRow = ({ row }: { row: StephenWeek["unanswered"][number] }) => {
  const { t } = useLingui();
  const { busy, failure, ask } = useAskGrasp();
  const asked = formatNumber(row.people);
  const { wording } = row;
  const { role } = row;
  return (
    <li className="flex items-start gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>{wording}</span>
        <span className="text-muted-foreground">
          {role === null
            ? t`${asked} asked`
            : t`${asked} asked · ${role} knows`}
        </span>
        <ErrorText>{failure}</ErrorText>
      </div>
      <Button
        disabled={busy}
        onClick={() => {
          void ask(
            wording,
            role === null
              ? t`Five or more people asked Stephen “${wording}” and he didn't know. Who in the company can answer it, so he knows it from now on?`
              : t`Five or more people asked Stephen “${wording}” and he didn't know. Ask the ${role} for the answer, so he knows it from now on.`
          );
        }}
        size="sm"
        variant="outline"
      >
        {role === null ? t`Ask` : t`Ask the ${role}`}
      </Button>
    </li>
  );
};

/** Stephen's card: on or paused, who can talk to him, how he is doing, and what he did not know. */
export const StephenCard = ({
  reach,
  week,
  can,
  onReach,
}: {
  reach: StephenReach;
  week: StephenWeek | null;
  can: boolean;
  onReach: (on: boolean, audience: ToolClassAudience) => Promise<void>;
}) => {
  const { t } = useLingui();
  const [pausing, setPausing] = useState(false);
  return (
    <section aria-label="Stephen">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Stephen</h2>
          </CardTitle>
          <CardAction>
            <span className="flex items-center gap-3">
              <span className="text-muted-foreground">
                {reach.on ? t`On` : t`Paused outside Grasp`}
              </span>
              <Switch
                aria-label={t`Stephen outside Grasp`}
                checked={reach.on}
                disabled={!can}
                onCheckedChange={(on) => {
                  if (on) {
                    void onReach(true, reach.audience);
                    return;
                  }
                  setPausing(true);
                }}
              />
            </span>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
            <span>
              <Trans>Who can talk to him</Trans>
            </span>
            <AudienceControl
              editable={can}
              key={JSON.stringify(reach.audience)}
              label={t`Who can talk to him`}
              offers={["everyone", "teams", "nobody"]}
              teams={reach.teams}
              value={chosenOf(reach.audience)}
              onSave={async (chosen) => {
                await onReach(reach.on, audienceOf(chosen));
              }}
            />
          </div>
          {week === null ? null : <Usage week={week} />}
          {week === null || week.unanswered.length === 0 ? null : (
            <div className="border-t pt-3">
              <h3 className="text-muted-foreground">
                <Trans>What he didn’t know</Trans>
              </h3>
              <ul>
                {week.unanswered.map((row) => (
                  <UnknownRow key={row.question} row={row} />
                ))}
              </ul>
            </div>
          )}
        </CardContent>
        <AlertDialog onOpenChange={setPausing} open={pausing}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Pause Stephen outside Grasp?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  He stops answering everywhere outside Grasp, and says so once
                  to whoever writes. Grasp’s chat keeps working.
                </Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  void onReach(false, reach.audience);
                }}
              >
                <Trans>Pause</Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Card>
    </section>
  );
};
