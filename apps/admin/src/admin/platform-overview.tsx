/**
 * Platform's overview, composed as Grasp Work composes a page: four
 * figures that say at a glance how every organization's own Grasp stands
 * (whether anything stops onboarding, how many run their channel's
 * release, how many cores answer, how many need a look), what isn't ready
 * while something isn't, the three channels with what staff do with them,
 * the organizations that need a look beside the latest changes of a
 * channel's release, and what Grasp's own AI costs. Drawn from what the
 * admin recorded and what each account answers live: names and counts,
 * no person and nothing anyone wrote.
 */
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { CircleCheckIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import type { GridRow, LiveStatus } from "../clients/grid.ts";
import { channelWords } from "../rollout/channel-words.ts";
import type { PromotionEvent } from "../rollout/channels.ts";
import type { ChannelProgress } from "../rollout/progress.ts";
import { Channels, openWords, RecentChanges } from "./channel-parts.tsx";
import { LoadingLines } from "./failure.tsx";
import { LoadingFigure, MissingFigure } from "./figures.tsx";
import { PagePart } from "./page-part.tsx";
import { channelsId } from "./platform-nav.tsx";
import { needWords, StandingMark } from "./platform-parts.tsx";
import type { PlatformSpend } from "./platform-spend-sums.ts";
import { PlatformSpendPart } from "./platform-spend.tsx";
import { companiesOf } from "./platform.ts";
import type { PlatformNeed, Standing } from "./platform.ts";
import { ReadinessFigure, ReadinessPart } from "./readiness-parts.tsx";
import type { Readiness } from "./readiness.ts";
import { formatList } from "./words.ts";

const WIDE = "@media (width >= 64rem)";

const styles = stylex.create({
  // What needs a look beside what changed lately, on a wide window.
  pair: {
    display: "grid",
    gap: space["6"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDE]: "minmax(0, 3fr) minmax(0, 2fr)",
    },
    alignItems: "start",
  },
});

/** What the live reads gave for each company: null while reading, `failed` if they did. */
export type Live = Record<string, LiveStatus> | "failed" | null;

/** How many of every channel's companies run its release: pinned ones aside, as the channels count them. */
const UpToDateFigure = ({
  channels,
}: {
  channels: readonly ChannelProgress[];
}) => {
  const following = channels.reduce((sum, each) => sum + each.following, 0);
  const upToDate = channels.reduce((sum, each) => sum + each.upToDate, 0);
  const failed = channels.some((each) => each.failed);
  return (
    <Stat
      change={
        following === 0
          ? "No company follows a channel yet"
          : (openWords(
              // Pinned ones aside, as the figure counts them.
              channels
                .flatMap(({ clients }) => clients)
                .filter(({ pinnedReleaseId }) => pinnedReleaseId === null)
            ) ?? "On their channel’s release")
      }
      label="Up to date"
      value={`${upToDate} of ${following}`}
      {...(failed ? { variant: "destructive" as const } : {})}
    />
  );
};

/** How many active companies' cores the router reaches now, once the accounts are read. */
const CoresFigure = ({ rows, live }: { rows: GridRow[]; live: Live }) => {
  if (live === null) {
    return <LoadingFigure label="Cores answering" />;
  }
  if (live === "failed") {
    return (
      <MissingFigure
        label="Cores answering"
        missing="Not read"
        why="The accounts couldn’t be read just now"
      />
    );
  }
  const active = rows.filter(({ status }) => status === "active");
  const reach = active.map(({ id }) => live[id]?.reach ?? "unknown");
  const answering = reach.filter((each) => each === "reachable").length;
  const silent = reach.filter(
    (each) => each === "unreachable" || each === "no_route"
  ).length;
  const unread = reach.length - answering - silent;
  const parts = [
    silent > 0 ? `${silent} not answering` : null,
    unread > 0 ? `${unread} not read` : null,
  ].filter((part) => part !== null);
  return (
    <Stat
      change={parts.length === 0 ? "Every core answers" : parts.join(" · ")}
      label="Cores answering"
      value={`${answering} of ${active.length}`}
      {...(silent > 0 ? { variant: "destructive" as const } : {})}
    />
  );
};

/** What a need is, in a word or two, for the figure's line. */
const needKindWords: Readonly<Record<PlatformNeed["kind"], string>> = {
  needs_attention: "setup needs a person",
  not_started: "not set up",
  stopped: "setup stopped",
  setup_unread: "setup not read",
  failed: "deploy failed",
  drift: "runs another version",
  unreachable: "not answering",
};

/** A company that needs a look, how it stands, and what it needs. */
interface Looked {
  row: GridRow;
  standing: Standing;
  needs: PlatformNeed[];
}

/**
 * The companies whose platform needs a look, isn't set up yet or, once
 * the accounts were read, didn't answer: until the accounts are read, one
 * that isn't read yet is no finding.
 */
const needingALook = (rows: readonly GridRow[], live: Live): Looked[] => {
  const answered = live !== null && live !== "failed";
  return companiesOf(rows, answered ? live : {}).filter(
    ({ standing }) =>
      standing === "attention" ||
      standing === "setup" ||
      (standing === "unread" && answered)
  );
};

/**
 * How many companies need a look, and for what, in a few words: once the
 * accounts are read. Until then it waits; when they couldn't be read it
 * counts what the admin recorded and says the rest wasn't read, never
 * that all is well.
 */
const NeedsFigure = ({ looked, live }: { looked: Looked[]; live: Live }) => {
  if (live === null) {
    return <LoadingFigure label="Need a look" />;
  }
  const count = (kept: (each: Looked) => boolean, words: string) => {
    const many = looked.filter(kept).length;
    return many === 0 ? [] : [`${many} ${words}`];
  };
  const parts = [
    ...Object.entries(needKindWords).flatMap(([kind, words]) =>
      count(({ needs }) => needs.some((need) => need.kind === kind), words)
    ),
    // Its version wasn't read (`standingOf` reads drift): its core may well answer.
    ...count(
      ({ needs, standing }) => needs.length === 0 && standing === "unread",
      "not read"
    ),
    ...count(
      ({ needs, standing }) => needs.length === 0 && standing === "setup",
      "being set up"
    ),
  ];
  const recorded = parts.length === 0 ? null : formatList(parts);
  let change = recorded ?? "Every company runs as it should";
  if (live === "failed") {
    change =
      recorded === null
        ? "The accounts couldn’t be read"
        : `${recorded}; the accounts couldn’t be read`;
  }
  return (
    <Stat
      change={change}
      label="Need a look"
      value={String(looked.length)}
      {...(looked.length > 0 || live === "failed"
        ? { variant: "warning" as const }
        : {})}
    />
  );
};

/** What the list says of its rows while the accounts are read, or when they couldn't be. */
const lookLine = (live: Live): string | undefined => {
  if (live === null) {
    return "Each account is being read now: what it runs shows once it answers.";
  }
  return live === "failed"
    ? "The accounts couldn’t be read just now, so what they run is left out."
    : undefined;
};

/** What a company needs first; with no need, that it is being set up or that what it runs wasn't read. */
const lookWords = ({ needs, standing }: Looked): string => {
  const [first] = needs;
  if (first === undefined) {
    return standing === "setup"
      ? "Being set up."
      : "What it runs couldn’t be read just now.";
  }
  return needWords(first);
};

/**
 * What the list shows with no company in it: that nothing needs a look,
 * once the accounts answered; until then it waits, and when they couldn't
 * be read its line (`lookLine`) says so and nothing more.
 */
const NoneNeedsALook = ({ live }: { live: Live }) => {
  if (live === null) {
    return <LoadingLines lines={2} />;
  }
  if (live === "failed") {
    return null;
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia icon={CircleCheckIcon} />
        <EmptyTitle>Nothing needs a look</EmptyTitle>
        <EmptyDescription>
          A company whose deploy failed, whose setting up waits, whose core
          doesn’t answer or whose account runs another version shows here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/** The companies that need a look, each a row to its Setup: what it needs, its channel and how it stands. */
const NeedsALook = ({ looked, live }: { looked: Looked[]; live: Live }) => (
  <PagePart description={lookLine(live)} id="needs-a-look" title="Needs a look">
    {looked.length === 0 ? (
      <NoneNeedsALook live={live} />
    ) : (
      <ItemGroup aria-labelledby="needs-a-look" separated>
        {looked.map((each) => (
          <Item asChild key={each.row.id} size="sm">
            <Link
              params={{ clientId: each.row.id }}
              to="/organizations/$clientId/setup"
            >
              <ItemContent>
                <ItemTitle>
                  {each.row.name}
                  <ItemDetail>
                    {[
                      channelWords[each.row.channel],
                      each.row.release,
                      each.row.pinnedReleaseId === null ? null : "Pinned",
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </ItemDetail>
                </ItemTitle>
                <ItemDescription>
                  {[
                    lookWords(each),
                    ...each.needs.slice(1).map(needWords),
                  ].join(" ")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <StandingMark standing={each.standing} />
              </ItemActions>
            </Link>
          </Item>
        ))}
      </ItemGroup>
    )}
  </PagePart>
);

/** Everything the overview shows under its tabs. */
export const PlatformOverview = ({
  rows,
  channels,
  history,
  readiness,
  spend,
  live,
}: {
  rows: GridRow[];
  /** As `useFollowDeploys` follows them. */
  channels: readonly ChannelProgress[];
  history: readonly PromotionEvent[];
  readiness: Readiness;
  spend: Promise<PlatformSpend | null>;
  live: Live;
}) => {
  const looked = needingALook(rows, live);
  return (
    <>
      <StatGroup aria-label="How the platform stands" columns={4}>
        <ReadinessFigure readiness={readiness} />
        <UpToDateFigure channels={channels} />
        <CoresFigure live={live} rows={rows} />
        <NeedsFigure live={live} looked={looked} />
      </StatGroup>
      <ReadinessPart readiness={readiness} />
      <Channels channels={channels} id={channelsId} />
      <div {...stylex.props(styles.pair)}>
        <NeedsALook live={live} looked={looked} />
        <RecentChanges history={history} />
      </div>
      <PlatformSpendPart spend={spend} />
    </>
  );
};
