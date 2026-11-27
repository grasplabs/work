/**
 * What Grasp's own AI features cost on its keys, read only: on an
 * organization's AI use, its own this month and last, by feature and by
 * model; on Platform, every active organization's summed, with those
 * that cost the most (src/admin/platform-spend-sums.ts). What each call
 * used, recorded after it, at list prices, in US dollars, read from each
 * core now. Nothing caps these features: this is where staff watch them.
 */

import { aiProviderIdSchema, aiProviders } from "@grasp-os/shared/ai-providers";
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import type { PlatformAiFeature } from "@grasp-os/shared/platform-ai";
import { Badge } from "@grasp-os/ui/components/badge";
import { ChartBarList } from "@grasp-os/ui/components/chart";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Await, Link } from "@tanstack/react-router";
import { Suspense, use } from "react";

import { LoadingLines } from "./failure.tsx";
import { EmptyPart, PagePart, PartNote } from "./page-part.tsx";
import {
  microsPerDollar,
  monthPace,
  nearLimit,
  organizationSpendOf,
  topOrganizationsMost,
} from "./platform-spend-sums.ts";
import type { PlatformSpend, SpendOverview } from "./platform-spend-sums.ts";
import { dollars, dollarsWhole, formatList, formatMonth } from "./words.ts";

const styles = stylex.create({
  // The figures, then the splits.
  spend: { display: "flex", flexDirection: "column", gap: space["8"] },
  // By feature and by model side by side once there is room for both.
  splits: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (width >= 64rem)": "repeat(2, minmax(0, 1fr))",
    },
    gap: space["8"],
  },
});

const featureWords: Record<PlatformAiFeature, string> = {
  // No release converts documents any more; its old rows still read so.
  conversion: "Document conversion",
  transcription: "Transcription",
  speech: "Speech",
  interview: "Interviews",
  conversation: "Voice interviews",
  organization: "The company’s own AI, on Grasp’s key",
};

/** A feature in words; one core didn't record as "Other". */
const featureLabel = (feature: PlatformAiFeature | null): string =>
  feature === null ? "Other" : featureWords[feature];

/** `mistral/voxtral-mini-tts-3-0` as "Mistral AI voxtral-mini-tts-3-0". */
const modelLabel = (model: string): string => {
  const [provider = "", ...rest] = model.split("/");
  const id = aiProviderIdSchema.safeParse(provider);
  return id.success ? `${aiProviders[id.data].label} ${rest.join("/")}` : model;
};

/** Micros as dollars, to the cent. */
const spent = (micros: number): string => dollars(micros / microsPerDollar);

/** One row of a split: what it is, and what it cost this month and last. */
interface SplitRow {
  key: string;
  label: string;
  thisMonth: number;
  lastMonth: number;
}

/** Both months' parts of one split as rows, the dearest this month first. */
const rowsOf = (
  overview: SpendOverview,
  partsOf: (month: SpendOverview["thisMonth"]) => {
    key: string;
    label: string;
    micros: number;
  }[]
): SplitRow[] => {
  const rows = new Map<string, SplitRow>();
  for (const [month, field] of [
    [overview.thisMonth, "thisMonth"],
    [overview.lastMonth, "lastMonth"],
  ] as const) {
    for (const { key, label, micros } of partsOf(month)) {
      const row = rows.get(key) ?? { key, label, thisMonth: 0, lastMonth: 0 };
      row[field] += micros;
      rows.set(key, row);
    }
  }
  return [...rows.values()].toSorted(
    (one, other) =>
      other.thisMonth - one.thisMonth || other.lastMonth - one.lastMonth
  );
};

/** Both months' parts by feature, the dearest this month first. */
const featureRows = (overview: SpendOverview): SplitRow[] =>
  rowsOf(overview, (month) =>
    month.byFeature.map(({ feature, micros }) => ({
      key: feature ?? "other",
      label: featureLabel(feature),
      micros,
    }))
  );

/** Both months' parts by model, the dearest this month first. */
const modelRows = (overview: SpendOverview): SplitRow[] =>
  rowsOf(overview, (month) =>
    month.byModel.map(({ model, micros }) => ({
      key: model,
      label: modelLabel(model),
      micros,
    }))
  );

/** Nothing on Grasp's keys in either month. */
const nothingSpent = ({ thisMonth, lastMonth }: SpendOverview): boolean =>
  thisMonth.micros + lastMonth.micros === 0;

/**
 * A split of what Grasp's keys cost as bars across, this month's over
 * last month's, in the rows' order, each with its amount: the trend of
 * each part at a glance.
 */
const SplitBars = ({
  id,
  label,
  overview,
  rows,
}: {
  id: string;
  label: string;
  overview: SpendOverview;
  rows: SplitRow[];
}) => {
  const [dearest] = rows;
  const thisMonth = formatMonth(overview.thisMonth.period);
  return (
    <Part aria-labelledby={id}>
      <SectionHeader
        headingLevel={3}
        id={id}
        size="sm"
        title={label}
        variant="group"
      />
      <ChartBarList
        aria-label={`${label}, ${thisMonth} and ${formatMonth(overview.lastMonth.period)}`}
        config={{
          thisMonth: { label: thisMonth },
          lastMonth: { label: formatMonth(overview.lastMonth.period) },
        }}
        // A copy of each row: the chart takes plain records.
        data={rows.map((row) => ({ ...row }))}
        nameKey="label"
        sortOrder="none"
        summary={
          dearest === undefined || dearest.thisMonth === 0
            ? `Nothing in ${thisMonth} yet.`
            : `${dearest.label} cost the most in ${thisMonth}, ${spent(dearest.thisMonth)}.`
        }
        valueFormatter={spent}
      />
    </Part>
  );
};

/**
 * What its core reported, once it answered: this month and last as
 * figures, then by feature and by model; or, in a line, why that isn't
 * there.
 */
const OrganizationSpendBody = ({
  status,
}: {
  status: Promise<AiStatusReport | null>;
}) => {
  const report = use(status);
  if (report === null) {
    return (
      <EmptyPart>
        Its core didn’t answer, so what they cost isn’t known now.
      </EmptyPart>
    );
  }
  const overview = organizationSpendOf(report);
  if (overview === null) {
    return (
      <EmptyPart>
        Not reported by this release: its core runs a release from before these
        costs were reported. They show once it is updated.
      </EmptyPart>
    );
  }
  if (nothingSpent(overview)) {
    return <EmptyPart>Nothing on Grasp’s keys this month or last.</EmptyPart>;
  }
  const { thisMonth, lastMonth } = overview;
  return (
    <div {...stylex.props(styles.spend)}>
      <StatGroup aria-label="Grasp’s own AI features in short" columns={2}>
        <Stat
          label={formatMonth(thisMonth.period)}
          value={spent(thisMonth.micros)}
        />
        <Stat
          label={formatMonth(lastMonth.period)}
          value={spent(lastMonth.micros)}
        />
      </StatGroup>
      <div {...stylex.props(styles.splits)}>
        <SplitBars
          id="spend-by-feature"
          label="By feature"
          overview={overview}
          rows={featureRows(overview)}
        />
        <SplitBars
          id="spend-by-model"
          label="By model"
          overview={overview}
          rows={modelRows(overview)}
        />
      </div>
    </div>
  );
};

/**
 * One organization's spend on Grasp's keys, as its core reports it now,
 * on its AI use, on the page as the rest of it. Read only.
 */
export const OrganizationPlatformSpend = ({
  status,
}: {
  status: Promise<AiStatusReport | null>;
}) => (
  <Part aria-labelledby="own-features">
    <SectionHeader
      description="In US dollars at list prices, as its core recorded each call: what transcription and speech cost Grasp on its own keys for this organization, read from its core now. Nothing caps them."
      id="own-features"
      size="sm"
      title="Grasp’s own AI features"
      variant="group"
    />
    <Suspense fallback={<LoadingLines lines={3} />}>
      <OrganizationSpendBody status={status} />
    </Suspense>
  </Part>
);

/** Which organizations aren't in the sums, and why, in a line each. */
const leftOutLines = ({ unread, unreported, organizations }: PlatformSpend) => [
  ...(unread.length === 0
    ? []
    : [
        `Read from ${organizations - unread.length} of ${organizations} active organizations. Not in these sums, as their core didn’t answer: ${formatList(unread.map(({ name }) => name))}.`,
      ]),
  ...(unreported.length === 0
    ? []
    : [
        `Not reported by their release, so not in these sums: ${formatList(unreported.map(({ name }) => name))}.`,
      ]),
];

/**
 * This month so far, with where its pace takes it; last month in full,
 * never a share of a month against a whole one; and how many
 * organizations' own AI on Grasp's key is near its limit.
 */
const PlatformFigures = ({ all }: { all: PlatformSpend }) => {
  const { thisMonth, lastMonth } = all;
  const pace = monthPace(thisMonth, new Date());
  const limited = all.byOrganization.filter(
    ({ graspAi }) => graspAi !== null && graspAi.limit > 0
  ).length;
  const near = all.byOrganization.filter(nearLimit).length;
  return (
    <StatGroup aria-label="Grasp’s own AI in short" columns={3}>
      <Stat
        change={
          pace === null
            ? "So far"
            : `So far, on pace for ${dollarsWhole(pace / microsPerDollar)}`
        }
        label={formatMonth(thisMonth.period)}
        value={spent(thisMonth.micros)}
      />
      <Stat
        change="In full"
        label={formatMonth(lastMonth.period)}
        value={spent(lastMonth.micros)}
      />
      <Stat
        change={
          limited === 0 ? "None runs on a limit" : `of ${limited} on a limit`
        }
        label="Near their limit"
        value={String(near)}
        {...(near > 0 ? { variant: "warning" as const } : {})}
      />
    </StatGroup>
  );
};

/**
 * The organizations that cost the most, this month then last, each a row
 * to its AI use: what it cost each month, and whether its own AI on
 * Grasp's key is near its limit. None that cost nothing. Rows, not bars:
 * a bar list's names can't lead anywhere.
 */
const OrganizationRows = ({ all }: { all: PlatformSpend }) => {
  const top = all.byOrganization
    .filter(({ thisMonth, lastMonth }) => thisMonth + lastMonth > 0)
    .slice(0, topOrganizationsMost);
  if (top.length === 0) {
    return null;
  }
  const [thisMonth, lastMonth] = [
    formatMonth(all.thisMonth.period),
    formatMonth(all.lastMonth.period),
  ];
  return (
    <Part aria-labelledby="spend-by-organization">
      <SectionHeader
        headingLevel={3}
        id="spend-by-organization"
        size="sm"
        title="By organization"
        variant="group"
      />
      <ItemGroup aria-labelledby="spend-by-organization" separated>
        {top.map((organization) => (
          <Item asChild key={organization.clientId} size="sm">
            <Link
              params={{ clientId: organization.clientId }}
              to="/organizations/$clientId/ai-use"
            >
              <ItemContent>
                <ItemTitle>{organization.name}</ItemTitle>
                <ItemDescription>
                  {`${spent(organization.thisMonth)} in ${thisMonth} · ${spent(organization.lastMonth)} in ${lastMonth}`}
                </ItemDescription>
              </ItemContent>
              {nearLimit(organization) ? (
                <ItemActions>
                  <Badge variant="warning">Near its limit</Badge>
                </ItemActions>
              ) : null}
            </Link>
          </Item>
        ))}
      </ItemGroup>
    </Part>
  );
};

/**
 * Every active organization's, once each core answered: the figures
 * (who is near their limit too when Grasp's features cost nothing), then
 * the organizations and the splits.
 */
const PlatformSpendBody = ({ all }: { all: PlatformSpend | null }) => {
  if (all === null) {
    return <EmptyPart>The organizations couldn’t be read now.</EmptyPart>;
  }
  const leftOut = leftOutLines(all);
  return (
    <div {...stylex.props(styles.spend)}>
      <PlatformFigures all={all} />
      {nothingSpent(all) ? (
        <EmptyPart>Nothing on Grasp’s keys this month or last.</EmptyPart>
      ) : (
        <>
          <OrganizationRows all={all} />
          <div {...stylex.props(styles.splits)}>
            <SplitBars
              id="spend-by-feature"
              label="By feature"
              overview={all}
              rows={featureRows(all)}
            />
            <SplitBars
              id="spend-by-model"
              label="By model"
              overview={all}
              rows={modelRows(all)}
            />
          </div>
        </>
      )}
      {leftOut.map((line) => (
        <PartNote key={line}>{line}</PartNote>
      ))}
    </div>
  );
};

/**
 * Every active organization's spend on Grasp's keys summed, read from
 * each core now, with those that cost the most. Read only.
 */
export const PlatformSpendPart = ({
  spend,
}: {
  spend: Promise<PlatformSpend | null>;
}) => (
  <PagePart
    description="Every active organization’s, summed: what each call used, recorded after it, in US dollars at list prices, read from each core now. Nothing caps them."
    id="own-ai"
    title="Grasp’s own AI"
  >
    <Await fallback={<LoadingLines lines={3} />} promise={spend}>
      {(all) => <PlatformSpendBody all={all} />}
    </Await>
  </PagePart>
);
