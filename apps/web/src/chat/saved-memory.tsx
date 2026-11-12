import type {
  BrainMemoryOutcome,
  ChatSavedMemory,
} from "@grasp-os/shared/brain-memories";
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
 * `session.brainMemories.forget`): it never becomes current again, even
 * once a later save replaced it. Said forgotten only when core answers
 * `done` (one undone before, here or elsewhere, too); `nothing` means
 * there was nothing of theirs in use to undo, which pressing again
 * wouldn't change, so it says that instead.
 */
export const SavedMemoryLine = ({ saved }: { saved: ChatSavedMemory }) => {
  const { busy, failure, run } = useCoreAction();
  const [outcome, setOutcome] = useState<BrainMemoryOutcome>();
  const undo = async () => {
    const answered = await run(
      async (session) => await session.brainMemories.forget(saved.memory)
    );
    if (answered !== undefined) {
      setOutcome(answered);
    }
  };
  return (
    <TraceLine wrap>
      <TraceIcon>
        <BrainIcon />
      </TraceIcon>
      <TraceTitle>
        {outcome === "done" ? (
          <Trans>Grasp no longer remembers this.</Trans>
        ) : null}
        {outcome === "nothing" ? (
          <Trans>There was nothing to undo: Grasp no longer uses this.</Trans>
        ) : null}
        {outcome === undefined ? (
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
        ) : null}
      </TraceTitle>
      {failure === undefined ? null : (
        <TraceDescription>{failure}</TraceDescription>
      )}
    </TraceLine>
  );
};
