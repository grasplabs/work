/**
 * What Grasp's own AI features cost on its keys, read only: on an
 * organization's AI use, its own this month and last, by feature and by
 * model; on Platform → AI, every active organization's summed, with those
 * that cost the most (src/admin/platform-spend-sums.ts). The model
 * ledger's charges at list prices, in US dollars, read from each core
 * now. Nothing caps these features: this is where staff watch them.
 */
import { aiProviderIdSchema, aiProviders } from "@grasp-os/shared/ai-providers";
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import type { PlatformAiFeature } from "@grasp-os/shared/platform-ai";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Await, Link } from "@tanstack/react-router";

import { Figure, Panel } from "./parts.tsx";
import { microsPerDollar, organizationSpendOf } from "./platform-spend-sums.ts";
import type {
  OrganizationSpend,
  PlatformSpend,
  SpendOverview,
} from "./platform-spend-sums.ts";
import { dollars, formatMonth } from "./words.ts";

const featureWords: Record<PlatformAiFeature, string> = {
  conversion: "Document conversion",
  transcription: "Transcription",
  speech: "Speech",
};

/** A feature in words; one the ledger didn't record as "Other". */
const featureLabel = (feature: PlatformAiFeature | null): string =>
  feature === null ? "Other" : featureWords[feature];

/** `openai/gpt-4o-mini-tts` as "OpenAI gpt-4o-mini-tts". */
const modelLabel = (model: string): string => {
  const [provider = "", ...rest] = model.split("/");
  const id = aiProviderIdSchema.safeParse(provider);
  return id.success ? `${aiProviders[id.data].label} ${rest.join("/")}` : model;
};

/** Micros as dollars, to the cent. */
const spent = (micros: number): string => dollars(micros / microsPerDollar);

/** What the prices are, said once under each figure. */
const pricesLine = "US dollars at list prices";

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
  <div className="border-t">
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead variant="section">{label}</TableHead>
          <TableHead className="text-right" variant="section">
            {formatMonth(overview.thisMonth.period)}
          </TableHead>
          <TableHead className="text-right" variant="section">
            {formatMonth(overview.lastMonth.period)}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell variant="section">{row.label}</TableCell>
            <TableCell className="text-right" variant="section">
              <span className="tabular-nums">{spent(row.thisMonth)}</span>
            </TableCell>
            <TableCell className="text-right" variant="section">
              <span className="tabular-nums">{spent(row.lastMonth)}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

/** This month and last in all, then by feature and by model. */
const SpendBody = ({ overview }: { overview: SpendOverview }) => {
  const { thisMonth, lastMonth } = overview;
  if (thisMonth.micros + lastMonth.micros === 0) {
    return (
      <p className="text-muted-foreground border-t px-5 py-4">
        Nothing on Grasp’s keys this month or last.
      </p>
    );
  }
  return (
    <>
      <div className="bg-border grid grid-cols-2 gap-px border-t">
        <Figure
          label={formatMonth(thisMonth.period)}
          sub={pricesLine}
          value={spent(thisMonth.micros)}
        />
        <Figure
          label={formatMonth(lastMonth.period)}
          sub={pricesLine}
          value={spent(lastMonth.micros)}
        />
      </div>
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

/** A line in place of the figures while they are read, or when they can't be. */
const Line = ({ children }: { children: string }) => (
  <p className="text-muted-foreground border-t px-5 py-4">{children}</p>
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
    description="What document conversion, transcription and speech cost Grasp on its own keys for this organization: the model ledger’s charges in US dollars at list prices, read from its core now. Nothing caps them."
    title="Grasp’s own AI features"
  >
    <Await fallback={<Line>Reading its core…</Line>} promise={status}>
      {(report) =>
        report === null ? (
          <Line>
            Its core didn’t answer, so what they cost isn’t known now.
          </Line>
        ) : (
          <SpendBody overview={organizationSpendOf(report)} />
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
  <div className="border-t">
    <Table aria-label="Top organizations">
      <TableHeader>
        <TableRow>
          <TableHead variant="section">Organization</TableHead>
          <TableHead className="text-right" variant="section">
            {formatMonth(overview.thisMonth.period)}
          </TableHead>
          <TableHead className="text-right" variant="section">
            {formatMonth(overview.lastMonth.period)}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {top.map((organization) => (
          <TableRow key={organization.clientId}>
            <TableCell variant="section">
              <Link
                className="hover:underline"
                params={{ clientId: organization.clientId }}
                to="/organizations/$clientId/ai-use"
              >
                {organization.name}
              </Link>
            </TableCell>
            <TableCell className="text-right" variant="section">
              <span className="tabular-nums">
                {spent(organization.thisMonth)}
              </span>
            </TableCell>
            <TableCell className="text-right" variant="section">
              <span className="tabular-nums">
                {spent(organization.lastMonth)}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

/** Which organizations aren't in the sums, if any. */
const unreadLine = ({ unread, organizations }: PlatformSpend): string =>
  `Read from ${organizations - unread.length} of ${organizations} active organizations. Not in these sums, as their core didn’t answer: ${unread.join(", ")}.`;

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
    description="Every active organization’s, summed: the model ledger’s charges in US dollars at list prices, read from each core now. Nothing caps them."
    title="What they cost"
  >
    <Await fallback={<Line>Reading each core…</Line>} promise={spend}>
      {(all) => {
        if (all === null) {
          return <Line>The organizations couldn’t be read now.</Line>;
        }
        return (
          <>
            <SpendBody overview={all} />
            {all.top.length === 0 ? null : (
              <TopOrganizations overview={all} top={all.top} />
            )}
            {all.unread.length === 0 ? null : <Line>{unreadLine(all)}</Line>}
          </>
        );
      }}
    </Await>
  </Panel>
);
