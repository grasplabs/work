/**
 * Stephen Lab in the admin (GRA-1112): how Stephen and Claire do across
 * every organization, from what each company's own Grasp answered
 * (`stephenOf`, the figures the Interviews section shows one company at a
 * time), side by side and in all.
 *
 * Not here, as the prototype's lab has it: the benches on practice
 * companies (`vp run lab`). Those run on a developer's machine against
 * the local stack and keep their runs there; nothing publishes them where
 * the admin can read them, so the page says so instead of showing any.
 */
import { stephenOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import type { StephenStats } from "@grasp-os/shared/admin/onboarding-admin-record";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Link } from "@tanstack/react-router";

import { Figure, Panel } from "./interview-parts.tsx";
import { unreadWords } from "./views.ts";
import type { Organization } from "./views.ts";
import { formatList } from "./words.ts";

const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 0,
});

const oneDecimal = new Intl.NumberFormat("en", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** One organization's figures, by its client. */
interface Measured {
  clientId: string;
  name: string;
  stats: StephenStats;
}

/** Every figure the page adds up, over the organizations whose interviews started. */
interface Totals {
  started: number;
  held: number;
  stopped: number;
  rated: number;
  /** The ratings' sum, to average over `rated`. */
  ratingSum: number;
  /** Interviews with the people who do the work, and what they left in, weighted by them. */
  interviews: number;
  approvedSum: number;
  /** Agreed interviews, and how many of them went by voice. */
  voiced: number;
}

/** The figures of every organization, in all. */
const totalsOf = (measured: readonly Measured[]): Totals => {
  const totals: Totals = {
    started: 0,
    held: 0,
    stopped: 0,
    rated: 0,
    ratingSum: 0,
    interviews: 0,
    approvedSum: 0,
    voiced: 0,
  };
  for (const { stats } of measured) {
    totals.started += stats.started;
    totals.held += stats.held;
    totals.stopped += stats.stopped;
    totals.rated += stats.rating.count;
    totals.ratingSum += stats.rating.average * stats.rating.count;
    totals.interviews += stats.interviews;
    totals.approvedSum += stats.approved * stats.interviews;
    totals.voiced += stats.byVoice * stats.held;
  }
  return totals;
};

/** `value` of `of` as a share, or a dash when there is nothing to take it over. */
const shareWords = (value: number, of: number): string =>
  of > 0 ? percent.format(value / of) : "–";

/** Stephen and Claire in all, over every organization. */
const InAll = ({ totals }: { totals: Totals }) => (
  <section className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-xl border lg:grid-cols-4">
    <Figure
      label="Finished"
      ring={{ value: totals.held, of: totals.started }}
      sub="who started also agreed"
      value={`${totals.held} of ${totals.started}`}
    />
    <Figure
      label="What people thought"
      sub={
        totals.rated === 0
          ? "nobody has said yet"
          : `from ${totals.rated} who said, 1 to 5`
      }
      value={
        totals.rated === 0
          ? "–"
          : oneDecimal.format(totals.ratingSum / totals.rated)
      }
    />
    <Figure
      label="Left in"
      ring={
        totals.interviews > 0
          ? { value: totals.approvedSum, of: totals.interviews }
          : undefined
      }
      sub="of what they wrote down"
      value={shareWords(totals.approvedSum, totals.interviews)}
    />
    <Figure
      label="Stopped halfway"
      sub="and not picked up again"
      value={String(totals.stopped)}
    />
  </section>
);

/** Each organization's figures, side by side, opening its interviewers. */
const EveryOrganization = ({ measured }: { measured: readonly Measured[] }) => (
  <Panel
    description="Each company’s interviews as its own Grasp counts them. A company opens its interviewers."
    title="Every organization"
  >
    <div className="@container border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead variant="card">Organization</TableHead>
            <TableHead variant="card">Finished</TableHead>
            <TableHead variant="card">Rating</TableHead>
            <TableHead className="hidden @xl:table-cell" variant="card">
              Minutes
            </TableHead>
            <TableHead className="hidden @xl:table-cell" variant="card">
              Left in
            </TableHead>
            <TableHead className="hidden @2xl:table-cell" variant="card">
              By voice
            </TableHead>
            <TableHead className="hidden @2xl:table-cell" variant="card">
              Stopped
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {measured.map(({ clientId, name, stats }) => (
            <TableRow key={clientId}>
              <TableCell variant="card">
                <Link
                  className="underline-offset-4 hover:underline"
                  params={{ clientId }}
                  search={{ tab: "interviewers" }}
                  to="/organizations/$clientId/interviews"
                >
                  {name}
                </Link>
              </TableCell>
              <TableCell variant="card">
                <span className="tabular-nums">{`${stats.held} of ${stats.started}`}</span>
              </TableCell>
              <TableCell variant="card">
                <span className="tabular-nums">
                  {stats.rating.count === 0
                    ? "–"
                    : `${oneDecimal.format(stats.rating.average)} (${stats.rating.count})`}
                </span>
              </TableCell>
              <TableCell className="hidden @xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {Math.round(stats.length.employee || stats.length.lead)}
                </span>
              </TableCell>
              <TableCell className="hidden @xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {stats.interviews > 0 ? percent.format(stats.approved) : "–"}
                </span>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {stats.held > 0 ? percent.format(stats.byVoice) : "–"}
                </span>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell" variant="card">
                <span className="tabular-nums">{stats.stopped}</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </Panel>
);

/** Stephen and Claire across every organization, and what isn't read. */
export const StephenLab = ({
  organizations,
}: {
  organizations: readonly Organization[];
}) => {
  const measured: Measured[] = organizations.flatMap(({ admin, view }) => {
    if (view === null) {
      return [];
    }
    const stats = stephenOf(view);
    return stats.started === 0
      ? []
      : [{ clientId: admin.client.id, name: admin.client.name, stats }];
  });
  const unread = organizations.flatMap(({ admin }) =>
    admin.state === "answered" ? [] : [admin]
  );
  const quiet = organizations.length - measured.length - unread.length;
  const notCounted = [
    quiet > 0
      ? `${quiet} ${quiet === 1 ? "organization hasn’t" : "organizations haven’t"} started interviews yet.`
      : "",
    unread.length > 0
      ? `Not read now: ${formatList(unread.map((each) => `${each.client.name} (${unreadWords(each)})`))}.`
      : "",
  ]
    .filter((line) => line !== "")
    .join(" ");
  return (
    <div className="flex flex-col gap-6 text-sm">
      {measured.length === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border px-5 py-4">
          No organization has started its interviews yet, so there is nothing of
          Stephen to measure.
        </p>
      ) : (
        <>
          <InAll totals={totalsOf(measured)} />
          <EveryOrganization measured={measured} />
        </>
      )}
      {notCounted === "" ? null : (
        <Panel description={notCounted} title="Not counted" />
      )}
      <Panel
        description="The benches on practice companies (vp run lab) run on a developer’s machine against the local stack, and keep their runs there. Nothing publishes them where the admin can read them yet, so they aren’t shown here."
        title="Measured on practice companies"
      />
    </div>
  );
};
