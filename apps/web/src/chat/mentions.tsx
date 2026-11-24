import { chatMentionKinds } from "@grasp-os/shared/chat";
import type { ChatMention, ChatMentionKind } from "@grasp-os/shared/chat";
import type {
  PromptInputMentionData,
  PromptInputMentionTrigger,
  PromptInputProps,
} from "@grasp-os/ui/components/prompt-input";
import {
  CircleUserIcon,
  LayoutGridIcon,
  UserSparklesIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// What a question can mention, typed after `@` in the box to ask in: the
// agents the person may ask, each of which then answers the question in
// turn, and the organization's Apps, workflows and people, each kind with
// its mark. Damsko's PromptInputMention keeps the menu, the search and the
// keys and makes a pick a token in the text; Grasp gives it the kinds and
// the things of each. A mention goes with the question by its ID
// (`ChatQuestion.mentions`), so core tells the agent exactly which.

/** What the box holds: its words and its mention tokens, in order. */
export type BoxValue = NonNullable<PromptInputProps["value"]>;

type BoxToken = Exclude<BoxValue[number], string>;

/** A mention in the box: what it names, how it reads, and the character it was typed after. */
export interface BoxMention {
  kind: string;
  id: string;
  label: string;
  trigger: string;
}

/** Something a question can mention, as core lists it. */
export interface Mentionable {
  kind: ChatMentionKind;
  id: string;
  label: string;
  description?: string;
}

/** How each kind shows: its name in the menu and its mark, in this order. */
export const useMentionKinds = (): Record<
  ChatMentionKind,
  { label: string; icon: IconData }
> => {
  const { t } = useLingui();
  return {
    agent: { label: t`Agents`, icon: UserSparklesIcon },
    app: { label: t`Apps`, icon: LayoutGridIcon },
    workflow: { label: t`Workflows`, icon: WorkflowIcon },
    person: { label: t`People`, icon: CircleUserIcon },
  };
};

/**
 * What can be mentioned, as core lists it for the person: the agents they
 * may ask, their Apps, workflows and the organization's people (by role,
 * for an admin), read once the box is shown; none before. A kind core
 * refused or couldn't read is left out.
 */
export const useMentionables = (): readonly Mentionable[] | undefined => {
  const core = useCore();
  const [read, setRead] = useState<readonly Mentionable[]>();
  useEffect(() => {
    const left = new AbortController();
    const readNow = async (): Promise<void> => {
      const [agents, apps, workflows, people] = await Promise.all([
        loadFromCore(
          core,
          async (session) => await session.chats.agents(),
          left.signal
        ),
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
        // The agents they may ask: one mentioned answers the question.
        ...(agents.state === "ready" ? agents.data : []).map(
          ({ id, name, job }): Mentionable => ({
            kind: "agent",
            id,
            label: name,
            ...(job === "" ? {} : { description: job }),
          })
        ),
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
            ...(role === undefined ? {} : { description: roleLabel(role) }),
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
  mentionables: readonly Mentionable[],
  query: string
): Mentionable[] => {
  const wanted = query.trim().toLocaleLowerCase();
  return mentionables.filter(({ label }) =>
    label.toLocaleLowerCase().includes(wanted)
  );
};

/** The kinds `@` offers, in this order: who answers first, then what and whom to name. */
const offeredKinds: readonly ChatMentionKind[] = [
  "agent",
  "app",
  "workflow",
  "person",
];

const isMentionKind = (kind: string): kind is ChatMentionKind =>
  chatMentionKinds.some((each) => each === kind);

/** A token's value: its kind and its ID, as one. */
const valueOf = ({ kind, id }: Pick<Mentionable, "kind" | "id">): string =>
  `${kind}:${id}`;

/**
 * `@`, which offers the kinds first and searches every kind as the person
 * types after it; the things of a kind once one is picked.
 */
export const useMentionTriggers = (
  mentionables: readonly Mentionable[] | undefined
): PromptInputMentionTrigger[] => {
  const { t } = useLingui();
  const kinds = useMentionKinds();
  const itemOf = (mentionable: Mentionable): PromptInputMentionData => ({
    value: valueOf(mentionable),
    label: mentionable.label,
    icon: kinds[mentionable.kind].icon,
    group: kinds[mentionable.kind].label,
    ...(mentionable.description === undefined
      ? {}
      : { description: mentionable.description }),
  });
  return [
    {
      char: "@",
      type: "mention",
      description: t`mention`,
      kinds: offeredKinds.map((kind) => ({
        value: kind,
        label: kinds[kind].label,
        icon: kinds[kind].icon,
      })),
      items: (query, { kind }) =>
        matching(mentionables ?? [], query)
          .filter((each) => kind === undefined || each.kind === kind)
          .map(itemOf),
    },
  ];
};

const isToken = (segment: BoxValue[number]): segment is BoxToken =>
  typeof segment !== "string";

/** The mentions in the box, in order: each token, by its kind and ID. */
export const mentionsOf = (value: BoxValue): BoxMention[] =>
  value.filter(isToken).flatMap((token) => {
    const at = token.value.indexOf(":");
    if (at === -1) {
      return [];
    }
    return [
      {
        kind: token.value.slice(0, at),
        id: token.value.slice(at + 1),
        label: token.label,
        trigger: "@",
      },
    ];
  });

/** What the box says, as it is sent: its words, each mention as `@` and its name. */
export const textOf = (value: BoxValue): string =>
  value
    .map((segment) =>
      typeof segment === "string" ? segment : `@${segment.label}`
    )
    .join("");

/** The mentions in the box that go with the question: an agent, an App, a workflow or a person, by ID. */
export const chatMentionsOf = (
  mentions: readonly BoxMention[]
): ChatMention[] =>
  mentions.flatMap(({ kind, id }) =>
    isMentionKind(kind) ? [{ kind, id }] : []
  );
