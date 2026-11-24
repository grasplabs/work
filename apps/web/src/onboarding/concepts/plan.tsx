import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import {
  Item,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Message, MessageContent } from "@grasp-os/ui/components/message";
import {
  CalendarIcon,
  CircleCheckIcon,
  Icon,
  SparklesIcon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

// "Here's the plan", brief (concepts only): first the admin's own
// campaign as a timeline, then one small, neutral example of a question
// and what Grasp makes of the answer. The dates are fixtures counted from
// today: core has no campaign yet.

const styles = stylex.create({
  stack: { display: "grid", gap: space[6], width: "100%" },
  example: { display: "grid", gap: space[3] },
});

const dayMs = 24 * 60 * 60 * 1000;

/** The campaign's days, counted from `today`: a fixture until core plans one. */
export const campaignDays = (today: Date) => {
  const at = (days: number) => new Date(today.getTime() + days * dayMs);
  return {
    first: at(2),
    everyone: at(6),
    close: at(9),
    findings: at(13),
  };
};

/** A day as the page's language writes it short: "Thu 26 Nov". */
const useDay = () => {
  const { i18n } = useLingui();
  const format = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return (day: Date) => format.format(day);
};

interface Moment {
  id: string;
  icon: IconData;
  title: string;
  day: Date;
}

/** Their campaign, in four moments: who first, then everyone, the close, the findings. */
export const CampaignTimeline = ({ today }: { today: Date }) => {
  const { t } = useLingui();
  const day = useDay();
  const days = campaignDays(today);
  const moments: Moment[] = [
    {
      id: "first",
      icon: UsersIcon,
      title: t`The people who know the work best go first`,
      day: days.first,
    },
    {
      id: "everyone",
      icon: UsersIcon,
      title: t`Everyone else gets their own link`,
      day: days.everyone,
    },
    {
      id: "close",
      icon: CalendarIcon,
      title: t`The interviews close`,
      day: days.close,
    },
    {
      id: "findings",
      icon: CircleCheckIcon,
      title: t`You get what I learned`,
      day: days.findings,
    },
  ];
  return (
    <ItemGroup aria-label={t`Your campaign`}>
      {moments.map((moment) => (
        <Item key={moment.id} size="sm">
          <ItemMedia variant="icon">
            <Icon icon={moment.icon} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{moment.title}</ItemTitle>
          </ItemContent>
          <ItemDetail>
            <time dateTime={moment.day.toISOString().slice(0, 10)}>
              {day(moment.day)}
            </time>
          </ItemDetail>
        </Item>
      ))}
    </ItemGroup>
  );
};

/** What Grasp makes of the example's answer: one finding, in one line. */
const Finding = () => {
  const { t } = useLingui();
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Icon icon={SparklesIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t`New people wait two to three days for a laptop from IT.`}</ItemTitle>
      </ItemContent>
    </Item>
  );
};

/** One question, one answer, and what Grasp writes down from it. */
export const ExampleAnswer = ({ interviewer }: { interviewer: string }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.example)}>
      <Message aria-label={interviewer}>
        <MessageContent>
          <Bubble variant="ghost">
            <BubbleContent>{t`When someone new joins your team, what happens in their first week?`}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Message align="end" aria-label={t`Someone on your team`}>
        <MessageContent>
          <Bubble align="end" variant="muted">
            <BubbleContent>{t`I show them around and set up their accounts. The laptop usually comes on day two or three, so the first days are mostly reading.`}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Finding />
    </div>
  );
};

/** The plan: their campaign as a timeline, then the example. */
export const PlanBody = ({
  today,
  interviewer,
}: {
  today: Date;
  interviewer: string;
}) => (
  <div {...stylex.props(styles.stack)}>
    <CampaignTimeline today={today} />
    <ExampleAnswer interviewer={interviewer} />
  </div>
);
