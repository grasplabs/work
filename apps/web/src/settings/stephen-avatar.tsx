import { AgentMark } from "../grasp/agent-mark/index.ts";
import type { AgentMarkSize } from "../grasp/agent-mark/index.ts";

// Stephen's face beside his name in Settings: the library's Agent mark,
// as every agent's face is, drawn from his name, so he looks the same
// here as in the agents' list and on his own page. Decorative: his name
// stands beside it.

/** Stephen's Agent mark, beside his name. */
export const StephenAvatar = ({ size = "xs" }: { size?: AgentMarkSize }) => (
  <AgentMark name="Stephen" size={size} />
);
