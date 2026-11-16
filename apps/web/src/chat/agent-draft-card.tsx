import type { AgentDrafted } from "@grasp-os/shared/agents";
import type { ChatMessage } from "@grasp-os/shared/chat";
import type { ToolClassAudience } from "@grasp-os/shared/connect";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { classNames } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";
import type { ThreadBuild } from "./build-progress.tsx";

// An agent Grasp's chat drafted for the person (`draftAgent`), in the
// thread: what it would be, in the card's own words, and nothing made
// until they press Make it, which makes it as the card shows it, by the
// Agents page's own checks (`ChatsApi.makeDraftedAgent`), then lands the
// person on its page, the chat going on beside it. Make it and Change something are there only while the draft
// waits for the person; what the model wrote is shown as text.

/** The draft waiting for the person: the latest reply's, while nothing runs and nothing was said since. */
export const pendingAgentDraft = (
  messages: readonly ChatMessage[],
  running: boolean
): AgentDrafted | undefined => {
  if (running) {
    return undefined;
  }
  const last = messages.findLast(({ role }) => role !== "result");
  return last?.role === "assistant" ? last.agentDraft : undefined;
};

/** Who may ask it, as the card says it. */
const AudienceWords = ({
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
  const count = audience.teams.length;
  return <Trans>People in {count} chosen teams</Trans>;
};

/** One line of the card: what it says, and of what. */
const Line = ({ label, children }: { label: string; children: ReactNode }) => (
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
  const { name, job, instructions, whose, classes = [], schedule } = draft;
  const company = whose === "company";
  return (
    <Card aria-label={t`An agent to make: ${name}`} render={<section />}>
      <CardHeader>
        <CardTitle>
          <h2 className="type-display">{name}</h2>
        </CardTitle>
        <CardDescription>
          <Trans>
            Nothing is made until you say Make it. You can change any of it
            first.
          </Trans>
        </CardDescription>
      </CardHeader>
      <CardContent>
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
              {schedule.opening}
            </Line>
          )}
          <Line label={t`Its instructions`}>
            <span className="line-clamp-6 whitespace-pre-wrap">
              {instructions}
            </span>
          </Line>
        </dl>
      </CardContent>
      {actions === undefined ? null : <CardFooter>{actions}</CardFooter>}
    </Card>
  );
};

/** Make it, which lands the person on the agent made, and Change something. */
const DraftActions = ({
  chatId,
  draft,
  build,
}: {
  chatId: string;
  draft: AgentDrafted;
  build: ThreadBuild;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const { model, effort } = build;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || model === undefined}
          onClick={() => {
            if (model === undefined) {
              return;
            }
            void (async () => {
              const agent = await run(
                async (session) =>
                  await session.chats.makeDraftedAgent(chatId, {
                    draft: draft.callId,
                    text: t`Make it`,
                    model,
                    ...(effort === undefined ? {} : { effort }),
                  })
              );
              if (agent !== undefined) {
                void navigate({
                  to: "/agents/$agent",
                  params: { agent: agent.id },
                });
              }
            })();
          }}
          variant="highlight"
        >
          <Trans>Make it</Trans>
        </Button>
        <Button
          onClick={() => {
            build.onChangePlan();
          }}
          variant="outline"
        >
          <Trans>Change something</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
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
        <DraftActions build={build} chatId={chatId} draft={draft} />
      ) : undefined
    }
    draft={draft}
  />
);
