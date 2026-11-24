import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { AgentFigure } from "../../agents/figure/agent-figure.tsx";
import type { AgentFigureSize } from "../../agents/figure/agent-figure.tsx";
import type { FigureState } from "../../agents/figure/body.ts";
import { stephensLook } from "../../agents/figure/look.ts";
import { useVoice } from "../../voice/voice.ts";

// Stephen as the platform draws its agents: his own dithered figure, the
// orb with one eye (agents/figure, from the agents on Damsko), never the
// old dotted head. The interviewer is the company's first agent, so he
// looks here as he does everywhere else in Grasp.

const styles = stylex.create({
  mark: { display: "flex", alignItems: "center", gap: space[2] },
});

export const interviewer = "Stephen";

/** Stephen, quietly: his figure at a list's size, still, and his name. */
export const StephenMark = () => (
  <div {...stylex.props(styles.mark)}>
    <AgentFigure look={stephensLook} size="xs" />
    <Text as="span" color="muted" size="sm" weight="medium">
      {interviewer}
    </Text>
  </div>
);

/**
 * Stephen as the one figure the screen is about: alive while he says
 * something, listening once he has asked, thinking while something of his
 * is under way (`busy`).
 */
export const StephenFigure = ({
  size = "lg",
  busy = false,
}: {
  size?: AgentFigureSize;
  busy?: boolean;
}) => {
  const { line } = useVoice();
  let state: FigureState = line === null ? "listening" : "idle";
  if (busy) {
    state = "thinking";
  }
  return <AgentFigure look={stephensLook} size={size} state={state} />;
};
