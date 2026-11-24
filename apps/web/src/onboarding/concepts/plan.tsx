import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import {
  Card,
  CardContent,
  CardHeader,
  CardMedia,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@grasp-os/ui/components/message";
import { Text } from "@grasp-os/ui/components/text";
import {
  CalendarIcon,
  CircleCheckIcon,
  Icon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Meadow } from "./meadow.tsx";

// "Here's the plan", brief (concepts only): first the admin's own
// campaign as a timeline, then one small, neutral example of a question
// and what Grasp makes of the answer. The dates are fixtures counted from
// today: core has no campaign yet.

const styles = stylex.create({
  // The meadow's room: it fills a positioned box.
  meadow: {
    position: "relative",
    width: "100%",
    height: { default: "12rem", [media.maxSm]: "9rem" },
  },
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
  description: string;
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
      title: t`The first people`,
      description: t`Those who know the work best talk to me first.`,
      day: days.first,
    },
    {
      id: "everyone",
      icon: UsersIcon,
      title: t`Everyone else`,
      description: t`Each person gets their own link. A talk takes up to 20 minutes.`,
      day: days.everyone,
    },
    {
      id: "close",
      icon: CalendarIcon,
      title: t`The interviews close`,
      description: t`One week after the start. You can add a second week.`,
      day: days.close,
    },
    {
      id: "findings",
      icon: CircleCheckIcon,
      title: t`You get what I learned`,
      description: t`Team by team, with what to do first.`,
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
            <ItemDescription>{moment.description}</ItemDescription>
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

/** What Grasp writes down from the example's answer. */
const WrittenDown = () => {
  const { t } = useLingui();
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle level={3}>{t`What I write down`}</CardTitle>
      </CardHeader>
      <CardContent>
        <KeyValueList
          items={[
            {
              id: "work",
              label: t`The work`,
              value: t`Welcoming a new colleague`,
            },
            {
              id: "who",
              label: t`Who does it`,
              value: t`The team lead, with IT`,
            },
            {
              id: "stuck",
              label: t`Where it sticks`,
              value: t`The laptop takes 2 to 3 days`,
            },
          ]}
          orientation="horizontal"
        />
      </CardContent>
    </Card>
  );
};

/** The example as one card, for a conversation, where it can't be messages in a message. */
export const ExampleNote = () => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.example)}>
      <Text color="muted" size="sm">
        {t`I ask: “When someone new joins your team, what happens in their first week?”`}
      </Text>
      <Text color="muted" size="sm">
        {t`Someone answers: “I show them around and set up their accounts. The laptop comes from IT on day two or three, so the first days are mostly reading.”`}
      </Text>
      <WrittenDown />
    </div>
  );
};

/** One question, one answer, and what Grasp writes down from it. */
export const ExampleAnswer = ({ interviewer }: { interviewer: string }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.example)}>
      <Message aria-label={interviewer}>
        <MessageContent>
          <MessageHeader>
            <Text as="span" size="sm" color="muted">
              {interviewer}
            </Text>
          </MessageHeader>
          <Bubble variant="ghost">
            <BubbleContent>{t`When someone new joins your team, what happens in their first week?`}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Message align="end" aria-label={t`Someone on your team`}>
        <MessageContent>
          <Bubble align="end" variant="muted">
            <BubbleContent>{t`I show them around and set up their accounts. The laptop comes from IT on day two or three, so the first days are mostly reading.`}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <WrittenDown />
    </div>
  );
};

/**
 * The campaign as one picture: Damsko's meadow, one seed, a first flower,
 * then the whole field, as the interviews go from the first people to
 * everyone. `still` draws it whole, once.
 */
export const CampaignPicture = ({ still = false }: { still?: boolean }) => (
  <Card padding="none">
    <CardMedia>
      <div {...stylex.props(styles.meadow)}>
        <Meadow still={still} words={false} />
      </div>
    </CardMedia>
  </Card>
);

/** The plan: their campaign, as a picture and a timeline, then the example. */
export const PlanBody = ({
  today,
  interviewer,
}: {
  today: Date;
  interviewer: string;
}) => (
  <div {...stylex.props(styles.stack)}>
    <CampaignPicture />
    <CampaignTimeline today={today} />
    <ExampleAnswer interviewer={interviewer} />
  </div>
);
