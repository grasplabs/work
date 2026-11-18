import type {
  SummaryVia,
  WeeklySummary,
} from "@grasp-os/shared/stephen-requests";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatDay, formatNumber, formatPercent } from "../../format.ts";
import { Alert } from "../../grasp/alert/index.ts";
import { Card } from "../../grasp/card/index.ts";
import { BrandTeams, Mail } from "../../grasp/icons/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "../../grasp/sheet/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../../grasp/toggle/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../../use-core-action.ts";

// The weekly summary, as the prototype's `request-summary.tsx`: every
// Monday morning, to whoever turned it on, in Microsoft Teams from Stephen
// or by mail, so nobody has to remember to open the page. Shown here as it
// would arrive, from what core would send now (stephen-summary.ts), with
// where it goes: off, Teams, or mail.

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: grasp.space6 },
  via: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  preview: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  lines: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    margin: 0,
    paddingInlineStart: grasp.space4,
  },
});

/** The lines of the summary, as it would arrive. */
const useSummaryLines = (summary: WeeklySummary): string[] => {
  const { t } = useLingui();
  const count = formatNumber(summary.billed);
  const change =
    summary.billedBefore === 0
      ? null
      : summary.billed / summary.billedBefore - 1;
  const by = formatPercent(Math.abs(change ?? 0));
  const hours = formatNumber(Math.round(summary.minutes / 60));
  let requests = t`${count} requests last week`;
  if (change !== null) {
    requests =
      change >= 0
        ? t`${count} requests last week, ${by} more than the week before`
        : t`${count} requests last week, ${by} fewer than the week before`;
  }
  const lines = [requests, t`About ${hours} hours saved`];
  for (const need of summary.fresh) {
    const { label } = need;
    lines.push(t`New: “${label}”`);
  }
  for (const need of summary.fixed) {
    const { label } = need;
    const times = formatNumber(need.since?.requests ?? 0);
    lines.push(t`Fixed: “${label}”, asked ${times} times since`);
  }
  if (summary.pace !== null && summary.included !== null) {
    const ahead = formatNumber(summary.pace);
    const of = formatNumber(summary.included);
    lines.push(t`This month about ${ahead} of the ${of} in your plan`);
  }
  return lines;
};

/** Where the summary goes, from a toggle group's pressed values: off when none is. */
const viaOf = (value: readonly string[]): SummaryVia | null => {
  const [next] = value;
  return next === "teams" || next === "email" ? next : null;
};

/** The summary's preview, and where it goes. */
export const RequestSummary = ({
  summary,
  onChanged,
}: {
  summary: WeeklySummary;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const lines = useSummaryLines(summary);
  const { busy, failure, run } = useCoreAction();
  const from = formatDay(summary.week.from);
  const to = formatDay(summary.week.to);
  const choose = async (via: SummaryVia | null): Promise<void> => {
    await run(async (session) => {
      await session.stephenRequests.setSummary(via);
    });
    await onChanged();
  };
  return (
    <Sheet size="md">
      <SheetTrigger icon={Mail} variant="quiet">
        {t`Weekly summary`}
      </SheetTrigger>
      <SheetContent closeLabel={t`Close`}>
        <SheetTitle>{t`Weekly summary`}</SheetTitle>
        <SheetDescription>{t`Every Monday morning, to you`}</SheetDescription>
        <SheetBody>
          <div {...stylex.props(styles.body)}>
            <div {...stylex.props(styles.via)}>
              <ToggleGroup
                aria-label={t`Where the summary goes`}
                disabled={busy}
                onValueChange={(value: string[]) => {
                  void choose(viaOf(value));
                }}
                value={[summary.via ?? "off"]}
              >
                <Toggle value="off">
                  {t({ message: "Off", context: "weekly summary not sent" })}
                </Toggle>
                <Toggle
                  disabled={!summary.teamsOpen}
                  icon={BrandTeams}
                  value="teams"
                >
                  Microsoft Teams
                </Toggle>
                <Toggle icon={Mail} value="email">
                  {t`Email`}
                </Toggle>
              </ToggleGroup>
              {summary.teamsOpen ? null : (
                <Text size="xs" tone="muted">
                  {t`Stephen can send it in Microsoft Teams once you've had a chat with him there.`}
                </Text>
              )}
              {failure === undefined ? null : (
                <Alert tone="danger">{failure}</Alert>
              )}
            </div>
            <Card padding="md" variant="soft">
              <div {...stylex.props(styles.preview)}>
                <Text size="sm" tone="muted">
                  {t`Stephen · ${from} to ${to}`}
                </Text>
                <ul {...stylex.props(styles.lines)}>
                  {lines.map((line) => (
                    <li key={line}>
                      <Text element="span" size="sm">
                        {line}
                      </Text>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
};
