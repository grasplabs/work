/**
 * The release channels on Platform, derived live (src/rollout/progress.ts):
 * each channel's release, how many of its companies run it, each company's
 * state, Retry once a deploy failed, and Promote with only the moves the
 * channel may make. Then the latest changes of a channel's release, from the
 * audit log.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatTime } from "../releases/format.ts";
import { releaseTitle } from "../releases/version.ts";
import { channelWords } from "../rollout/channel-words.ts";
import type { PromotionEvent } from "../rollout/channels.ts";
import { promoteReleaseFn, retryChannelFn } from "../rollout/functions.ts";
import type { ChannelProgress, ClientProgress } from "../rollout/progress.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh } from "../use-action.ts";
import { Attention } from "./parts.tsx";
import { fetchChannels } from "./platform-data.ts";
import { clientStateWords } from "./platform-parts.tsx";
import { Quiet } from "./release-parts.tsx";
import { Section } from "./section.tsx";
import { formatList } from "./words.ts";

/** What a channel with no release yet says. */
const emptyWords = (channel: ChannelProgress["channel"]): string =>
  channel === "edge"
    ? "No release yet: Edge takes each new release as the admin imports it."
    : `No release yet. Promote a release to ${channelWords[channel]} first: its companies wait until then.`;

/** One company of a channel: its name, where it stands, and why. */
const ClientLine = ({ client }: { client: ClientProgress }) => (
  <li className="flex items-baseline justify-between gap-4 border-t px-5 py-2">
    <Link
      className="min-w-0 truncate underline-offset-4 hover:underline"
      params={{ clientId: client.id }}
      to="/organizations/$clientId/setup"
    >
      {client.name}
    </Link>
    <span
      className={cn(
        "flex-none text-right",
        client.state === "failed" && "text-status-attention",
        (client.state === "waiting" || client.state === "pinned") &&
          "text-muted-foreground"
      )}
    >
      {clientStateWords[client.state]}
      {client.pinnedReleaseId === null ? null : (
        <span className="tabular-nums">{` ${client.pinnedReleaseId}`}</span>
      )}
      {client.error === null ? null : (
        <span className="tabular-nums">{` ${client.error}`}</span>
      )}
    </span>
  </li>
);

/** Moves `channel` to a release it may take: promoted from the channel before, or back. */
const Promote = ({ channel }: { channel: ChannelProgress }) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  const id = `promote-${channel.channel}`;
  if (channel.promotable.length === 0) {
    return null;
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
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
      <Field className="min-w-0 flex-1">
        <FieldLabel className="sr-only" htmlFor={id}>
          {`Release for ${channelWords[channel.channel]}`}
        </FieldLabel>
        <NativeSelect id={id} name="releaseId">
          {channel.promotable.map(({ releaseId, back }) => (
            <NativeSelectOption key={releaseId} value={releaseId}>
              {back ? `${releaseId} (back)` : releaseId}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Button disabled={busy} size="sm" type="submit" variant="outline">
        {channel.channel === "edge" ? "Set back" : "Promote"}
      </Button>
      {failure === null ? null : (
        <p className="text-destructive w-full text-sm" role="alert">
          {failure}
        </p>
      )}
    </form>
  );
};

/** Clears a channel's failed deploys, so the reconciler tries them again. */
const Retry = ({ channel }: { channel: ChannelProgress["channel"] }) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  return (
    <div className="flex flex-col items-start gap-1">
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
      {failure === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      )}
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
    return <Quiet>No company follows it.</Quiet>;
  }
  const moving = clients.some(
    ({ state }) =>
      state === "failed" || state === "deploying" || state === "waiting"
  );
  const count =
    clients.length === 1 ? "1 organization" : `${clients.length} organizations`;
  return (
    <Collapsible defaultOpen={moving}>
      <CollapsibleTrigger
        // A whole row of the card that opens, as a card's other rows that open are drawn.
        render={
          <button
            aria-label={`${count}: ${standsWords(clients)}`}
            className="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 border-t px-5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset"
            type="button"
          />
        }
      >
        <span className="flex-none">{count}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-right">
          {channel.failed ? (
            <Attention className="justify-end">
              {standsWords(clients)}
            </Attention>
          ) : (
            standsWords(clients)
          )}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="text-muted-foreground size-4 flex-none transition-transform in-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <ul className="flex flex-col">
          {clients.map((client) => (
            <ClientLine client={client} key={client.id} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
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
    <Section
      description={
        <span className="flex min-h-15 flex-col gap-0.5">
          {channel.releaseId === null ? (
            emptyWords(channel.channel)
          ) : (
            <>
              <Link
                className="text-foreground self-start tabular-nums underline-offset-4 hover:underline"
                params={{ releaseId: channel.releaseId }}
                to="/platform/releases/$releaseId"
              >
                {channel.releaseId}
              </Link>
              {title === "" ? null : (
                <span className="line-clamp-2" title={title}>
                  {title}
                </span>
              )}
            </>
          )}
        </span>
      }
      title={channelWords[channel.channel]}
    >
      <div className="flex flex-col gap-2 border-t px-5 py-3">
        <span className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="tabular-nums">
            {channel.releaseId === null
              ? "Nothing to roll out yet"
              : `${channel.upToDate} of ${channel.following} up to date`}
          </span>
          {channel.failed ? (
            <Badge variant="attention">
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
      <ChannelClients channel={channel} />
      {channel.failed || promotes ? (
        <div className="mt-auto flex flex-col gap-3 border-t px-5 py-3">
          {channel.failed ? <Retry channel={channel.channel} /> : null}
          <Promote channel={channel} />
        </div>
      ) : null}
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
    <div className="grid gap-6 @4xl:grid-cols-3" id={id}>
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
  <Section
    description="The latest changes of a channel's release, the newest first. Edge's come by themselves as releases are imported."
    title="Promotions"
  >
    {history.length === 0 ? (
      <Quiet>No release has gone to a channel yet.</Quiet>
    ) : (
      <ul className="flex flex-col">
        {history.map((event) => (
          <li
            className="flex items-baseline justify-between gap-4 border-t px-5 py-2"
            key={`${event.at.getTime()}-${event.channel}-${event.releaseId}`}
          >
            <span className="min-w-0">
              {`${channelWords[event.channel]} ${event.back ? "set back" : "set"} to `}
              <span className="tabular-nums">{event.releaseId}</span>
              {event.from === null ? null : (
                <span className="text-muted-foreground">{` from ${event.from}`}</span>
              )}
              <span className="text-muted-foreground">{` by ${event.actor}`}</span>
            </span>
            <span className="text-muted-foreground flex-none text-xs tabular-nums">
              {formatTime(event.at)}
            </span>
          </li>
        ))}
      </ul>
    )}
  </Section>
);
