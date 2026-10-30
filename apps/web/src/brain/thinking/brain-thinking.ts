import type { Workspace } from "@grasp-os/shared/brain";
import { isFinding } from "@grasp-os/shared/thinking";
import { useLingui } from "@lingui/react/macro";
import { useEffect } from "react";

import { useActiveChat } from "../../chat/active-chat.ts";
import { useFollowedChat } from "../../chat/chat-watch.ts";
import type { Atlas, RegionId } from "../brain-atlas.ts";
import type { Brain } from "../brain.ts";
import { putThinkingAway, useThinkingLog } from "./log.ts";
import { liveThinking, parseThink, thinkingIn } from "./play.ts";
import { aboutRegion, samePainTitle } from "./shapes.ts";
import type { Thought } from "./shapes.ts";
import { noteThinking, usePlayedThinking } from "./use-thinking.ts";
import type { PlayedThinking } from "./use-thinking.ts";

// Grasp's thinking in the brain page: played as Grasp answers in the
// brain's chat, the newest question's steps as they come; or played again
// from an answer (`?think=<chat>:<question>`, "See it in the brain"). The
// steps are core's, kept with the answer (`ChatMessage.thinking`).

/** How long after the finding begins its nerve sets off growing. */
const NERVE_AFTER_MS = 900;

/** The thinking as the dive draws it, from where it plays now; none before its first step. */
const thoughtOf = (
  played: PlayedThinking,
  pulled: number
): Thought | undefined => {
  const { figure, beat } = played;
  if (figure === undefined) {
    return undefined;
  }
  return {
    figure,
    text: played.text ?? "",
    going: played.going,
    since: played.began[played.at] ?? 0,
    nerveAt: (played.began[pulled] ?? 0) + NERVE_AFTER_MS,
    ...(beat === undefined
      ? {}
      : {
          beat: {
            lit: beat.lit,
            ...(beat.thread === undefined ? {} : { thread: beat.thread }),
            since: beat.since,
          },
        }),
  };
};

/** Grasp's thinking as the brain page shows it. */
export interface BrainThinking {
  thought?: Thought;
  /** What the picture is of, and the part of the brain it is about, where the way back leads. */
  title?: string;
  about?: RegionId;
  /** The links what was found taught the brain, for the tab: new nerves between the teams that said the same. */
  learned: [string, string][];
  /** The person leaves the picture: what it found grows in. */
  putAway: () => void;
}

/** Grasp's thinking in the brain page, as the brain's chat plays it or `think` plays it again. */
export const useBrainThinking = ({
  ws,
  brain,
  atlas,
  think,
  still,
}: {
  ws: Workspace;
  brain: Brain;
  atlas: Atlas;
  think: string | undefined;
  still: boolean;
}): BrainThinking => {
  const { i18n } = useLingui();
  const replay = parseThink(think);
  const brainChat = useActiveChat("brain");
  const { view } = useFollowedChat(replay?.chatId ?? brainChat);
  const log = useThinkingLog();
  const { messages, running } = view;
  useEffect(() => {
    noteThinking(messages, running, ws);
  }, [messages, running, ws]);
  const live =
    replay === undefined
      ? liveThinking(messages, log.arrived, log.putAway, running)
      : undefined;
  const again =
    replay === undefined
      ? undefined
      : thinkingIn(messages).find(
          ({ questionId }) => questionId === replay.questionId
        );
  const steps = again?.steps ?? live?.steps ?? [];
  let key: string | undefined;
  if (steps.length > 0) {
    key = again === undefined ? `live:${live?.questionId}` : `again:${think}`;
  }
  const played = usePlayedThinking(key, steps, {
    ws,
    brain,
    atlas,
    still,
    ...(live === undefined ? {} : { arrivals: live.arrivals, open: live.open }),
    i18n,
  });
  const thought = thoughtOf(
    played,
    steps.findIndex((each) => isFinding(each))
  );
  const learned = log.learned.map(({ from, to }): [string, string] => [
    from,
    to,
  ]);
  const about = key === undefined ? undefined : aboutRegion(steps, atlas);
  return {
    ...(thought === undefined ? {} : { thought }),
    ...(key === undefined ? {} : { title: i18n._(samePainTitle) }),
    ...(about === undefined ? {} : { about }),
    learned,
    putAway: () => {
      if (live !== undefined) {
        putThinkingAway(live.questionId, live.calls);
      }
    },
  };
};
