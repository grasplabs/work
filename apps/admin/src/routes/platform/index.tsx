import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { PageLoading } from "../../admin/failure.tsx";
import { AdminPage } from "../../admin/page.tsx";
import { fetchPlatform } from "../../admin/platform-data.ts";
import type { StaffEvent } from "../../admin/platform-data.ts";
import { PlatformNav } from "../../admin/platform-nav.tsx";
import {
  eventWords,
  needWords,
  StandingMark,
} from "../../admin/platform-parts.tsx";
import { companiesOf } from "../../admin/platform.ts";
import type { PlatformNeed, Standing } from "../../admin/platform.ts";
import { ReadinessPanel } from "../../admin/readiness-parts.tsx";
import { fetchReadiness } from "../../admin/readiness.ts";
import { Section } from "../../admin/section.tsx";
import { formatDate } from "../../admin/words.ts";
import { fetchClientGrid, fetchGridLive } from "../../clients/functions.ts";
import type { GridRow, LiveStatus } from "../../clients/grid.ts";
import { channelWords } from "../../rollout/channel-words.ts";

/** What the live reads gave for each company: null while reading, `failed` if they did. */
type Live = Record<string, LiveStatus> | "failed" | null;

/** A day, as the admin's pages say it. */
const dayOf = (at: Date): string => formatDate(at.toISOString().slice(0, 10));

/** A company's row: how it stands, then its figures; it opens its Setup. */
const CompanyRow = ({
  row,
  standing,
  needs,
}: {
  row: GridRow;
  standing: Standing;
  needs: PlatformNeed[];
}) => (
  <TableRow className="relative">
    <TableCell variant="card">
      <span className="flex min-w-0 flex-col gap-0.5">
        <Link
          className="truncate outline-none after:absolute after:inset-0 focus-visible:underline"
          params={{ clientId: row.id }}
          to="/organizations/$clientId/setup"
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
      {channelWords[row.channel]}
    </TableCell>
    <TableCell className="hidden @2xl:table-cell" variant="card">
      <span className="flex flex-col">
        <span className="font-mono text-xs">{row.release ?? "–"}</span>
        {row.pinnedReleaseId === null ? null : (
          <span className="text-muted-foreground text-xs">Pinned</span>
        )}
      </span>
    </TableCell>
    <TableCell variant="card">
      <ChevronRightIcon
        aria-hidden="true"
        className="text-muted-foreground mx-auto size-4"
      />
    </TableCell>
  </TableRow>
);

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
const EveryCompany = ({ rows, live }: { rows: GridRow[]; live: Live }) => {
  const read = live === null || live === "failed" ? {} : live;
  return (
    <Section description={everyCompanyLine(live)} title="Every company">
      <div className="@container border-t">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Company</TableHead>
              <TableHead className="hidden w-36 @xl:table-cell" variant="card">
                Channel
              </TableHead>
              <TableHead className="hidden w-36 @2xl:table-cell" variant="card">
                Release
              </TableHead>
              <TableHead className="w-9" variant="card">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {companiesOf(rows, read).map(({ row, standing, needs }) => (
              <CompanyRow
                key={row.id}
                needs={needs}
                row={row}
                standing={standing}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
};

/** What someone at Grasp did, as the admin's audit log keeps it. */
const DoneHere = ({
  events,
  names,
}: {
  events: StaffEvent[];
  names: ReadonlyMap<string, string>;
}) =>
  events.length === 0 ? null : (
    <Section
      description="What someone at Grasp did, as the admin keeps it."
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
    </Section>
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
 * Every company's own Grasp at once: what blocks onboarding, every
 * company the ones that need a look first, and what staff did.
 */
const PlatformPage = () => {
  const { rows, platform, readiness } = Route.useLoaderData();
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
      description="Every company runs its own Grasp, in the EU, apart from every other company’s. Each follows a channel: Edge gets every release as it lands, Beta what was on Edge, Stable what was on Beta. The admin deploys each company to its channel’s release by itself."
      title="Platform"
    >
      <PlatformNav />
      <div className="@container flex flex-col gap-6 text-sm">
        <ReadinessPanel readiness={readiness} />
        <EveryCompany live={live} rows={rows} />
        <DoneHere events={platform.events} names={names} />
      </div>
    </AdminPage>
  );
};

/** Every company's own deployment. */
export const Route = createFileRoute("/platform/")({
  loader: async () => {
    const [rows, platform, readiness] = await Promise.all([
      fetchClientGrid(),
      fetchPlatform(),
      fetchReadiness(),
    ]);
    return { rows, platform, readiness };
  },
  component: PlatformPage,
  pendingComponent: PageLoading,
});
