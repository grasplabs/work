import type { ChatSavedMemory } from "@grasp-os/shared/brain-memories";
import { Button } from "@grasp-os/ui/components/button";
import {
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import { Trans } from "@lingui/react/macro";
import { BrainIcon } from "lucide-react";
import { useState } from "react";

import { useCoreAction } from "../use-core-action.ts";

/**
 * Under a call of `remember`: what Grasp saved of what the person said,
 * in their own words, and who or what it is about when it isn't them,
 * and a way to undo it, which retires the memory
 * (core's `session.brainMemories.forget`). One that was undone already,
 * here or elsewhere, is undone as well.
 */
export const SavedMemoryLine = ({ saved }: { saved: ChatSavedMemory }) => {
  const { busy, failure, run } = useCoreAction();
  const [undone, setUndone] = useState(false);
  const { statement, about } = saved;
  const undo = async () => {
    const outcome = await run(
      async (session) => await session.brainMemories.forget(saved.memory)
    );
    if (outcome !== undefined) {
      setUndone(true);
    }
  };
  return (
    <TraceLine wrap>
      <TraceIcon>
        <BrainIcon />
      </TraceIcon>
      <TraceTitle>
        {undone ? (
          <Trans>Grasp no longer remembers this.</Trans>
        ) : (
          <>
            {about === undefined ? (
              <Trans>Grasp will remember: {statement}</Trans>
            ) : (
              <Trans>
                Grasp will remember about {about}: {statement}
              </Trans>
            )}{" "}
            <Button
              disabled={busy}
              onClick={() => {
                void undo();
              }}
              size="xs"
              variant="hint"
            >
              <Trans>Undo</Trans>
            </Button>
          </>
        )}
      </TraceTitle>
      {failure === undefined ? null : (
        <TraceDescription>{failure}</TraceDescription>
      )}
    </TraceLine>
  );
};
