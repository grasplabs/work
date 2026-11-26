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
import { CardContent } from "@grasp-os/ui/components/card";
import { ChartBarList } from "@grasp-os/ui/components/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Link } from "@grasp-os/ui/components/link";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Await, Link as RouterLink } from "@tanstack/react-router";
import { Suspense, use } from "react";

import { LoadingLines } from "../frame/page.tsx";
import { Panel, PanelNote } from "./panel.tsx";
import {
  microsPerDollar,
  organizationSpendOf,
  topOrganizationsMost,
} from "./platform-spend-sums.ts";
import type {
  OrganizationSpend,
  PlatformSpend,
  SpendOverview,
} from "./platform-spend-sums.ts";
import { dollars, formatMonth } from "./words.ts";

const styles = stylex.create({
  // This month and last, side by side.
  months: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space["4"],
  },
  // An organization's figures, then its two tables.
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

/** A split as a table: its rows, this month's and last month's columns. */
const SplitRowsTable = ({
  label,
  overview,
  rows,
}: {
  label: string;
  overview: SpendOverview;
  rows: SplitRow[];
}) => (
  <Table aria-label={label}>
    <TableHeader>
      <TableRow>
        <TableHead>{label}</TableHead>
        <TableHead align="end">
          {formatMonth(overview.thisMonth.period)}
        </TableHead>
        <TableHead align="end">
          {formatMonth(overview.lastMonth.period)}
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow key={row.key}>
          <TableCell rowHeader>{row.label}</TableCell>
          <TableCell align="end">{spent(row.thisMonth)}</TableCell>
          <TableCell align="end">{spent(row.lastMonth)}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

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

/** This month and last in all, then by feature and by model, on a card. */
const SpendBody = ({ overview }: { overview: SpendOverview }) => {
  const { thisMonth, lastMonth } = overview;
  if (nothingSpent(overview)) {
    return <PanelNote>Nothing on Grasp’s keys this month or last.</PanelNote>;
  }
  return (
    <>
      <CardContent>
        <div {...stylex.props(styles.months)}>
          <Stat
            label={formatMonth(thisMonth.period)}
            unstyled
            value={spent(thisMonth.micros)}
          />
          <Stat
            label={formatMonth(lastMonth.period)}
            unstyled
            value={spent(lastMonth.micros)}
          />
        </div>
      </CardContent>
      <CardContent flush>
        <SplitRowsTable
          label="By feature"
          overview={overview}
          rows={featureRows(overview)}
        />
      </CardContent>
      <CardContent flush>
        <SplitRowsTable
          label="By model"
          overview={overview}
          rows={modelRows(overview)}
        />
      </CardContent>
    </>
  );
};

/**
 * A split of an organization's spend as bars across, this month's over
 * last month's, the dearest this month first, each with its amount.
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

/** A line where there is nothing to show of an organization's spend, and why. */
const SpendNote = ({ children }: { children: string }) => (
  <Empty align="start" size="sm">
    <EmptyHeader>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

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
      <SpendNote>
        Its core didn’t answer, so what they cost isn’t known now.
      </SpendNote>
    );
  }
  const overview = organizationSpendOf(report);
  if (overview === null) {
    return (
      <SpendNote>
        Not reported by this release: its core runs a release from before these
        costs were reported. They show once it is updated.
      </SpendNote>
    );
  }
  if (nothingSpent(overview)) {
    return <SpendNote>Nothing on Grasp’s keys this month or last.</SpendNote>;
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
      description="What transcription and speech cost Grasp on its own keys for this organization: what each call used, recorded after it, in US dollars at list prices, read from its core now. Nothing caps them."
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

/** The organizations that cost the most this month, then last, each linked to its AI use. */
const TopOrganizations = ({
  overview,
  top,
}: {
  overview: SpendOverview;
  top: OrganizationSpend[];
}) => (
  <CardContent flush>
    <Table aria-label="Top organizations">
      <TableHeader>
        <TableRow>
          <TableHead>Organization</TableHead>
          <TableHead align="end">
            {formatMonth(overview.thisMonth.period)}
          </TableHead>
          <TableHead align="end">
            {formatMonth(overview.lastMonth.period)}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {top.map((organization) => (
          <TableRow key={organization.clientId}>
            <TableCell rowHeader>
              <Link asChild variant="plain">
                <RouterLink
                  params={{ clientId: organization.clientId }}
                  to="/organizations/$clientId/ai-use"
                >
                  {organization.name}
                </RouterLink>
              </Link>
            </TableCell>
            <TableCell align="end">{spent(organization.thisMonth)}</TableCell>
            <TableCell align="end">{spent(organization.lastMonth)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </CardContent>
);

/** Which organizations aren't in the sums, as their core didn't answer. */
const unreadLine = ({ unread, organizations }: PlatformSpend): string =>
  `Read from ${organizations - unread.length} of ${organizations} active organizations. Not in these sums, as their core didn’t answer: ${unread.map(({ name }) => name).join(", ")}.`;

/** Which organizations aren't in the sums, as their core's release doesn't report it. */
const unreportedLine = ({ unreported }: PlatformSpend): string =>
  `Not reported by their release, so not in these sums: ${unreported.map(({ name }) => name).join(", ")}.`;

/**
 * Every active organization's spend on Grasp's keys summed, read from
 * each core now, with those that cost the most. Read only.
 */
export const PlatformSpendPanel = ({
  spend,
}: {
  spend: Promise<PlatformSpend | null>;
}) => (
  <Panel
    description="Every active organization’s, summed: what each call used, recorded after it, in US dollars at list prices, read from each core now. Nothing caps them."
    title="What they cost"
  >
    <Await fallback={<PanelNote>Reading each core…</PanelNote>} promise={spend}>
      {(all) => {
        if (all === null) {
          return <PanelNote>The organizations couldn’t be read now.</PanelNote>;
        }
        // Those that cost the most, this month then last: none that cost nothing.
        const top = all.byOrganization
          .filter(({ thisMonth, lastMonth }) => thisMonth + lastMonth > 0)
          .slice(0, topOrganizationsMost);
        return (
          <>
            <SpendBody overview={all} />
            {top.length === 0 ? null : (
              <TopOrganizations overview={all} top={top} />
            )}
            {all.unread.length === 0 ? null : (
              <PanelNote>{unreadLine(all)}</PanelNote>
            )}
            {all.unreported.length === 0 ? null : (
              <PanelNote>{unreportedLine(all)}</PanelNote>
            )}
          </>
        );
      }}
    </Await>
  </Panel>
);
