import type { AgentDraftMade, AgentDrafted } from "@grasp-os/shared/agents";
import type { ToolClassAudience } from "@grasp-os/shared/connect";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { classNames } from "../settings/stephen-settings.tsx";
import type { ThreadBuild } from "./build-progress.tsx";
import { MakeActions, MakeCard } from "./make-card.tsx";

// An agent Grasp's chat drafted for the person (`draftAgent`), in the
// thread: what it would be, in the card's own words, and nothing made
// until they press Make it, which makes it as the card shows it, by the
// Agents page's own checks (`ChatsApi.makeDraftedAgent`), then lands the
// person on its page, the chat going on beside it. Make it and Change something are there only while the draft
// waits for the person; what the model wrote is shown as text.

/** The teams a draft names, by name where the company's list is read; else by ID. */
const TeamsWords = ({ teams }: { teams: readonly string[] }) => {
  const key = teams.join(",");
  const read = useCoreRead(
    key,
    async (session) => await session.organization.teams(),
    key
  );
  const names = new Map(
    read?.state === "ready" ? read.data.map(({ id, name }) => [id, name]) : []
  );
  const named = teams.map((id) => names.get(id) ?? id).join(", ");
  return <Trans>People in these teams: {named}</Trans>;
};

/**
 * The apps a card names, each by what it grants: the company's own name
 * for it (Google Workspace for Gmail), beside the model's words for it
 * where they differ, and by the model's words alone while the catalog
 * isn't read.
 */
export const AppNames = ({
  apps,
}: {
  apps: readonly { source: string; provider: string; name: string }[];
}) => {
  const key = apps
    .map(({ source, provider }) => `${source}:${provider}`)
    .join(",");
  const read = useCoreRead(
    key,
    async (session) => await session.connections.catalog(),
    key
  );
  const named = new Map(
    read?.state === "ready"
      ? read.data.entries.map(({ source, id, name }) => [
          `${source}:${id}`,
          name,
        ])
      : []
  );
  return apps
    .map(({ source, provider, name }) => {
      const granted = named.get(`${source}:${provider}`);
      return granted === undefined || granted === name
        ? name
        : `${granted} (${name})`;
    })
    .join(", ");
};

/** Who may ask it, as the card says it. */
export const AudienceWords = ({
  audience,
}: {
  audience: ToolClassAudience | undefined;
}) => {
  if (audience === undefined || audience.who === "nobody") {
    return <Trans>Nobody yet: you say who on its page</Trans>;
  }
  if (audience.who === "everyone") {
    return <Trans>Everyone in the company</Trans>;
  }
  return <TeamsWords teams={audience.teams} />;
};

/** One line of the card: what it says, and of what. */
export const Line = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="text-sm">{children}</dd>
  </div>
);

/** The drafted agent as a card, with `actions` while it waits. */
export const AgentDraftCard = ({
  draft,
  actions,
}: {
  draft: AgentDrafted;
  actions?: ReactNode;
}) => {
  const { t, i18n } = useLingui();
  const {
    name,
    job,
    instructions,
    whose,
    classes = [],
    schedule,
    apps = [],
  } = draft;
  const company = whose === "company";
  return (
    <MakeCard
      actions={actions}
      description={
        <Trans>
          Nothing is made until you say Make it. You can change any of it first.
        </Trans>
      }
      label={t`An agent to make: ${name}`}
      title={name}
    >
      <dl className="flex flex-col gap-3">
        {job === "" ? null : <Line label={t`What it is for`}>{job}</Line>}
        <Line label={t`Whose it is`}>
          {company ? (
            <Trans>One of the company&apos;s agents</Trans>
          ) : (
            <Trans>Yours alone: only you ask it</Trans>
          )}
        </Line>
        {company ? (
          <Line label={t`Who may ask it`}>
            <AudienceWords audience={draft.audience} />
          </Line>
        ) : null}
        <Line label={t`Apps it uses`}>
          {apps.length === 0 ? (
            <Trans>Any app its kinds of work allow</Trans>
          ) : (
            <AppNames apps={apps} />
          )}
        </Line>
        {company ? (
          <Line label={t`What it may do`}>
            {classes.length === 0 ? (
              <Trans>Nothing yet: you turn it on on its page</Trans>
            ) : (
              classes.map((each) => i18n._(classNames[each])).join(", ")
            )}
          </Line>
        ) : null}
        {schedule === undefined ? null : (
          <Line label={t`When it works on its own`}>
            <span className="font-mono text-xs">{schedule.cron}</span>
            {" · "}
            {schedule.timeZone ?? t`the company's time zone`}
            {" · "}
            {schedule.opening}
          </Line>
        )}
        <Line label={t`Its instructions`}>
          {/* All of it, as it will be kept: long ones scroll. */}
          <span className="block max-h-64 overflow-y-auto whitespace-pre-wrap">
            {instructions}
          </span>
        </Line>
      </dl>
    </MakeCard>
  );
};

/** Which press a card waits on: Make it for a drafted agent, Change it for a change. */
export type DraftPress = "make" | "change";

/** Make it or Change it, which lands the person on the agent, and Change something. */
export const DraftActions = ({
  chatId,
  callId,
  press,
  build,
}: {
  chatId: string;
  callId: string;
  press: DraftPress;
  build: ThreadBuild;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  // Made or changed, but not all of the card could be set: it is paused,
  // and its page says what it has.
  const [unfinished, setUnfinished] = useState<string>();
  return (
    <MakeActions
      build={build}
      changeLabel={t`Change something`}
      label={press === "make" ? t`Make it` : t`Change it`}
      notice={
        unfinished === undefined ? null : (
          <p className="text-sm">
            <Trans>
              Not all of it could be set, so the agent is paused.{" "}
              <Link params={{ agent: unfinished }} to="/agents/$agent">
                Finish it on its page
              </Link>
              .
            </Trans>
          </p>
        )
      }
      onDone={(agent: AgentDraftMade) => {
        if (agent.unfinished === true) {
          setUnfinished(agent.id);
          return;
        }
        void navigate({ to: "/agents/$agent", params: { agent: agent.id } });
      }}
      press={async (session, asked) => {
        const draft = { draft: callId, ...asked };
        return press === "make"
          ? await session.chats.makeDraftedAgent(chatId, draft)
          : await session.chats.changeDraftedAgent(chatId, draft);
      }}
    />
  );
};

/**
 * A drafted agent in the thread: its card, and while it waits for the
 * person (`waiting`, and the thread can ask: `build`), Make it.
 */
export const ThreadAgentDraft = ({
  chatId,
  draft,
  waiting,
  build,
}: {
  chatId: string;
  draft: AgentDrafted;
  waiting: boolean;
  build: ThreadBuild | undefined;
}) => (
  <AgentDraftCard
    actions={
      waiting && build !== undefined ? (
        <DraftActions
          build={build}
          callId={draft.callId}
          chatId={chatId}
          press="make"
        />
      ) : undefined
    }
    draft={draft}
  />
);
