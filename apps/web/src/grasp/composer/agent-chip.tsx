// The agent a message goes to, when the plus menu (add.tsx) chose one that is not the default: a
// quiet Tag in the row above the text (composer.tsx), its mark and its name, and a remove that goes
// back to the default agent. With the default agent nothing shows, so the card is as it always is.
// The plus menu hands the card its choice through ChosenAgentContext, as a dictation hands it its
// level (ListenContext).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, useContext, useRef } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "../avatar";
import { visuallyHidden } from "../hidden/hidden";
import { Tag } from "../tag";
import type { ComposerAgentOption } from "./agent";
import { useComposerWords } from "./words";

/** The agent shown above the text, the one a remove goes back to, and the remove. */
export interface ComposerChosenAgent {
  agent: ComposerAgentOption;
  fallback: ComposerAgentOption;
  onRemove: () => void;
}

// Lets the plus menu hand the card the agent to show above the text, or none.
export const ChosenAgentContext = createContext<
  ((chosen: ComposerChosenAgent | null) => void) | null
>(null);

export const useShowChosenAgent = () => useContext(ChosenAgentContext);

/** The chip: the chosen agent's mark and name, and a remove that goes back to the default one. */
export const ComposerAgentChip = ({
  chosen,
}: {
  chosen: ComposerChosenAgent;
}) => {
  const words = useComposerWords("agent");
  const room = useRef<HTMLSpanElement | null>(null);
  const { agent } = chosen;
  // A picture stands before the name; an icon is the Tag's own.
  const picture = agent.icon === undefined && agent.avatar !== undefined;
  return (
    <span ref={room} data-slot="composer-agent-chip">
      {/* Said before the name, so the chip reads as the agent: "Agent Research". */}
      <span {...stylex.props(visuallyHidden)}>{`${words.label} `}</span>
      <Tag
        icon={agent.icon}
        removeLabel={words.back(chosen.fallback.label)}
        onRemove={() => {
          // The chip goes with its remove: focus goes on to the text, not to the page.
          const text = room.current
            ?.closest("fieldset")
            ?.querySelector("textarea");
          chosen.onRemove();
          text?.focus();
        }}
      >
        {picture ? (
          <>
            <Avatar decorative name={agent.label} size="2xs">
              {typeof agent.avatar === "string" && (
                <AvatarImage src={agent.avatar} />
              )}
              <AvatarFallback />
            </Avatar>{" "}
            {agent.label}
          </>
        ) : (
          agent.label
        )}
      </Tag>
    </span>
  );
};
