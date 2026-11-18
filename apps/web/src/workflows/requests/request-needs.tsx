import { needStatuses } from "@grasp-os/shared/stephen-requests";
import type {
  MissingReason,
  Need,
  NeedStatus,
} from "@grasp-os/shared/stephen-requests";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouteContext } from "@tanstack/react-router";
import { useState } from "react";

import { setActiveChat } from "../../chat/active-chat.ts";
import { openChat } from "../../chat/chat-layout.ts";
import { readChoice, resolveChoice } from "../../chat/model-choice.ts";
import type { Session } from "../../core.ts";
import { formatDay, formatNumber, formatPercent } from "../../format.ts";
import { Alert } from "../../grasp/alert/index.ts";
import { Button } from "../../grasp/button/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../grasp/dropdown-menu/index.ts";
import { Icon, People, ThumbsDown, Tool } from "../../grasp/icons/index.ts";
import type { IconData } from "../../grasp/icons/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../../use-core-action.ts";
import { ToolMark, toolIcon } from "./request-parts.tsx";

// Needs you, as the prototype's `request-needs.tsx`: what five or more
// people asked that he cannot do yet, questions whose answers are rated
// down, what he did not know, and teams that have hardly found him. Each
// with why, Grasp's proposal (core's, through the model gateway), where
// the company stands on it and, once fixed, what the fix did since. "Do
// it" asks Grasp in the corner chat and marks it as being worked on.

export const statusLabels = {
  working: msg`Working on it`,
  fixed: msg`Fixed`,
  leftAsIs: msg`Leave as it is`,
} as const satisfies Record<NeedStatus, MessageDescriptor>;

/** The app a tool is in: what comes before its action. */
const appOf = (tool: string): string => tool.split(".")[0] ?? tool;

/** The action a tool does: what comes after its app. */
const actionOf = (tool: string): string =>
  tool.split(".").slice(1).join(".") || tool;

/** Why a need waits on someone, in one line. */
export const useNeedWhy = (need: Need): string => {
  const { t } = useLingui();
  if (need.kind === "notPossible") {
    const [first] = need.missing;
    if (first === undefined) {
      return t`He can't do it yet`;
    }
    const app = appOf(first.id);
    const action = actionOf(first.id);
    const reasons: Record<MissingReason, string> = {
      appOff: t`${app} is off`,
      actionOff: t`Off in ${app}`,
      workflowClosed: t`The workflow isn't open to him`,
      noApp: t`No app for it yet`,
      noAction: t`“${action}” doesn't exist yet`,
    };
    return reasons[first.why];
  }
  if (need.kind === "poorAnswer") {
    const rated = (need.thumbs?.up ?? 0) + (need.thumbs?.down ?? 0);
    const share = formatPercent(
      rated === 0 ? 0 : (need.thumbs?.down ?? 0) / rated
    );
    return t`${share} not helpful`;
  }
  if (need.kind === "unanswered") {
    const { role } = need;
    return role === null ? t`He didn't know` : t`${role} knows`;
  }
  const reach = formatNumber(need.reach ?? 0);
  const count = formatNumber(need.people ?? 0);
  return need.people === null
    ? t`Fewer than five of ${reach} asked him`
    : t`${count} of ${reach} asked him`;
};

/** Where a need stands, in one line, and for one fixed what the fix did since; null while open. */
export const useNeedState = (need: Need): string | null => {
  const { t } = useLingui();
  if (need.status === null) {
    return null;
  }
  const date = formatDay(need.status.at.slice(0, 10));
  if (need.status.status === "working") {
    return t`Working on it since ${date}`;
  }
  if (need.status.status === "leftAsIs") {
    return t`Left as it is since ${date}`;
  }
  const { since } = need;
  if (since === null || since.requests === 0) {
    return t`Fixed on ${date}`;
  }
  if (need.kind === "quietTeam") {
    const { people } = since;
    return people === null
      ? t`Fixed on ${date}`
      : t`Fixed on ${date} · ${people} asked him since`;
  }
  if (need.kind === "poorAnswer") {
    const rated = since.up + since.down;
    const up = formatPercent(rated === 0 ? 0 : since.up / rated);
    return rated === 0
      ? t`Fixed on ${date}`
      : t`Fixed on ${date} · ${up} helpful since`;
  }
  const done = formatNumber(since.done);
  const asked = formatNumber(since.requests);
  return t`Fixed on ${date} · ${done} of ${asked} done since`;
};

/** The tool a need would take: the brain for what he didn't know, else the first missing one. */
const toolOf = (need: Need): string | undefined =>
  need.kind === "unanswered" ? "brain" : need.missing[0]?.id;

/** A need's mark as an icon, for a row or a panel's head that takes one. */
export const needIcon = (need: Need): IconData => {
  if (need.kind === "poorAnswer") {
    return ThumbsDown;
  }
  if (need.kind === "quietTeam") {
    return People;
  }
  const tool = toolOf(need);
  return tool === undefined ? Tool : toolIcon(tool);
};

/** A need's mark: the tool it would take, a thumb down, the brain, or a team. */
export const NeedMark = ({ need }: { need: Need }) => {
  const { t } = useLingui();
  if (need.kind === "poorAnswer") {
    return <Icon icon={ThumbsDown} label={t`Rated down`} />;
  }
  if (need.kind === "quietTeam") {
    return <Icon icon={People} label={t`A team`} />;
  }
  const tool = toolOf(need);
  return tool === undefined ? null : (
    <ToolMark label={appOf(tool)} tool={tool} />
  );
};

/**
 * Asks Grasp, in a new chat in the corner, what `prompt` says, with the
 * model and effort `userId` last chose; null, making no chat, when no
 * model is set up to ask with.
 */
const askGrasp = async (
  session: Session,
  userId: string,
  title: string,
  prompt: string
): Promise<string | null> => {
  const [models, efforts] = await Promise.all([
    session.chats.models(),
    session.chats.efforts(),
  ]);
  if (models.length === 0) {
    return null;
  }
  const { model, effort } = resolveChoice(models, efforts, readChoice(userId));
  const chat = await session.chats.create(title);
  await session.chats.send(chat.id, {
    text: prompt,
    model,
    ...(effort === undefined ? {} : { effort }),
  });
  return chat.id;
};

/**
 * Asks Grasp in the corner chat, in a chat of its own named `title`, and
 * opens it; resolves whether it was asked.
 */
export const useAskGrasp = () => {
  const { t } = useLingui();
  const { identity } = useRouteContext({ from: "/_shell" });
  const { busy, failure, run } = useCoreAction();
  const [noModel, setNoModel] = useState(false);
  const ask = async (title: string, prompt: string): Promise<boolean> => {
    setNoModel(false);
    const chatId = await run(
      async (session) => await askGrasp(session, identity.userId, title, prompt)
    );
    if (chatId === null) {
      setNoModel(true);
      return false;
    }
    if (chatId === undefined) {
      return false;
    }
    setActiveChat(chatId);
    openChat();
    return true;
  };
  return {
    busy,
    failure:
      failure ??
      (noModel ? t`No model is set up for this deployment yet.` : undefined),
    ask,
  };
};

const styles = stylex.create({
  why: { display: "flex", alignItems: "center", gap: grasp.space2 },
  words: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
  },
  actions: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  buttons: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
});

/** Why it waits and where it stands, in a section's card of a need's panel. */
export const NeedWhy = ({ need }: { need: Need }) => {
  const why = useNeedWhy(need);
  const state = useNeedState(need);
  return (
    <div {...stylex.props(styles.words)}>
      <span {...stylex.props(styles.why)}>
        <NeedMark need={need} />
        <Text element="span" size="sm">
          {why}
        </Text>
      </span>
      {state === null ? null : (
        <Text size="sm" tone="muted">
          {state}
        </Text>
      )}
    </div>
  );
};

/** What Grasp proposes for a need, or that it is still working one out; null when it has none or there is no need. */
export const useNeedProposal = (need: Need | null): string | null => {
  const { t } = useLingui();
  if (need === null) {
    return null;
  }
  if (need.proposal !== null) {
    return need.proposal;
  }
  return need.proposing ? t`Grasp is still working out a proposal.` : null;
};

/**
 * The foot of a need's panel: do what Grasp proposes, in the corner chat,
 * which marks it as being worked on; and for owners, where it stands.
 */
export const NeedActions = ({
  need,
  canManage,
  onChanged,
}: {
  need: Need;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) => {
  const { t, i18n } = useLingui();
  const why = useNeedWhy(need);
  const { busy, failure, run } = useCoreAction();
  const asking = useAskGrasp();
  const current = need.status?.status ?? null;
  const mark = async (status: NeedStatus | null): Promise<void> => {
    await run(async (session) => {
      await session.stephenRequests.setNeedStatus(need.key, status);
    });
    await onChanged();
  };
  const { label } = need;
  const proposal = need.proposal ?? why;
  const doIt = async (): Promise<void> => {
    const asked = await asking.ask(
      label,
      t`For Stephen's requests, about “${label}” (${why}), do this: ${proposal}`
    );
    if (asked && canManage && current === null) {
      await mark("working");
    }
  };
  const failed = failure ?? asking.failure;
  return (
    <div {...stylex.props(styles.actions)}>
      <div {...stylex.props(styles.buttons)}>
        <Button
          disabled={busy || asking.busy}
          onClick={() => {
            void doIt();
          }}
          size="sm"
          variant="ink"
        >
          {t`Do it`}
        </Button>
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger disabled={busy} size="sm" variant="quiet">
              {current === null ? t`Mark as` : i18n._(statusLabels[current])}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {needStatuses
                .filter((status) => status !== current)
                .map((status) => (
                  <DropdownMenuItem
                    key={status}
                    onSelect={() => {
                      void mark(status);
                    }}
                  >
                    {i18n._(statusLabels[status])}
                  </DropdownMenuItem>
                ))}
              {current === null ? null : (
                <DropdownMenuItem
                  onSelect={() => {
                    void mark(null);
                  }}
                >
                  {t`Open again`}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {failed === undefined ? null : <Alert tone="danger">{failed}</Alert>}
    </div>
  );
};
