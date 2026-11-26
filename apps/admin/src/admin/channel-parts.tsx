/**
 * The release channels on Platform, derived live (src/rollout/progress.ts):
 * each channel's release, how many of its companies run it, each company's
 * state, Retry once a deploy failed, and Promote with only the moves the
 * channel may make. Then the latest changes of a channel's release, from the
 * audit log.
 */
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent, CardFooter } from "@grasp-os/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress } from "@grasp-os/ui/components/progress";
import { Text } from "@grasp-os/ui/components/text";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { formatTime } from "../releases/format.ts";
import { releaseTitle } from "../releases/version.ts";
import { channelWords } from "../rollout/channel-words.ts";
import type { PromotionEvent } from "../rollout/channels.ts";
import { promoteReleaseFn, retryChannelFn } from "../rollout/functions.ts";
import type { ChannelProgress, ClientProgress } from "../rollout/progress.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh } from "../use-action.ts";
import { Panel, PanelNote } from "./panel.tsx";
import { fetchChannels } from "./platform-data.ts";
import { clientStateWords } from "./platform-parts.tsx";
import { formatList } from "./words.ts";

const styles = stylex.create({
  // A company's state: in the warning's colour once its deploy failed,
  // quiet while it waits or is pinned.
  figures: { fontVariantNumeric: "tabular-nums" },
  stateFailed: { color: colors.warning },
  stateQuiet: { color: colors.mutedForeground },
  // The release under a channel's name: its id, then its title in two
  // lines at most, three lines kept so the channels stand level.
  release: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    minHeight: "3.75rem",
  },
  releaseTitle: {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  progress: { display: "flex", flexDirection: "column", gap: space["2"] },
  progressLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space["4"],
    rowGap: space["1"],
    minHeight: space["6"],
  },
  stands: {
    display: "flex",
    alignItems: "center",
    gap: space["3"],
    minWidth: 0,
  },
  standsWords: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textAlign: "end",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
  },
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    width: "100%",
  },
  promote: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  select: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
  retry: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
  },
  // Edge, Beta and Stable side by side from a desktop's width.
  channels: {
    display: "grid",
    gap: space["6"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.xl]: "repeat(3, minmax(0, 1fr))",
    },
  },
  quiet: { color: colors.mutedForeground },
});

/** What a channel with no release yet says. */
const emptyWords = (channel: ChannelProgress["channel"]): string =>
  channel === "edge"
    ? "No release yet: Edge takes each new release as the admin imports it."
    : `No release yet. Promote a release to ${channelWords[channel]} first: its companies wait until then.`;

/** One company of a channel: its name, where it stands, and why. */
const ClientLine = ({ client }: { client: ClientProgress }) => (
  <Item size="sm">
    <ItemContent>
      <ItemTitle>
        <Link asChild variant="plain">
          <RouterLink
            params={{ clientId: client.id }}
            to="/organizations/$clientId/setup"
          >
            {client.name}
          </RouterLink>
        </Link>
      </ItemTitle>
    </ItemContent>
    <ItemActions>
      <span
        {...stylex.props(
          styles.figures,
          client.state === "failed" && styles.stateFailed,
          (client.state === "waiting" || client.state === "pinned") &&
            styles.stateQuiet
        )}
      >
        {clientStateWords[client.state]}
        {client.pinnedReleaseId === null ? null : ` ${client.pinnedReleaseId}`}
        {client.error === null ? null : ` ${client.error}`}
      </span>
    </ItemActions>
  </Item>
);

/** Why the last move didn't apply, where it was made: said when it appears. */
const Refused = ({ failure }: { failure: string | null }) =>
  failure === null ? null : (
    <Alert appearance="subtle" variant="destructive">
      <AlertDescription>{failure}</AlertDescription>
    </Alert>
  );

/** Moves `channel` to a release it may take: promoted from the channel before, or back. */
const Promote = ({ channel }: { channel: ChannelProgress }) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  if (channel.promotable.length === 0) {
    return null;
  }
  return (
    <form
      {...stylex.props(styles.promote)}
      onSubmit={(event) => {
        event.preventDefault();
        const releaseId = new FormData(event.currentTarget).get("releaseId");
        if (typeof releaseId !== "string") {
          return;
        }
        void run(
          async () =>
            await thenRefresh(
              async () =>
                await promoteReleaseFn({
                  data: { channel: channel.channel, releaseId },
                }),
              async () => {
                await router.invalidate({ sync: true });
              }
            )
        );
      }}
    >
      <NativeSelect
        aria-label={`Release for ${channelWords[channel.channel]}`}
        id={`promote-${channel.channel}`}
        name="releaseId"
        size="sm"
        style={styles.select}
      >
        {channel.promotable.map(({ releaseId, back }) => (
          <NativeSelectOption key={releaseId} value={releaseId}>
            {back ? `${releaseId} (back)` : releaseId}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button disabled={busy} size="sm" type="submit" variant="outline">
        {channel.channel === "edge" ? "Set back" : "Promote"}
      </Button>
      <Refused failure={failure} />
    </form>
  );
};

/** Clears a channel's failed deploys, so the reconciler tries them again. */
const Retry = ({ channel }: { channel: ChannelProgress["channel"] }) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  return (
    <div {...stylex.props(styles.retry)}>
      <Button
        disabled={busy}
        onClick={() => {
          void run(
            async () =>
              await thenRefresh(
                async () => await retryChannelFn({ data: { channel } }),
                async () => {
                  await router.invalidate({ sync: true });
                }
              )
          );
        }}
        size="sm"
      >
        Retry
      </Button>
      <Refused failure={failure} />
    </div>
  );
};

/** The states of a channel's companies that say something is still to happen, the most pressing first. */
const openStates = [
  "failed",
  "deploying",
  "waiting",
  "no_release",
  "pinned",
] as const satisfies readonly ClientProgress["state"][];

/** Where a channel's companies stand, in a few words: all of them up to date, or how many aren't and why. */
const standsWords = (clients: readonly ClientProgress[]): string => {
  const parts = openStates.flatMap((state) => {
    const count = clients.filter((client) => client.state === state).length;
    return count === 0
      ? []
      : [`${count} ${clientStateWords[state].toLowerCase()}`];
  });
  return parts.length === 0 ? "All up to date" : formatList(parts);
};

/**
 * A channel's companies, folded under one line that says how many there
 * are and where they stand: three channels side by side stay one height
 * and in line, however many companies each has. Open from the start while
 * a deploy moves or failed, which is when each company's state is what the
 * page is opened for. Kept on the page while folded: found by its search.
 */
const ChannelClients = ({ channel }: { channel: ChannelProgress }) => {
  const { clients } = channel;
  if (clients.length === 0) {
    return <PanelNote>No company follows it.</PanelNote>;
  }
  const moving = clients.some(
    ({ state }) =>
      state === "failed" || state === "deploying" || state === "waiting"
  );
  const count =
    clients.length === 1 ? "1 organization" : `${clients.length} organizations`;
  return (
    <CardContent>
      <Collapsible defaultOpen={moving}>
        <CollapsibleTrigger>
          <span {...stylex.props(styles.stands)}>
            <span>{count}</span>
            <span {...stylex.props(visuallyHidden)}>: </span>
            <span
              {...stylex.props(
                styles.standsWords,
                channel.failed && styles.stateFailed
              )}
            >
              {standsWords(clients)}
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ItemGroup separated>
            {clients.map((client) => (
              <ClientLine client={client} key={client.id} />
            ))}
          </ItemGroup>
        </CollapsibleContent>
      </Collapsible>
    </CardContent>
  );
};

/**
 * One channel: its release, its progress, its companies and what can be
 * done. The same parts at the same heights in each, so Edge, Beta and
 * Stable line up side by side: the release in three lines at most, how
 * many companies run it, the companies folded under one line, and what
 * staff can do at the foot of the card.
 */
const ChannelPanel = ({ channel }: { channel: ChannelProgress }) => {
  const title = releaseTitle(channel.notes);
  const promotes = channel.promotable.length > 0;
  return (
    <Panel
      description={
        <span {...stylex.props(styles.release)}>
          {channel.releaseId === null ? (
            emptyWords(channel.channel)
          ) : (
            <>
              <Link asChild variant="plain">
                <RouterLink
                  params={{ releaseId: channel.releaseId }}
                  to="/platform/releases/$releaseId"
                >
                  {channel.releaseId}
                </RouterLink>
              </Link>
              {title === "" ? null : (
                <span title={title} {...stylex.props(styles.releaseTitle)}>
                  {title}
                </span>
              )}
            </>
          )}
        </span>
      }
      title={channelWords[channel.channel]}
    >
      <CardContent>
        <div {...stylex.props(styles.progress)}>
          <span {...stylex.props(styles.progressLine)}>
            <Text as="span" color="default" size="sm">
              {channel.releaseId === null
                ? "Nothing to roll out yet"
                : `${channel.upToDate} of ${channel.following} up to date`}
            </Text>
            {channel.failed ? (
              <Badge variant="warning">
                Failed: nothing new starts until Retry
              </Badge>
            ) : null}
          </span>
          <Progress
            aria-label={`${channelWords[channel.channel]} companies up to date`}
            value={
              channel.releaseId === null || channel.following === 0
                ? 0
                : (channel.upToDate / channel.following) * 100
            }
          />
        </div>
      </CardContent>
      <ChannelClients channel={channel} />
      {channel.failed || promotes ? (
        <CardFooter>
          <div {...stylex.props(styles.actions)}>
            {channel.failed ? <Retry channel={channel.channel} /> : null}
            <Promote channel={channel} />
          </div>
        </CardFooter>
      ) : null}
    </Panel>
  );
};

/** How often the channels are read again while a deploy moves on. */
const followMs = 5000;

/** Channels read again, and the page's `channels` they were read after. */
interface Followed {
  after: readonly ChannelProgress[];
  channels: readonly ChannelProgress[];
}

/**
 * Reads each channel's progress again every few seconds while a company
 * of a channel is deploying or waiting to, so its state, Retry and the
 * counts follow the reconciler. Only the channels: the rest of the
 * Platform page, every company's AI spend above all (a read of each
 * core), isn't read again. A failed channel starts nothing until Retry,
 * so its waiting companies don't count. Once the page itself is read
 * again (after Promote or Retry), its own channels show.
 */
const useFollowDeploys = (
  channels: readonly ChannelProgress[]
): readonly ChannelProgress[] => {
  const [followed, setFollowed] = useState<Followed | null>(null);
  const shown =
    followed !== null && followed.after === channels
      ? followed.channels
      : channels;
  const moving = shown.some(({ failed, clients }) =>
    clients.some(
      ({ state }) => state === "deploying" || (state === "waiting" && !failed)
    )
  );
  useEffect(() => {
    let current = true;
    const follow = async () => {
      try {
        const read = await fetchChannels();
        // A page left, or read again, before its answer came doesn't take it.
        if (current) {
          setFollowed({ after: channels, channels: read });
        }
      } catch {
        // What shows stays as it is; the next read tries again.
      }
    };
    const timer = moving
      ? setInterval(() => {
          void follow();
        }, followMs)
      : undefined;
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [moving, channels]);
  return shown;
};

/** Edge, Beta and Stable, side by side where there's room. */
export const Channels = ({
  id,
  channels,
}: {
  id: string;
  channels: readonly ChannelProgress[];
}) => {
  const shown = useFollowDeploys(channels);
  return (
    <div id={id} {...stylex.props(styles.channels)}>
      {shown.map((channel) => (
        <ChannelPanel channel={channel} key={channel.channel} />
      ))}
    </div>
  );
};

/** The latest changes of a channel's release, the newest first, as the audit log keeps it. */
export const PromotionHistory = ({
  history,
}: {
  history: readonly PromotionEvent[];
}) => (
  <Panel
    description="The latest changes of a channel's release, the newest first. Edge's come by themselves as releases are imported."
    title="Promotions"
  >
    {history.length === 0 ? (
      <PanelNote>No release has gone to a channel yet.</PanelNote>
    ) : (
      <CardContent flush>
        <ItemGroup separated>
          {history.map((event) => (
            <Item
              key={`${event.at.getTime()}-${event.channel}-${event.releaseId}`}
              size="sm"
            >
              <ItemContent>
                <ItemTitle>
                  {`${channelWords[event.channel]} ${event.back ? "set back" : "set"} to `}
                  <span {...stylex.props(styles.figures)}>
                    {event.releaseId}
                  </span>
                  {event.from === null ? null : (
                    <span {...stylex.props(styles.quiet)}>
                      {` from ${event.from}`}
                    </span>
                  )}
                  <span {...stylex.props(styles.quiet)}>
                    {` by ${event.actor}`}
                  </span>
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Text as="span" color="muted" size="xs">
                  {formatTime(event.at)}
                </Text>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
    )}
  </Panel>
);
