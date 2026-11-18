import type { ToolClassAudience } from "@grasp-os/shared/connect";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import type { StephenWeek } from "@grasp-os/shared/stephen-requests";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatNumber, formatPercent } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  FactRow,
  SettingRow,
  SettingsRows,
} from "../grasp/setting-row/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useAskGrasp } from "../workflows/requests/request-needs.tsx";
import { SettingsSection } from "./settings-parts.tsx";
import { AudienceControl, audienceOf, chosenOf } from "./stephen-audience.tsx";
import { StephenAvatar } from "./stephen-avatar.tsx";

// Stephen himself, on top of Settings › Stephen, as the prototype's
// `components/stephen/stephen-card.tsx`: his name, whether he is on
// outside Grasp, who can talk to him wherever they reach him, how he is
// doing (core's `stephenRequests.week`), and what five or more people
// asked that he did not know, with the role to ask. Counts only: never
// what anyone wrote, and never per person.

const styles = stylex.create({
  // People who asked, a bar per week, along the row's end.
  bars: {
    display: "flex",
    alignItems: "flex-end",
    gap: grasp.space1,
    height: grasp.space10,
    flexShrink: 0,
  },
  bar: {
    width: grasp.space3,
    borderRadius: grasp.cornerMark,
    backgroundColor: grasp.quiet,
  },
  // This week, in ink.
  barNow: { backgroundColor: grasp.ink },
  // The switch and the words that say how he stands, in the card's head.
  state: { display: "inline-flex", alignItems: "center", gap: grasp.space3 },
});

/** A bar's height by its share of the tallest week, from the spacing scale. */
const barHeights = stylex.create({
  h1: { height: grasp.space1 },
  h2: { height: grasp.space2 },
  h3: { height: grasp.space3 },
  h4: { height: grasp.space4 },
  h5: { height: grasp.space5 },
  h6: { height: grasp.space6 },
  h7: { height: grasp.space7 },
  h8: { height: grasp.space8 },
  h10: { height: grasp.space10 },
});

const barSteps = [
  barHeights.h1,
  barHeights.h2,
  barHeights.h3,
  barHeights.h4,
  barHeights.h5,
  barHeights.h6,
  barHeights.h7,
  barHeights.h8,
  barHeights.h10,
] as const;

/** The step of a week's bar: its share of the tallest week. */
const barStep = (people: number, most: number) =>
  barSteps[Math.round((people / most) * (barSteps.length - 1))];

/** People who asked him something, a bar per week, this week in ink. The words beside it say the numbers. */
const WeekBars = ({ weeks }: { weeks: StephenWeek["weeks"] }) => {
  const most = Math.max(1, ...weeks.map(({ people }) => people));
  return (
    <div aria-hidden="true" {...stylex.props(styles.bars)}>
      {weeks.map((each, index) => (
        <span
          key={each.week}
          {...stylex.props(
            styles.bar,
            barStep(each.people, most),
            index === weeks.length - 1 && styles.barNow
          )}
        />
      ))}
    </div>
  );
};

/** How he is doing: who asked him this week against who can, and the share of questions he answered. */
const Usage = ({ week }: { week: StephenWeek }) => {
  const { t } = useLingui();
  if (week.questions === 0) {
    return <FactRow label={t`Nobody asked him anything yet.`}>{null}</FactRow>;
  }
  const asked = formatNumber(week.asked);
  const reach = formatNumber(week.reach);
  const share = formatPercent(week.answeredShare ?? 0);
  const answered = formatNumber(week.answered);
  const questions = formatNumber(week.questions);
  return (
    <FactRow
      help={t`${share} of questions answered · 30 days`}
      info={t`${answered} of ${questions} questions`}
      label={t`${asked} of ${reach} asked him this week`}
    >
      <WeekBars weeks={week.weeks} />
    </FactRow>
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
    <SettingRow
      error={failure}
      help={
        role === null ? t`${asked} asked` : t`${asked} asked · ${role} knows`
      }
      label={wording}
    >
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
        variant="quiet"
      >
        {role === null ? t`Ask` : t`Ask the ${role}`}
      </Button>
    </SettingRow>
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
    <SettingsSection
      action={
        <span {...stylex.props(styles.state)}>
          <Text element="span" size="sm" tone="muted">
            {reach.on ? t`On outside Grasp` : t`Paused outside Grasp`}
          </Text>
          <Switch
            checked={reach.on}
            disabled={!can}
            label={t`Stephen outside Grasp`}
            labelHidden
            onCheckedChange={(on) => {
              if (on) {
                void onReach(true, reach.audience);
                return;
              }
              setPausing(true);
            }}
          />
        </span>
      }
      media={<StephenAvatar />}
      title="Stephen"
    >
      <SettingsRows>
        <SettingRow label={t`Who can talk to him`}>
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
        </SettingRow>
        {week === null ? null : <Usage week={week} />}
      </SettingsRows>
      {week === null || week.unanswered.length === 0 ? null : (
        <SettingsRows label={t`What he didn’t know`}>
          {week.unanswered.map((row) => (
            <UnknownRow key={row.question} row={row} />
          ))}
        </SettingsRows>
      )}
      <AlertDialog onOpenChange={setPausing} open={pausing}>
        <AlertDialogContent>
          <AlertDialogTitle>
            <Trans>Pause Stephen outside Grasp?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              He stops answering everywhere outside Grasp, and says so once to
              whoever writes. Grasp’s chat keeps working.
            </Trans>
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                void onReach(false, reach.audience);
              }}
              variant="ink"
            >
              {t`Pause`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
};
