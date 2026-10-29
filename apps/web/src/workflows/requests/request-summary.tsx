import type {
  SummaryVia,
  WeeklySummary,
} from "@grasp-os/shared/stephen-requests";
import { Button } from "@grasp-os/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { useLingui } from "@lingui/react/macro";
import { MailIcon } from "lucide-react";

import { ErrorText } from "../../error-text.tsx";
import { formatDay, formatNumber, formatPercent } from "../../format.ts";
import { useCoreAction } from "../../use-core-action.ts";
import { PlaceLogo } from "./request-parts.tsx";

// The weekly summary, as the prototype's `request-summary.tsx`: every
// Monday morning, to whoever turned it on, in Microsoft Teams from Stephen
// or by mail, so nobody has to remember to open the page. Shown here as it
// would arrive, from what core would send now (stephen-summary.ts), with
// where it goes: off, Teams, or mail.

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
    <Sheet>
      <SheetTrigger render={<Button variant="outline" />}>
        <MailIcon data-icon="inline-start" />
        {t`Weekly summary`}
      </SheetTrigger>
      <SheetContent
        className="overflow-y-auto"
        closeLabel={t`Close`}
        size="wide"
      >
        <SheetHeader className="mr-8">
          <SheetTitle>{t`Weekly summary`}</SheetTitle>
          <SheetDescription>{t`Every Monday morning, to you`}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">
          <div className="flex flex-col gap-1">
            <ToggleGroup
              aria-label={t`Where the summary goes`}
              disabled={busy}
              onValueChange={(value: unknown[]) => {
                const [next] = value;
                void choose(next === "teams" || next === "email" ? next : null);
              }}
              spacing={0}
              value={[summary.via ?? "off"]}
              variant="outline"
            >
              <ToggleGroupItem value="off">
                {t({ message: "Off", context: "weekly summary not sent" })}
              </ToggleGroupItem>
              <ToggleGroupItem disabled={!summary.teamsOpen} value="teams">
                <PlaceLogo place="teams" />
                Microsoft Teams
              </ToggleGroupItem>
              <ToggleGroupItem value="email">
                <MailIcon />
                {t`Email`}
              </ToggleGroupItem>
            </ToggleGroup>
            {summary.teamsOpen ? null : (
              <p className="text-muted-foreground text-xs">
                {t`Stephen can send it in Microsoft Teams once you've had a chat with him there.`}
              </p>
            )}
            <ErrorText>{failure}</ErrorText>
          </div>
          <figure className="flex flex-col gap-2 rounded-lg border p-4">
            <figcaption className="text-muted-foreground text-xs">
              {t`Stephen · ${from} to ${to}`}
            </figcaption>
            <ul className="flex list-disc flex-col gap-1.5 pl-4">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </figure>
        </div>
      </SheetContent>
    </Sheet>
  );
};
