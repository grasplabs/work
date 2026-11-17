import type { ChatMention, ChatMentionKind } from "@grasp-os/shared/chat";
import type { PromptMentionKind } from "@grasp-os/ui/components/prompt-editor";
import { useLingui } from "@lingui/react/macro";
import {
  AppWindowIcon,
  SquareSlashIcon,
  UserIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  ComposerKind,
  ComposerMentionItem,
} from "../grasp/composer/index.ts";
import { AppWindow, Person, Workflow } from "../grasp/icons/index.ts";
import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// What a question can mention, typed after `@` in the box to ask in or
// picked from its + menu (Grasp UI's Composer): the organization's Apps,
// workflows and people, each kind with its icon and its hue. A mention is
// a chip in the text, and goes with the question by its ID
// (`ChatQuestion.mentions`), so core tells the agent exactly which. The
// commands a question can run (`/`, to come) are a kind of their own.

/** Something a question can mention: an App, a workflow or someone, by ID, with its name. */
export interface Mentionable {
  kind: ChatMentionKind;
  id: string;
  label: string;
  description?: string | undefined;
}

/** Every kind a chip can be: what a question mentions, and a command. */
type ChipKind = ChatMentionKind | "command";

/**
 * How each kind shows as a chip on the subject bar (subject-bar.tsx), the
 * one place left on the kit's chips: the box is Grasp UI's Composer.
 */
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
export const useMentionables = (
  /** Whether this box mentions at all: a guest's never asks core. */
  wanted: boolean
): readonly Mentionable[] | undefined => {
  const core = useCore();
  const [read, setRead] = useState<readonly Mentionable[]>();
  useEffect(() => {
    const left = new AbortController();
    if (!wanted) {
      return () => {
        left.abort();
      };
    }
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
        ...(apps.state === "ready" ? apps.data : []).map(
          ({ id, name }): Mentionable => ({ kind: "app", id, label: name })
        ),
        ...(workflows.state === "ready" ? workflows.data : []).map(
          ({ id, name }): Mentionable => ({ kind: "workflow", id, label: name })
        ),
        ...(people.state === "ready" ? people.data : []).map(
          ({ id, name, role }): Mentionable => ({
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
  }, [core, wanted]);
  return read;
};

/** The mentions in the box that go with the question: an App, a workflow or a person, by ID. */
export const chatMentionsOf = (
  mentions: readonly Mentionable[]
): ChatMention[] => mentions.map(({ kind, id }) => ({ kind, id }));

/** A mark that `@` some name may run on into: "@Ann" is not in "@Anna". */
const nameGoesOn = /^[\p{L}\p{M}\p{N}_]/u;

/** Whether `text` mentions `label`: its `@name`, whole, not the start of a longer name. */
export const mentionedIn = (text: string, label: string): boolean => {
  const token = `@${label}`;
  let at = text.indexOf(token);
  while (at !== -1) {
    if (!nameGoesOn.test(text.slice(at + token.length))) {
      return true;
    }
    at = text.indexOf(token, at + 1);
  }
  return false;
};

/** What Grasp UI's Composer needs to mention an App, a workflow or someone. */
export interface ComposerMentions {
  kinds: ComposerKind[];
  items: ComposerMentionItem[];
  loading: boolean;
  onMention: (item: ComposerMentionItem) => void;
  /** Keeps only the mentions whose `@name` the text still holds. */
  onText: (text: string) => void;
}

/**
 * Mentions for Grasp UI's Composer: the kinds and what can be mentioned,
 * as core lists them, and the mentions of what is typed (`mentions`), kept
 * as they are picked. The Composer writes a pick into the text as `@name`
 * and tints it as a chip; a mention whose `@name` is gone from the text is
 * gone from the question too.
 */
export const useComposerMentions = (
  mentions: readonly Mentionable[],
  /** Keeps the mentions; without it, the box mentions nothing. */
  onMentions: ((mentions: readonly Mentionable[]) => void) | undefined
): ComposerMentions | undefined => {
  const { t } = useLingui();
  const mentionables = useMentionables(onMentions !== undefined);
  const kinds: ComposerKind[] = [
    { value: "app", label: t`Apps`, icon: AppWindow },
    { value: "workflow", label: t`Workflows`, icon: Workflow },
    { value: "person", label: t`People`, icon: Person },
  ];
  if (onMentions === undefined) {
    return undefined;
  }
  return {
    kinds,
    items: (mentionables ?? []).map(({ kind, id, label, description }) => ({
      value: `${kind}:${id}`,
      label,
      kind,
      description,
    })),
    loading: mentionables === undefined,
    onMention: (item) => {
      const picked = (mentionables ?? []).find(
        ({ kind, id }) => `${kind}:${id}` === item.value
      );
      if (
        picked !== undefined &&
        !mentions.some(
          ({ kind, id }) => kind === picked.kind && id === picked.id
        )
      ) {
        onMentions([...mentions, picked]);
      }
    },
    onText: (text) => {
      const kept = mentions.filter(({ label }) => mentionedIn(text, label));
      if (kept.length !== mentions.length) {
        onMentions(kept);
      }
    },
  };
};
