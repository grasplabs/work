/**
 * The release channels on Platform, derived live (src/rollout/progress.ts),
 * set on the page as Grasp Work sets its parts: each channel a part of its
 * own, its release under its name and what staff may do with it at the
 * end of that line (Retry once a deploy failed, Promote with only the moves
 * the channel may make), then how many of its organizations run it, each
 * one a row to its Setup. Then the latest changes of a channel's release,
 * from the audit log.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress, ProgressLabel } from "@grasp-os/ui/components/progress";
import { Section, SectionHeader } from "@grasp-os/ui/components/section-header";
import { Separator } from "@grasp-os/ui/components/separator";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
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
import { EmptyPart, PagePart, PartNote } from "./page-part.tsx";
import { fetchChannels } from "./platform-data.ts";
import { clientStateWords } from "./platform-parts.tsx";
import { actorWords } from "./setup-history.ts";
import { Failure } from "./setup-parts.tsx";
import { formatList, plural } from "./words.ts";

const styles = stylex.create({
  // A company's state: in the destructive colour once its deploy failed,
  // quiet while it waits or is pinned.
  stateFailed: { color: colors.destructive },
  stateQuiet: { color: colors.mutedForeground },
  // Edge, Beta and Stable, one under the other, a hairline between two.
  channels: { display: "flex", flexDirection: "column", gap: space["6"] },
  // Its release and what staff do with it, then how far it has come.
  channel: { display: "flex", flexDirection: "column", gap: space["4"] },
  promote: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  select: { width: "11rem" },
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
});

/** What a channel with no release yet says. */
const emptyWords = (channel: ChannelProgress["channel"]): string =>
  channel === "edge"
    ? "No release yet: Edge takes each new release as the admin imports it."
    : `No release yet. Promote a release to ${channelWords[channel]} first: its companies wait until then.`;

/** One company of a channel, a row to its Setup: where it stands, and why. */
const ClientLine = ({ client }: { client: ClientProgress }) => (
  <Item asChild size="sm">
    <RouterLink
      params={{ clientId: client.id }}
      to="/organizations/$clientId/setup"
    >
      <ItemContent>
        <ItemTitle>{client.name}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <span
          {...stylex.props(
            client.state === "failed" && styles.stateFailed,
            (client.state === "waiting" || client.state === "pinned") &&
              styles.stateQuiet
          )}
        >
          {clientStateWords[client.state]}
          {client.pinnedReleaseId === null
            ? null
            : ` ${client.pinnedReleaseId}`}
          {client.error === null ? null : ` ${client.error}`}
        </span>
      </ItemActions>
    </RouterLink>
  </Item>
);

/** How many companies, in words: "1 company", "3 companies". */
const companies = (count: number): string =>
  `${count} ${plural(count, "company", "companies")}`;

/**
 * The question before a move that changes what a channel's companies run:
 * what it is, and whom it reaches. Focus starts on Cancel; the move is the
 * weighty answer.
 */
const ConfirmMove = ({
  title,
  description,
  action,
  onConfirm,
}: {
  title: string;
  description: string;
  action: string;
  onConfirm: () => void;
}) => (
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={onConfirm} variant="destructive">
        {action}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
);

/**
 * Moves `channel` to a release it may take: promoted from the channel
 * before, or back. Every company that follows the channel moves, so it
 * asks first.
 */
const Promote = ({ channel }: { channel: ChannelProgress }) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  // The release chosen, while the question stands.
  const [asking, setAsking] = useState<string | null>(null);
  if (channel.promotable.length === 0) {
    return null;
  }
  const name = channelWords[channel.channel];
  const back = channel.channel === "edge";
  const promote = (releaseId: string) => {
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
  };
  return (
    <form
      {...stylex.props(styles.promote)}
      onSubmit={(event) => {
        event.preventDefault();
        const releaseId = new FormData(event.currentTarget).get("releaseId");
        if (typeof releaseId !== "string") {
          return;
        }
        setAsking(releaseId);
      }}
    >
      <NativeSelect
        aria-label={`Release for ${name}`}
        id={`promote-${channel.channel}`}
        name="releaseId"
        size="sm"
        style={styles.select}
      >
        {channel.promotable.map(({ releaseId, back: before }) => (
          <NativeSelectOption key={releaseId} value={releaseId}>
            {before ? `${releaseId} (back)` : releaseId}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button disabled={busy} size="sm" type="submit" variant="outline">
        {back ? "Set back" : "Promote"}
      </Button>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setAsking(null);
          }
        }}
        open={asking !== null}
      >
        <ConfirmMove
          action={back ? "Set back" : "Promote"}
          description={`${companies(channel.following)} on ${name} ${channel.following === 1 ? "moves" : "move"} to ${asking ?? ""}, in stages. Companies pinned to a release of their own stay on it.`}
          onConfirm={() => {
            if (asking !== null) {
              promote(asking);
            }
          }}
          title={
            back
              ? `Set ${name} back to ${asking ?? ""}?`
              : `Promote ${asking ?? ""} to ${name}?`
          }
        />
      </AlertDialog>
      <Failure failure={failure} />
    </form>
  );
};

/**
 * Clears a channel's failed deploys, so the reconciler tries them again:
 * it asks first, as its companies take the release again.
 */
const Retry = ({ channel }: { channel: ChannelProgress }) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  const name = channelWords[channel.channel];
  const failed = channel.clients.filter(
    (client) => client.state === "failed"
  ).length;
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button disabled={busy} size="sm">
            Retry
          </Button>
        </AlertDialogTrigger>
        <ConfirmMove
          action="Retry"
          description={`${companies(failed)} on ${name} whose deploy failed ${failed === 1 ? "tries" : "try"} again, each with the release it was being given, and new deploys start again.`}
          onConfirm={() => {
            void run(
              async () =>
                await thenRefresh(
                  async () =>
                    await retryChannelFn({
                      data: { channel: channel.channel },
                    }),
                  async () => {
                    await router.invalidate({ sync: true });
                  }
                )
            );
          }}
          title={`Retry ${name}’s failed deploys?`}
        />
      </AlertDialog>
      <Failure failure={failure} />
    </>
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

/** How many companies aren't up to date and why, in a few words; null when all of them are. */
export const openWords = (
  clients: readonly ClientProgress[]
): string | null => {
  const parts = openStates.flatMap((state) => {
    const count = clients.filter((client) => client.state === state).length;
    return count === 0
      ? []
      : [`${count} ${clientStateWords[state].toLowerCase()}`];
  });
  return parts.length === 0 ? null : formatList(parts);
};

/**
 * A channel's companies, folded under one line that says how many there
 * are and where they stand. Open from the start while a deploy moves or
 * failed, which is when each company's state is what the page is opened
 * for. Kept on the page while folded: found by its search.
 */
const ChannelClients = ({ channel }: { channel: ChannelProgress }) => {
  const { clients } = channel;
  const moving = clients.some(
    ({ state }) =>
      state === "failed" || state === "deploying" || state === "waiting"
  );
  return (
    <Collapsible defaultOpen={moving}>
      <CollapsibleTrigger>
        <span {...stylex.props(styles.stands)}>
          <span>{`${clients.length} ${plural(clients.length, "organization", "organizations")}`}</span>
          <span {...stylex.props(visuallyHidden)}>: </span>
          <span
            {...stylex.props(
              styles.standsWords,
              channel.failed && styles.stateFailed
            )}
          >
            {openWords(clients) ?? "All up to date"}
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
  );
};

/** A channel's release under its name: its id, to its page, and its title. */
const ReleaseLine = ({ channel }: { channel: ChannelProgress }) => {
  if (channel.releaseId === null) {
    return emptyWords(channel.channel);
  }
  const title = releaseTitle(channel.notes);
  return (
    <>
      <Link asChild variant="plain">
        <RouterLink
          params={{ releaseId: channel.releaseId }}
          to="/platform/releases/$releaseId"
        >
          {channel.releaseId}
        </RouterLink>
      </Link>
      {title === "" ? null : ` · ${title}`}
    </>
  );
};

/**
 * One channel: its name, its release and what staff can do with it on
 * one line, how many of its companies run that release, and its companies
 * folded under that.
 */
const ChannelPart = ({ channel }: { channel: ChannelProgress }) => {
  const name = channelWords[channel.channel];
  const heading = `channel-${channel.channel}`;
  const actions =
    channel.failed || channel.promotable.length > 0 ? (
      <>
        {channel.failed ? <Retry channel={channel} /> : null}
        <Promote channel={channel} />
      </>
    ) : undefined;
  return (
    <Section aria-labelledby={heading}>
      <SectionHeader
        actions={actions}
        badge={
          channel.failed ? (
            <Badge variant="destructive">
              Failed: nothing new starts until Retry
            </Badge>
          ) : undefined
        }
        description={<ReleaseLine channel={channel} />}
        headingLevel={3}
        id={heading}
        size="sm"
        title={name}
        variant="group"
      />
      {channel.clients.length === 0 ? (
        <PartNote>No company follows it.</PartNote>
      ) : (
        <div {...stylex.props(styles.channel)}>
          {channel.releaseId === null ? null : (
            <Progress
              aria-label={`${name} companies up to date`}
              value={
                channel.following === 0
                  ? 0
                  : (channel.upToDate / channel.following) * 100
              }
              variant={channel.failed ? "destructive" : "default"}
            >
              <ProgressLabel>{`${channel.upToDate} of ${channel.following} up to date`}</ProgressLabel>
            </Progress>
          )}
          <ChannelClients channel={channel} />
        </div>
      )}
    </Section>
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
export const useFollowDeploys = (
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

/** Edge, Beta and Stable, one under the other, as `useFollowDeploys` follows them. */
export const Channels = ({
  id,
  channels,
}: {
  id: string;
  channels: readonly ChannelProgress[];
}) => (
  <PagePart
    description="Every company follows one. Edge takes each release as the admin imports it; staff promote it to Beta, then to Stable."
    id={id}
    title="Channels"
  >
    <div {...stylex.props(styles.channels)}>
      {channels.map((channel, at) => (
        <div key={channel.channel} {...stylex.props(styles.channel)}>
          {at === 0 ? null : <Separator />}
          <ChannelPart channel={channel} />
        </div>
      ))}
    </div>
  </PagePart>
);

/** The latest changes of a channel's release, the newest first, as the audit log keeps it. */
export const RecentChanges = ({
  history,
}: {
  history: readonly PromotionEvent[];
}) => (
  <PagePart id="changes" title="Recent changes">
    {history.length === 0 ? (
      <EmptyPart>No release has gone to a channel yet.</EmptyPart>
    ) : (
      <ItemGroup aria-labelledby="changes" separated>
        {history.map((event) => (
          <Item
            key={`${event.at.getTime()}-${event.channel}-${event.releaseId}`}
            size="sm"
          >
            <ItemContent>
              <ItemTitle>
                {`${channelWords[event.channel]} ${event.back ? "set back" : "set"} to ${event.releaseId}`}
              </ItemTitle>
              <ItemDescription>
                {[
                  event.from === null ? null : `From ${event.from}`,
                  actorWords(event.actor),
                  `${formatTime(event.at)} UTC`,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    )}
  </PagePart>
);
