import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";

import { SIGN_PITCH, signFigure } from "../chat/sign-figures.ts";

// Stephen's picture beside his name in Settings, as the prototype's
// `components/stephen/stephen-avatar.tsx`: the chat's own dotted head,
// still, in a round tile. No new character: the head people met in their
// interview.

/** Stephen's dotted head, still, in an avatar's round tile. */
export const StephenAvatar = () => (
  <Avatar aria-hidden="true" size="lg">
    <AvatarFallback>
      <svg className="text-foreground size-4/5" viewBox="-1.12 -1.12 2.24 2.24">
        {signFigure("head").map((dot) => (
          <circle
            cx={dot.x}
            cy={-dot.y}
            fill="currentColor"
            key={`${dot.x}:${dot.y}`}
            opacity={0.3 + 0.7 * dot.ink}
            r={SIGN_PITCH * (0.2 + 0.24 * dot.ink)}
          />
        ))}
      </svg>
    </AvatarFallback>
  </Avatar>
);
