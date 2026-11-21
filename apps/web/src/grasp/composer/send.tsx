"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";

import { Button } from "../button";
import { ArrowUp, Stop } from "../icons";
import { cornerStyles } from "./corner";

interface SendProps {
  working: boolean;
  empty: boolean;
  disabled: boolean;
  onSend: () => Promise<void>;
  onStop?: () => unknown;
  sendLabel: string;
  stopLabel: string;
}

/** Send, or Stop while working. */
const SendOrStop = ({
  working,
  empty,
  disabled,
  onSend,
  onStop,
  sendLabel,
  stopLabel,
}: SendProps) => {
  if (working) {
    return (
      <PressPrimitive
        onClick={() => onStop?.()}
        disabled={disabled}
        pendingAnnouncement=""
        render={(props: Record<string, unknown>) => (
          <Button
            {...props}
            data-slot="composer-stop"
            variant="ink"
            size="sm"
            icon={Stop}
            aria-label={stopLabel}
            disabled={disabled}
          />
        )}
      />
    );
  }
  const off = empty || disabled;
  return (
    <PressPrimitive
      onClick={onSend}
      disabled={off}
      pendingAnnouncement=""
      render={(props: Record<string, unknown>) => (
        <Button
          {...props}
          data-slot="composer-send"
          variant={off ? "ghost" : "ink"}
          size="sm"
          icon={ArrowUp}
          aria-label={sendLabel}
          disabled={off}
        />
      )}
    />
  );
};

/** Send, or Stop while working, in its corner's nest: last in the row, it nests in the card's corner (corner.ts). */
export const ComposerSend = (props: SendProps) => (
  <span {...stylex.props(cornerStyles.nest)}>
    <SendOrStop {...props} />
  </span>
);
