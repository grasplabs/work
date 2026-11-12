import type { ChatSavedMemory } from "@grasp-os/shared/brain-memories";
import { Badge } from "@grasp-os/ui/components/badge";
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
 * What Grasp saved, in one whole sentence per case: its statement, who or
 * what it is about when it isn't the person, and the value it holds when
 * it has one.
 */
const SavedText = ({
  saved: { statement, about, value },
}: {
  saved: ChatSavedMemory;
}) => {
  if (about === undefined) {
    return value === undefined ? (
      <Trans>Grasp will remember: {statement}</Trans>
    ) : (
      <Trans>
        Grasp will remember: {statement} (value: {value})
      </Trans>
    );
  }
  return value === undefined ? (
    <Trans>
      Grasp will remember about {about}: {statement}
    </Trans>
  ) : (
    <Trans>
      Grasp will remember about {about}: {statement} (value: {value})
    </Trans>
  );
};

/** Whether it says how Grasp should act for the person, and which way. */
const SavedKind = ({ type }: Pick<ChatSavedMemory, "type">) => {
  if (type === "instruction") {
    return (
      <Badge variant="outline">
        <Trans>Instruction</Trans>
      </Badge>
    );
  }
  if (type === "preference") {
    return (
      <Badge variant="outline">
        <Trans>Preference</Trans>
      </Badge>
    );
  }
  return null;
};

/**
 * Under a call of `remember`: what Grasp saved of what the person said,
 * as the store keeps it (its statement, who or what it is about when it
 * isn't them, its value, and whether it says how Grasp should act for
 * them), and a way to undo it, which retires the memory (core's
 * `session.brainMemories.forget`). One that was undone already, here or
 * elsewhere, is undone as well.
 */
export const SavedMemoryLine = ({ saved }: { saved: ChatSavedMemory }) => {
  const { busy, failure, run } = useCoreAction();
  const [undone, setUndone] = useState(false);
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
            <SavedKind type={saved.type} /> <SavedText saved={saved} />{" "}
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
