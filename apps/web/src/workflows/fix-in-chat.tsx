import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A failed run's way to a fix: a new chat that asks the agent to fix it
// (`chats.fixRun`), from the runs log and from notifications.

/**
 * Starts a chat that asks the agent to fix `run`, and opens it. A chat
 * made whose question was refused is offered to open, with why, instead
 * of the button: asking again would make another.
 */
export const AskToFix = ({
  run,
  model,
  inLog = false,
}: {
  run: string;
  model: string;
  /** In the runs log: a small "Fix in chat" beside the run's result. */
  inLog?: boolean;
}) => {
  const navigate = useNavigate();
  const { busy, failure, run: act } = useCoreAction();
  const [refused, setRefused] = useState<{ chat: string; reason: string }>();
  const { t } = useLingui();
  const ask = async (): Promise<void> => {
    const started = await act(
      async (session) => await session.chats.fixRun(run, model)
    );
    if (started === undefined) {
      return;
    }
    if (started.sent) {
      await navigate({ to: "/", search: { chat: started.chat.id } });
      return;
    }
    setRefused({ chat: started.chat.id, reason: started.reason });
  };
  if (refused !== undefined) {
    const { reason } = refused;
    return (
      <div className="flex flex-col gap-1">
        <Link
          className={buttonVariants({
            size: inLog ? "xs" : "sm",
            variant: "outline",
          })}
          search={{ chat: refused.chat }}
          to="/"
        >
          <Trans>Open the chat</Trans>
        </Link>
        <ErrorText>{t`The agent wasn't asked: ${reason}`}</ErrorText>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        disabled={busy}
        onClick={() => {
          void ask();
        }}
        size={inLog ? "xs" : "sm"}
        variant={inLog ? "outline" : "default"}
      >
        {inLog ? (
          <Trans>Fix in chat</Trans>
        ) : (
          <Trans>Ask the agent to fix</Trans>
        )}
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
