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
import { Link } from "@grasp-os/ui/components/link";
import { Stat } from "@grasp-os/ui/components/stat";
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
const SplitTable = ({
  label,
  overview,
  rows,
}: {
  label: string;
  overview: SpendOverview;
  rows: SplitRow[];
}) => (
  <CardContent flush>
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
  </CardContent>
);

/** This month and last in all, then by feature and by model. */
const SpendBody = ({ overview }: { overview: SpendOverview }) => {
  const { thisMonth, lastMonth } = overview;
  if (thisMonth.micros + lastMonth.micros === 0) {
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
      <SplitTable
        label="By feature"
        overview={overview}
        rows={rowsOf(overview, (month) =>
          month.byFeature.map(({ feature, micros }) => ({
            key: feature ?? "other",
            label: featureLabel(feature),
            micros,
          }))
        )}
      />
      <SplitTable
        label="By model"
        overview={overview}
        rows={rowsOf(overview, (month) =>
          month.byModel.map(({ model, micros }) => ({
            key: model,
            label: modelLabel(model),
            micros,
          }))
        )}
      />
    </>
  );
};

/** What its core reported, or that its release doesn't report it yet. */
const OrganizationSpendBody = ({
  overview,
}: {
  overview: SpendOverview | null;
}) =>
  overview === null ? (
    <PanelNote>
      Not reported by this release: its core runs a release from before these
      costs were reported. They show once it is updated.
    </PanelNote>
  ) : (
    <SpendBody overview={overview} />
  );

/**
 * One organization's spend on Grasp's keys, as its core reports it now,
 * on its AI use. Read only.
 */
export const OrganizationPlatformSpend = ({
  status,
}: {
  status: Promise<AiStatusReport | null>;
}) => (
  <Panel
    description="What transcription and speech cost Grasp on its own keys for this organization: what each call used, recorded after it, in US dollars at list prices, read from its core now. Nothing caps them."
    title="Grasp’s own AI features"
  >
    <Await fallback={<PanelNote>Reading its core…</PanelNote>} promise={status}>
      {(report) =>
        report === null ? (
          <PanelNote>
            Its core didn’t answer, so what they cost isn’t known now.
          </PanelNote>
        ) : (
          <OrganizationSpendBody overview={organizationSpendOf(report)} />
        )
      }
    </Await>
  </Panel>
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
