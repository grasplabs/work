import { CardContent } from "@grasp-os/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Channels, PromotionHistory } from "../../admin/channel-parts.tsx";
import { PageLoading } from "../../admin/failure.tsx";
import { AdminPage } from "../../admin/page.tsx";
import { Panel } from "../../admin/panel.tsx";
import { fetchPlatform } from "../../admin/platform-data.ts";
import { channelsId, PlatformNav } from "../../admin/platform-nav.tsx";
import { needWords, StandingMark } from "../../admin/platform-parts.tsx";
import { PlatformSpendPanel } from "../../admin/platform-spend.tsx";
import { companiesOf } from "../../admin/platform.ts";
import type { PlatformNeed, Standing } from "../../admin/platform.ts";
import { ReadinessPanel } from "../../admin/readiness-parts.tsx";
import { fetchReadiness } from "../../admin/readiness.ts";
import { fetchClientGrid, fetchGridLive } from "../../clients/functions.ts";
import type { GridRow, LiveStatus } from "../../clients/grid.ts";
import { fetchPlatformSpend } from "../../platform-ai-functions.ts";
import { channelWords } from "../../rollout/channel-words.ts";

const styles = stylex.create({
  // A company's name, how it stands and what it needs, down its cell.
  company: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
    minWidth: 0,
  },
  page: { display: "flex", flexDirection: "column", gap: space["6"] },
});

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
  <TableRow interactive>
    <TableCell rowHeader wrap>
      <span {...stylex.props(styles.company)}>
        <Link
          data-row-target
          params={{ clientId: row.id }}
          to="/organizations/$clientId/setup"
        >
          {row.name}
        </Link>
        <StandingMark standing={standing} />
        {needs.map((need) => (
          <Text as="span" color="muted" key={need.kind} size="xs">
            {needWords(need)}
          </Text>
        ))}
      </span>
    </TableCell>
    <TableCell hideBelow="sm" wrap>
      {channelWords[row.channel]}
    </TableCell>
    <TableCell hideBelow="md">
      <span {...stylex.props(styles.company)}>
        <span>{row.release ?? "–"}</span>
        {row.pinnedReleaseId === null ? null : (
          <Text as="span" color="muted" size="xs">
            Pinned
          </Text>
        )}
      </span>
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
 * The companies whose platform needs a look, isn't set up yet or, once the
 * accounts were read, didn't answer: nothing when every one is healthy,
 * for each stands under its channel above with the release it runs.
 */
const NeedsALook = ({ rows, live }: { rows: GridRow[]; live: Live }) => {
  const answered = live !== null && live !== "failed";
  // Until the accounts are read, one that isn't read yet is no finding.
  const companies = companiesOf(rows, answered ? live : {}).filter(
    ({ standing }) =>
      standing === "attention" ||
      standing === "setup" ||
      (standing === "unread" && answered)
  );
  if (companies.length === 0) {
    return null;
  }
  return (
    <Panel description={needsALookLine(live)} title="Needs a look">
      <CardContent flush>
        <Table aria-label="Needs a look">
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead hideBelow="sm" width={144}>
                Channel
              </TableHead>
              <TableHead hideBelow="md" width={144}>
                Release
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
      </CardContent>
    </Panel>
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
      <div {...stylex.props(styles.page)}>
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
    // Every company read anew on entering, not the frame's minute-old
    // grid: staff act on their deploys here.
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
