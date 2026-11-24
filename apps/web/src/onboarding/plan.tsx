import { Text } from "@grasp-os/ui/components/text";
import {
  colors,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { PlanDrawing } from "./plan-drawing.tsx";
import type { PlanDay } from "./plan-drawing.tsx";

// "Here's the plan": the admin's own campaign drawn as its two weeks
// (plan-drawing.tsx), then the same in plain rows, what happens and on
// which day, then one line of what a finding reads like. A
// row under the pointer lights its days in the drawing. The dates are
// counted from today: core plans no campaign yet.

const styles = stylex.create({
  stack: { display: "grid", gap: space[6] },
  week: {
    display: "grid",
    gap: space[2],
    paddingBlockStart: space[6],
    paddingBlockEnd: space[2],
    paddingInline: { default: space[6], [media.maxSm]: space[3] },
    borderRadius: radius.lg,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: size.borderStrong,
  },
  rows: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[4],
    paddingBlock: space[3],
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  day: { flexShrink: 0 },
  numbers: { fontVariantNumeric: "tabular-nums" },
  example: { margin: 0, textAlign: "center" },
});

/** The moments of the campaign, by how many days after today: until core plans one. */
const after = { first: 2, everyone: 6, close: 9, findings: 13 } as const;

type Moment = keyof typeof after;

/** The days each moment stands for in the drawing: from it to the next. */
const spans: Record<Moment, readonly [number, number]> = {
  first: [after.first, after.everyone - 1],
  everyone: [after.everyone, after.close - 1],
  close: [after.close, after.close],
  findings: [after.close + 1, after.findings],
};

/** Who talks on a weekday of the interviews: a few at first, the whole company after, tailing off on the last day. */
const talkersOn = (day: number): number => {
  if (day < after.everyone) {
    return 2 + ((day - after.first) % 2);
  }
  if (day === after.close) {
    return 3;
  }
  return [6, 8, 7, 8][(day - after.everyone) % 4] ?? 6;
};

/** What each day from today to the findings holds. */
const planDays = (today: Date): PlanDay[] =>
  Array.from({ length: after.findings + 1 }, (_, day) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() + day);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    if (day === after.findings) {
      return { kind: "findings", count: 0 };
    }
    if (weekend || day < after.first) {
      return { kind: "quiet", count: 0 };
    }
    if (day <= after.close) {
      return { kind: "talks", count: talkersOn(day) };
    }
    return { kind: "reads", count: 0 };
  });

export const PlanBody = ({ today }: { today: string }) => {
  const { t, i18n } = useLingui();
  const [lit, setLit] = useState<Moment | null>(null);
  const start = new Date(`${today}T12:00:00Z`);
  const dateOf = (moment: Moment) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + after[moment]);
    return date;
  };
  const format = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const moments: { id: Moment; what: string }[] = [
    { id: "first", what: t`The people who know the work best go first` },
    { id: "everyone", what: t`Everyone else gets their own link` },
    { id: "close", what: t`The interviews close` },
    { id: "findings", what: t`You get what I learned` },
  ];
  return (
    <div {...stylex.props(styles.stack)}>
      <div {...stylex.props(styles.week)}>
        <PlanDrawing
          days={planDays(start)}
          lit={lit === null ? null : spans[lit]}
        />
        <ol aria-label={t`Your campaign`} {...stylex.props(styles.rows)}>
          {moments.map(({ id, what }) => {
            const day = dateOf(id);
            return (
              <li
                key={id}
                onPointerEnter={() => {
                  setLit(id);
                }}
                onPointerLeave={() => {
                  setLit((current) => (current === id ? null : current));
                }}
                {...stylex.props(styles.row)}
              >
                <Text as="span">{what}</Text>
                <Text as="span" style={styles.day}>
                  <time
                    dateTime={day.toISOString().slice(0, 10)}
                    {...stylex.props(styles.numbers)}
                  >
                    {format.format(day)}
                  </time>
                </Text>
              </li>
            );
          })}
        </ol>
      </div>
      {/* An example, on the step's middle as its title and line are. */}
      <figure {...stylex.props(styles.example)}>
        <Text>{t`A finding reads like this: new people wait two to three days for a laptop from IT.`}</Text>
      </figure>
    </div>
  );
};
