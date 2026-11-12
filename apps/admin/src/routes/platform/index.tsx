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

import { Channels, PromotionHistory } from "../../admin/channel-parts.tsx";
import { PageLoading } from "../../admin/failure.tsx";
import { AdminPage } from "../../admin/page.tsx";
import { fetchPlatform } from "../../admin/platform-data.ts";
import { channelsId, PlatformNav } from "../../admin/platform-nav.tsx";
import { needWords, StandingMark } from "../../admin/platform-parts.tsx";
import { PlatformSpendPanel } from "../../admin/platform-spend.tsx";
import { companiesOf } from "../../admin/platform.ts";
import type { PlatformNeed, Standing } from "../../admin/platform.ts";
import { ReadinessPanel } from "../../admin/readiness-parts.tsx";
import { fetchReadiness } from "../../admin/readiness.ts";
import { Section } from "../../admin/section.tsx";
import { fetchClientGrid, fetchGridLive } from "../../clients/functions.ts";
import type { GridRow, LiveStatus } from "../../clients/grid.ts";
import { fetchPlatformSpend } from "../../platform-ai-functions.ts";
import { channelWords } from "../../rollout/channel-words.ts";

/** What the live reads gave for each company: null while reading, `failed` if they did. */
type Live = Record<string, LiveStatus> | "failed" | null;

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

/** What the list says of its figures while they are read, or when they couldn't be. */
const needsALookLine = (live: Live): string | undefined => {
  if (live === null) {
    return "Each account's figures are being read now.";
  }
  return live === "failed"
    ? "The accounts couldn't be read just now, so their figures are left out."
    : undefined;
};

/**
 * The companies whose platform needs a look, isn't set up yet or wasn't
 * read: nothing when every one is healthy, for each stands under its
 * channel above with the release it runs.
 */
const NeedsALook = ({ rows, live }: { rows: GridRow[]; live: Live }) => {
  const read = live === null || live === "failed" ? {} : live;
  const companies = companiesOf(rows, read).filter(
    ({ standing }) => standing !== "healthy" && standing !== "offboarded"
  );
  if (companies.length === 0) {
    return null;
  }
  return (
    <Section description={needsALookLine(live)} title="Needs a look">
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
            {companies.map(({ row, standing, needs }) => (
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

/** The live figures of every active company, read once the page shows. */
const readLive = async (): Promise<Record<string, LiveStatus> | "failed"> => {
  try {
    return await fetchGridLive();
  } catch {
    return "failed";
  }
};

/**
 * Every company's own Grasp at once: what blocks onboarding, the three
 * release channels with each company's state against them and the moves
 * each may make, the companies that need a look, and what Grasp's own AI
 * costs. Shared secrets and what staff did are on Maintenance.
 */
const PlatformPage = () => {
  const { rows, platform, readiness, spend } = Route.useLoaderData();
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
  return (
    <AdminPage
      description="Every company runs its own Grasp and follows a channel: Edge, then Beta, then Stable."
      title="Platform"
    >
      <PlatformNav />
      <div className="@container flex flex-col gap-6 text-sm">
        <ReadinessPanel readiness={readiness} />
        <Channels channels={platform.channels} id={channelsId} />
        <PromotionHistory history={platform.history} />
        <NeedsALook live={live} rows={rows} />
        <PlatformSpendPanel spend={spend} />
      </div>
    </AdminPage>
  );
};

/** Every company's own deployment, and the channels. */
export const Route = createFileRoute("/platform/")({
  loader: async () => {
    // Not awaited: every core is read live. A read that fails shows a
    // line, never the error page.
    const spend = (async () => {
      try {
        return await fetchPlatformSpend();
      } catch {
        return null;
      }
    })();
    const [rows, platform, readiness] = await Promise.all([
      fetchClientGrid(),
      fetchPlatform(),
      fetchReadiness(),
    ]);
    return { rows, platform, readiness, spend };
  },
  component: PlatformPage,
  pendingComponent: PageLoading,
});
