import type { StaffAiUseRow } from "@grasp-os/shared/onboarding-staff";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment } from "react";

import { formatDay, formatNumber } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { aiUseOf } from "../onboarding/ai-use.ts";
import type { Used } from "../onboarding/ai-use.ts";
import {
  Figure,
  Figures,
  formatCompact,
  formatDecimal,
} from "../onboarding/staff-figures.tsx";
import { purposeTitles } from "../onboarding/staff-words.ts";
import { SettingsError, SettingsSection } from "../settings/settings-parts.tsx";

// The AI the onboarding used (GRA-324), as in the prototype's AI use
// (`components/admin/org-usage.tsx`), from what core counted as it
// happened (the store's `meter`): in all, by what it was for (reading,
// interviews, drawing) and the model that did it, and day by day. In
// calls, tokens and minutes of voice; what Grasp pays for them is the
// admin's.

/** Minutes of voice, from seconds; a dash for none. */
const voiceOf = (used: Used): string =>
  used.seconds === 0 ? "–" : formatDecimal(used.seconds / 60);

/** A count of tokens in short; a dash for none. */
const tokensOf = (count: number): string =>
  count === 0 ? "–" : formatCompact(count);

/** The cells every row of numbers has: calls, tokens read and written, and voice. */
const UsedCells = ({ used }: { used: Used }) => (
  <>
    <TableCell className="text-right" variant="section">
      <span className="tabular-nums">{formatNumber(used.calls)}</span>
    </TableCell>
    <TableCell className="text-right" variant="section">
      <span className="tabular-nums">{tokensOf(used.tokensIn)}</span>
    </TableCell>
    <TableCell className="text-right" variant="section">
      <span className="tabular-nums">{tokensOf(used.tokensOut)}</span>
    </TableCell>
    <TableCell className="text-right" variant="section">
      <span className="tabular-nums">{voiceOf(used)}</span>
    </TableCell>
  </>
);

/** The heads of those cells. */
const UsedHeads = () => {
  const { t } = useLingui();
  return (
    <>
      <TableHead className="text-right" variant="section">{t`Calls`}</TableHead>
      <TableHead
        className="text-right"
        variant="section"
      >{t`Tokens read`}</TableHead>
      <TableHead
        className="text-right"
        variant="section"
      >{t`Tokens written`}</TableHead>
      <TableHead
        className="text-right"
        variant="section"
      >{t`Minutes of voice`}</TableHead>
    </>
  );
};

const AiUse = ({ rows }: { rows: StaffAiUseRow[] }) => {
  const { t, i18n } = useLingui();
  if (rows.length === 0) {
    return (
      <SettingsSection
        description={t`It starts when Stephen reads the kickoff, and grows with every interview.`}
        title={t`Nothing used yet`}
      />
    );
  }
  const use = aiUseOf(rows);
  const { total } = use;
  const cached = formatCompact(total.tokensCached);
  return (
    <>
      <p className="text-muted-foreground">
        {t`Counted as it happened, every time a model was asked, and every second of voice.`}
      </p>
      <Figures className="sm:grid-cols-4" label={t`AI use in short`}>
        <Figure label={t`Calls`} value={formatNumber(total.calls)} />
        <Figure
          label={t`Tokens read`}
          sub={t`${cached} of them from a cache`}
          value={formatCompact(total.tokensIn)}
        />
        <Figure
          label={t`Tokens written`}
          value={formatCompact(total.tokensOut)}
        />
        <Figure
          label={t`Minutes of voice`}
          value={formatDecimal(total.seconds / 60)}
        />
      </Figures>

      <SettingsSection
        description={t`What it was for, and which model did it.`}
        title={t`By purpose`}
      >
        <div className="border-t">
          <Table aria-label={t`By purpose`}>
            <TableHeader>
              <TableRow>
                <TableHead variant="section">{t`Purpose and model`}</TableHead>
                <UsedHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              {use.purposes.map(({ purpose, used, models }) => (
                <Fragment key={purpose}>
                  <TableRow>
                    <TableCell variant="section">
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {i18n._(purposeTitles[purpose].label)}
                        </span>
                        <span className="text-muted-foreground text-xs whitespace-normal">
                          {i18n._(purposeTitles[purpose].what)}
                        </span>
                      </span>
                    </TableCell>
                    <UsedCells used={used} />
                  </TableRow>
                  {models.map(({ model, used: theirs }) => (
                    <TableRow key={model}>
                      <TableCell variant="section">
                        <span className="pl-4">
                          {model === "voice"
                            ? t({
                                message: "Voice",
                                context: "model: Stephen's voice",
                              })
                            : model}
                        </span>
                      </TableCell>
                      <UsedCells used={theirs} />
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </SettingsSection>

      <SettingsSection
        description={t`Every day with any use, the newest first.`}
        title={t`By day`}
      >
        <div className="border-t">
          <Table aria-label={t`By day`}>
            <TableHeader>
              <TableRow>
                <TableHead variant="section">{t`Day`}</TableHead>
                <UsedHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              {use.days.map(({ day, used }) => (
                <TableRow key={day}>
                  <TableCell variant="section">{formatDay(day)}</TableCell>
                  <UsedCells used={used} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SettingsSection>
    </>
  );
};

const AiUsePage = () => {
  const loaded = Route.useLoaderData();
  if (loaded.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={loaded} />
      </div>
    );
  }
  return <AiUse rows={loaded.data} />;
};

export const Route = createFileRoute("/_shell/onboarding/ai-use")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.aiUse()
    ),
  errorComponent: SettingsError,
  component: AiUsePage,
});
