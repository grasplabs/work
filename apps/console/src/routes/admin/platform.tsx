import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { cn } from "@grasp-os/ui/lib/utils";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminPage } from "../../admin/page.tsx";
import { Panel } from "../../admin/panel.tsx";
import { fetchPlatform } from "../../admin/platform-data.ts";
import type { StaffEvent } from "../../admin/platform-data.ts";
import {
  eventWords,
  needWords,
  RingSteps,
  ringWords,
  StandingMark,
  targetWords,
} from "../../admin/platform-parts.tsx";
import {
  companiesOf,
  errorRateLimit,
  errorRateOf,
  nextRing,
  ringsOf,
  spreadOf,
} from "../../admin/platform.ts";
import type { PlatformNeed, Standing } from "../../admin/platform.ts";
import { formatDate, formatPercent, whole } from "../../admin/words.ts";
import { fetchClientGrid, fetchGridLive } from "../../clients/functions.ts";
import type { GridRow, LiveStatus } from "../../clients/grid.ts";
import type { ReleaseSummary } from "../../releases/queries.ts";
import { approveRolloutFn } from "../../rollout/functions.ts";
import type { RolloutView } from "../../rollout/queries.ts";
import { useRolloutAction } from "../../rollout/use-action.ts";
import { thenRefresh } from "../../use-action.ts";

const usd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** What the live reads gave for each company: null while reading, `failed` if they did. */
type Live = Record<string, LiveStatus> | "failed" | null;

/** A cell with nothing to say: a dash, never a made-up number. */
const Nothing = () => <span className="text-muted-foreground">–</span>;

/** A day, as the admin's pages say it. */
const dayOf = (at: Date): string => formatDate(at.toISOString().slice(0, 10));

const rolloutStatusWords: Record<RolloutView["status"], string> = {
  running: "Rolling out",
  waiting: "Waits",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * What the rollout's badge says: paused, as its run tells when staff
 * paused it (its record doesn't), the ring it waits for, or its status.
 */
const rolloutBadgeWords = (
  rollout: RolloutView,
  next: number | null
): string => {
  if (rollout.run === "paused") {
    return "Paused";
  }
  return next === null
    ? rolloutStatusWords[rollout.status]
    : `Waits for ring ${next}`;
};

/**
 * Approving ring `next` of a waiting rollout: the console's own approval
 * (`approveRolloutFn`), as the rollout's page has it, staff-only and
 * audited as `rollout.approve`. The page is read again either way, and a
 * refusal (another staff member approved first, say) is said under it.
 */
const ApproveRing = ({
  rolloutId,
  next,
}: {
  rolloutId: string;
  next: number;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={busy}
        onClick={() => {
          void run(
            async () =>
              await thenRefresh(
                async () => await approveRolloutFn({ data: { rolloutId } }),
                async () => {
                  await router.invalidate({ sync: true });
                }
              )
          );
        }}
        size="sm"
      >
        {`Approve ring ${next}`}
      </Button>
      {failure === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
};

/** The rollout going out, ring by ring, and each company in it. */
const GoingOut = ({
  rollout,
  names,
}: {
  rollout: RolloutView | null;
  names: ReadonlyMap<string, string>;
}) => {
  if (rollout === null) {
    return (
      <Panel
        description="No release has been rolled out yet."
        title="Going out now"
      >
        {null}
      </Panel>
    );
  }
  const rings = ringsOf(rollout, rollout.targets);
  const next = nextRing(rollout, rollout.targets);
  const what =
    rollout.kind === "secrets" ? "new secrets" : (rollout.releaseId ?? "");
  const status = rolloutBadgeWords(rollout, next);
  // A paused run takes no approval until staff resume it (its own page).
  const approvable = next !== null && rollout.run !== "paused";
  return (
    <Panel
      action={
        approvable ? (
          <ApproveRing next={next} rolloutId={rollout.id} />
        ) : (
          <Badge
            variant={rollout.status === "failed" ? "destructive" : "secondary"}
          >
            {status}
          </Badge>
        )
      }
      description={`Started by ${rollout.startedBy} on ${dayOf(rollout.createdAt)}.`}
      title={`Going out now: ${what}`}
    >
      <div className="flex flex-col gap-4 border-t px-5 py-4">
        <RingSteps
          label="The rollout, ring by ring"
          steps={rings.map((ring) => ({
            ring: ring.ring,
            about: `${ring.done} of ${ring.targets.length} on it`,
            state: ring.state,
          }))}
        />
      </div>
      <ul className="flex flex-col">
        {rollout.targets.map((target) => (
          <li
            className="flex items-center justify-between gap-4 border-t px-5 py-3"
            key={target.clientId}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">
                {names.get(target.clientId) ?? target.clientId}
              </span>
              <span className="text-muted-foreground text-xs">
                {ringWords(target.ring)}
              </span>
            </span>
            <span
              className={cn(
                "flex-none",
                (target.status === "failed" ||
                  target.status === "rolled_back") &&
                  "text-status-attention",
                target.status === "pending" && "text-muted-foreground"
              )}
            >
              {targetWords[target.status]}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
};

/** Which company runs which release, the newest release first. */
const WhoRunsWhat = ({
  rows,
  releases,
  names,
}: {
  rows: GridRow[];
  releases: ReleaseSummary[];
  names: ReadonlyMap<string, string>;
}) => {
  const active = rows.filter(({ status }) => status === "active").length;
  const spread = spreadOf(rows, releases).filter(
    ({ clientIds }) => clientIds.length > 0
  );
  return (
    <Panel
      description={`${whole(active)} ${active === 1 ? "company runs its" : "companies run their"} own Grasp. The newest release first.`}
      title="Who runs what"
    >
      <ul className="flex flex-col">
        {spread.map(({ releaseId, release, clientIds }) => (
          <li
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-t px-5 py-3"
            key={releaseId}
          >
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs">{releaseId}</span>
              {release === null ? null : (
                <span className="text-muted-foreground">
                  {dayOf(release.builtAt)}
                </span>
              )}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {`${clientIds.length} of ${active}`}
            </span>
            <Progress
              aria-label={`Companies on ${releaseId}`}
              className="col-span-2"
              value={active === 0 ? 0 : (clientIds.length / active) * 100}
            />
            <span className="text-muted-foreground col-span-2 text-xs">
              {clientIds.map((id) => names.get(id) ?? id).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
};

/** A company's row: how it stands, then its figures; it opens its Setup. */
const CompanyRow = ({
  row,
  live,
  standing,
  needs,
}: {
  row: GridRow;
  live: LiveStatus | undefined;
  standing: Standing;
  needs: PlatformNeed[];
}) => {
  const rate = errorRateOf(live);
  return (
    <TableRow className="relative">
      <TableCell variant="card">
        <span className="flex min-w-0 flex-col gap-0.5">
          <Link
            className="truncate outline-none after:absolute after:inset-0 focus-visible:underline"
            params={{ clientId: row.id }}
            to="/admin/organizations/$clientId/setup"
          >
            {row.name}
          </Link>
          <span className="text-xs">
            <StandingMark standing={standing} />
          </span>
          {needs.map((need) => (
            <span className="text-status-attention text-xs" key={need.kind}>
              {needWords(need)}
            </span>
          ))}
        </span>
      </TableCell>
      <TableCell
        className="hidden whitespace-normal @xl:table-cell"
        variant="card"
      >
        {ringWords(row.ring)}
      </TableCell>
      <TableCell className="hidden @2xl:table-cell" variant="card">
        <span className="flex flex-col">
          <span className="font-mono text-xs">{row.release ?? "–"}</span>
          {row.pinnedReleaseId === null ? null : (
            <span className="text-muted-foreground text-xs">Pinned</span>
          )}
        </span>
      </TableCell>
      <TableCell className="hidden text-right @3xl:table-cell" variant="card">
        {live?.day ? (
          <span className="tabular-nums">{whole(live.day.requests)}</span>
        ) : (
          <Nothing />
        )}
      </TableCell>
      <TableCell className="hidden text-right @3xl:table-cell" variant="card">
        {rate === null ? (
          <Nothing />
        ) : (
          <span
            className={cn(
              "tabular-nums",
              rate >= errorRateLimit && "text-status-attention"
            )}
          >
            {formatPercent(rate)}
          </span>
        )}
      </TableCell>
      <TableCell className="hidden text-right @4xl:table-cell" variant="card">
        {live?.costUsd ? (
          <span className="tabular-nums">{usd.format(live.costUsd.ai)}</span>
        ) : (
          <Nothing />
        )}
      </TableCell>
      <TableCell variant="card">
        <ChevronRightIcon
          aria-hidden="true"
          className="text-muted-foreground mx-auto size-4"
        />
      </TableCell>
    </TableRow>
  );
};

/** What the table says of where its figures come from. */
const everyCompanyLine = (live: Live): string => {
  if (live === null) {
    return "The ones that need a look first, each account's figures being read now. A row opens its Setup.";
  }
  return live === "failed"
    ? "The ones that need a look first. The accounts couldn't be read just now, so their figures are left out. A row opens its Setup."
    : "The ones that need a look first. A row opens its Setup.";
};

/** Every company, the ones that need a look first. */
const EveryCompany = ({
  rows,
  live,
  releases,
}: {
  rows: GridRow[];
  live: Live;
  releases: ReleaseSummary[];
}) => {
  const read = live === null || live === "failed" ? {} : live;
  return (
    <Panel description={everyCompanyLine(live)} title="Every company">
      <div className="@container border-t">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Company</TableHead>
              <TableHead className="hidden w-36 @xl:table-cell" variant="card">
                Ring
              </TableHead>
              <TableHead className="hidden w-36 @2xl:table-cell" variant="card">
                Release
              </TableHead>
              <TableHead
                className="hidden w-32 text-right @3xl:table-cell"
                variant="card"
              >
                Requests
              </TableHead>
              <TableHead
                className="hidden w-24 text-right @3xl:table-cell"
                variant="card"
              >
                Errors
              </TableHead>
              <TableHead
                className="hidden w-28 text-right @4xl:table-cell"
                variant="card"
              >
                Models
              </TableHead>
              <TableHead className="w-9" variant="card">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {companiesOf(rows, read, releases).map(
              ({ row, standing, needs }) => (
                <CompanyRow
                  key={row.id}
                  live={read[row.id]}
                  needs={needs}
                  row={row}
                  standing={standing}
                />
              )
            )}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
};

/** What someone at Grasp did, as the console's audit log keeps it. */
const DoneHere = ({
  events,
  names,
}: {
  events: StaffEvent[];
  names: ReadonlyMap<string, string>;
}) =>
  events.length === 0 ? null : (
    <Panel
      description="What someone at Grasp did, as the console keeps it."
      title="Done here"
    >
      <ul className="flex flex-col">
        {events.map((event) => (
          <li
            className="flex items-baseline justify-between gap-4 border-t px-5 py-3"
            key={event.id}
          >
            <span className="min-w-0">
              {eventWords(event, (id) => names.get(id) ?? id)}
            </span>
            <span className="text-muted-foreground flex-none text-xs tabular-nums">
              {dayOf(event.at)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );

/** The live figures of every active company, read once the page shows. */
const readLive = async (): Promise<Record<string, LiveStatus> | "failed"> => {
  try {
    return await fetchGridLive();
  } catch {
    return "failed";
  }
};

/**
 * Every company's own Grasp at once, as the console runs them, ported from
 * the prototype (grasplabs/prototype `routes/admin/platform.tsx`): the
 * release going out now, ring by ring, with who has it and who waits;
 * which company runs which release; and every company in one table, the
 * ones that need a look first, each opening its Setup. Approving the next
 * ring is the one thing done here.
 */
const PlatformPage = () => {
  const { rows, platform } = Route.useLoaderData();
  const [live, setLive] = useState<Live>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const read = await readLive();
      // A page left before its answer came doesn't take it.
      if (current) {
        setLive(read);
      }
    })();
    return () => {
      current = false;
    };
  }, []);
  const names = new Map(rows.map(({ id, name }) => [id, name]));
  return (
    <AdminPage
      action={
        <Link
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          to="/"
        >
          Open the console
        </Link>
      }
      description="Every company runs its own Grasp, in its own Cloudflare account in the EU. A release reaches them ring by ring, and waits after each ring for someone at Grasp."
      title="Platform"
    >
      {/* The panels' type, as the prototype's sections set it. */}
      <div className="flex flex-col gap-6 text-sm">
        <GoingOut names={names} rollout={platform.rollout} />
        <WhoRunsWhat names={names} releases={platform.releases} rows={rows} />
        <EveryCompany live={live} releases={platform.releases} rows={rows} />
        <DoneHere events={platform.events} names={names} />
      </div>
    </AdminPage>
  );
};

/** Every company's own deployment, and the rollout going out. */
export const Route = createFileRoute("/admin/platform")({
  loader: async () => {
    const [rows, platform] = await Promise.all([
      fetchClientGrid(),
      fetchPlatform(),
    ]);
    return { rows, platform };
  },
  component: PlatformPage,
});
