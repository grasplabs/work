import { chatMentionKinds } from "@grasp-os/shared/chat";
import type { ChatMention, ChatMentionKind } from "@grasp-os/shared/chat";
import type {
  PromptMention,
  PromptMentionKind,
  PromptSuggestion,
  PromptTrigger,
} from "@grasp-os/ui/components/prompt-editor";
import { useLingui } from "@lingui/react/macro";
import {
  AppWindowIcon,
  SquareSlashIcon,
  UserIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// What a question can mention, typed after `@` in the box to ask in or
// picked from its add menu (composer-menu.tsx): the organization's Apps,
// workflows and people, each kind with its icon and its hue. A mention is
// a chip in the text, and goes with the question by its ID
// (`ChatQuestion.mentions`), so core tells the agent exactly which. The
// commands a question can run (`/`, to come) are a kind of their own.

/** Every kind a chip can be: what a question mentions, and a command. */
type ChipKind = ChatMentionKind | "command";

/** How each kind shows, in the dropdown's groups and as a chip, in this order. */
export const useMentionKinds = (): Record<ChipKind, PromptMentionKind> => {
  const { t } = useLingui();
  return {
    app: { label: t`Apps`, icon: <AppWindowIcon />, tone: "app" },
    workflow: {
      label: t`Workflows`,
      icon: <WorkflowIcon />,
      tone: "workflow",
    },
    person: { label: t`People`, icon: <UserIcon />, tone: "person" },
    command: {
      label: t`Commands`,
      icon: <SquareSlashIcon />,
      tone: "command",
    },
  };
};

/**
 * What can be mentioned, as core lists it for the person: their Apps,
 * workflows and the organization's people (by role, for an admin), read once the
 * box is shown; none before. A kind core refused or couldn't read is left
 * out.
 */
export const useMentionables = (): readonly PromptSuggestion[] | undefined => {
  const core = useCore();
  const [read, setRead] = useState<readonly PromptSuggestion[]>();
  useEffect(() => {
    const left = new AbortController();
    const readNow = async (): Promise<void> => {
      const [apps, workflows, people] = await Promise.all([
        loadFromCore(
          core,
          async (session) => await session.apps.list(),
          left.signal
        ),
        loadFromCore(
          core,
          async (session) => await session.workflowResources.list(),
          left.signal
        ),
        loadFromCore(
          core,
          async (session) => await session.chats.people(),
          left.signal
        ),
      ]);
      if (left.signal.aborted) {
        return;
      }
      setRead([
        ...(apps.state === "ready" ? apps.data : []).map(({ id, name }) => ({
          kind: "app",
          id,
          label: name,
        })),
        ...(workflows.state === "ready" ? workflows.data : []).map(
          ({ id, name }) => ({ kind: "workflow", id, label: name })
        ),
        ...(people.state === "ready" ? people.data : []).map(
          ({ id, name, role }) => ({
            kind: "person",
            id,
            label: name,
            description: role === undefined ? undefined : roleLabel(role),
          })
        ),
      ]);
    };
    void readNow();
    return () => {
      left.abort();
    };
  }, [core]);
  return read;
};

/** What of `mentionables` matches `query`: by a word of its name, case aside. */
export const matching = (
  mentionables: readonly PromptSuggestion[],
  query: string
): PromptSuggestion[] => {
  const wanted = query.trim().toLocaleLowerCase();
  return mentionables.filter(({ label }) =>
    label.toLocaleLowerCase().includes(wanted)
  );
};

/** `@`, which lists what can be mentioned as the person types after it. */
export const useMentionTrigger = (
  mentionables: readonly PromptSuggestion[] | undefined
): PromptTrigger => {
  const { t } = useLingui();
  return {
    char: "@",
    suggest: (query) => matching(mentionables ?? [], query),
    empty: mentionables === undefined ? t`Loading…` : t`Nothing found`,
  };
};

const isMentionKind = (kind: string): kind is ChatMentionKind =>
  chatMentionKinds.some((each) => each === kind);

/** The mentions in the box that go with the question: an App, a workflow or a person, by ID. */
export const chatMentionsOf = (
  mentions: readonly PromptMention[]
): ChatMention[] =>
  mentions.flatMap(({ kind, id }) =>
    isMentionKind(kind) ? [{ kind, id }] : []
  );
