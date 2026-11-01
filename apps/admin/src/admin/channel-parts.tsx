/**
 * The release channels on Platform, derived live (src/rollout/progress.ts):
 * each channel's release, how many of its companies run it, each company's
 * state, Retry once a deploy failed, and Promote with only the moves the
 * channel may make. Then every change of a channel's release, from the
 * audit log.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link, useRouter } from "@tanstack/react-router";

import { formatTime } from "../releases/format.ts";
import { releaseTitle } from "../releases/version.ts";
import { channelWords } from "../rollout/channel-words.ts";
import type { PromotionEvent } from "../rollout/channels.ts";
import { promoteReleaseFn, retryChannelFn } from "../rollout/functions.ts";
import type { ChannelProgress, ClientProgress } from "../rollout/progress.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh } from "../use-action.ts";
import { clientStateWords } from "./platform-parts.tsx";
import { Quiet } from "./release-parts.tsx";
import { Section } from "./section.tsx";

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
        <span className="font-mono text-xs">{` ${client.pinnedReleaseId}`}</span>
      )}
      {client.error === null ? null : (
        <span className="font-mono text-xs">{` ${client.error}`}</span>
      )}
    </span>
  </li>
);

/** Moves `channel` to a release it may take: promoted from the channel before, or back. */
const Promote = ({
  channel,
  history,
}: {
  channel: ChannelProgress;
  history: readonly PromotionEvent[];
}) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  const id = `promote-${channel.channel}`;
  if (channel.promotable.length === 0) {
    return null;
  }
  const back = (releaseId: string) =>
    history.some(
      (event) =>
        event.channel === channel.channel && event.releaseId === releaseId
    );
  return (
    <form
      className="flex flex-wrap items-end gap-2"
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
      <Field>
        <FieldLabel className="sr-only" htmlFor={id}>
          {`Release for ${channelWords[channel.channel]}`}
        </FieldLabel>
        <NativeSelect id={id} name="releaseId">
          {channel.promotable.map((releaseId) => (
            <NativeSelectOption key={releaseId} value={releaseId}>
              {back(releaseId) ? `${releaseId} (back)` : releaseId}
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
    <div className="flex flex-col items-end gap-1">
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

/** One channel: its release, its progress, its companies and what can be done. */
const ChannelPanel = ({
  channel,
  history,
}: {
  channel: ChannelProgress;
  history: readonly PromotionEvent[];
}) => {
  const title = releaseTitle(channel.notes);
  return (
    <Section
      action={
        <div className="flex flex-col items-end gap-2">
          {channel.failed ? <Retry channel={channel.channel} /> : null}
          <Promote channel={channel} history={history} />
        </div>
      }
      description={
        channel.releaseId === null ? (
          emptyWords(channel.channel)
        ) : (
          <span className="flex flex-col gap-0.5">
            <Link
              className="font-mono text-xs underline-offset-4 hover:underline"
              params={{ releaseId: channel.releaseId }}
              to="/platform/releases/$releaseId"
            >
              {channel.releaseId}
            </Link>
            {title === "" ? null : <span>{title}</span>}
          </span>
        )
      }
      title={channelWords[channel.channel]}
    >
      {channel.releaseId === null ? null : (
        <div className="flex flex-col gap-1.5 border-t px-5 py-3">
          <span className="flex items-center justify-between gap-4">
            <span className="tabular-nums">{`${channel.upToDate} of ${channel.following} up to date`}</span>
            {channel.failed ? (
              <Badge variant="attention">
                Failed: nothing new starts until Retry
              </Badge>
            ) : null}
          </span>
          <Progress
            aria-label={`${channelWords[channel.channel]} companies up to date`}
            value={
              channel.following === 0
                ? 100
                : (channel.upToDate / channel.following) * 100
            }
          />
        </div>
      )}
      {channel.clients.length === 0 ? (
        <Quiet>No company follows it.</Quiet>
      ) : (
        <ul className="flex flex-col">
          {channel.clients.map((client) => (
            <ClientLine client={client} key={client.id} />
          ))}
        </ul>
      )}
    </Section>
  );
};

/** Edge, Beta and Stable, side by side where there's room. */
export const Channels = ({
  id,
  channels,
  history,
}: {
  id: string;
  channels: readonly ChannelProgress[];
  history: readonly PromotionEvent[];
}) => (
  <div className="grid gap-6 @4xl:grid-cols-3" id={id}>
    {channels.map((channel) => (
      <ChannelPanel channel={channel} history={history} key={channel.channel} />
    ))}
  </div>
);

/** How many changes the history lists: the latest. */
const historyShown = 20;

/** Every change of a channel's release, the newest first, as the audit log keeps it. */
export const PromotionHistory = ({
  history,
}: {
  history: readonly PromotionEvent[];
}) => (
  <Section
    description="Every change of a channel's release, the newest first. Edge's come by themselves as releases are imported."
    title="Promotions"
  >
    {history.length === 0 ? (
      <Quiet>No release has gone to a channel yet.</Quiet>
    ) : (
      <ul className="flex flex-col">
        {history.slice(0, historyShown).map((event) => (
          <li
            className="flex items-baseline justify-between gap-4 border-t px-5 py-2"
            key={`${event.at.getTime()}-${event.channel}-${event.releaseId}`}
          >
            <span className="min-w-0">
              {`${channelWords[event.channel]} ${event.back ? "set back" : "set"} to `}
              <span className="font-mono text-xs">{event.releaseId}</span>
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
