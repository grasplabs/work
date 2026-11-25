import type {
  BrainMemoryOutcome,
  ChatSavedMemory,
} from "@grasp-os/shared/brain-memories";
import { Button } from "@grasp-os/ui/components/button";
import {
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import { BrainIcon, Icon } from "@grasp-os/ui/lib/icons";
import { font, size } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

const styles = stylex.create({
  // Undo stands in the line of words without making the line taller, so
  // the words stay level with the line's mark.
  undo: { marginBlock: `calc((${font.textSmLine} - ${size.controlXs}) / 2)` },
});

/** What kind of thing Grasp saved, as the line's title. */
const SavedTitle = ({ type }: Pick<ChatSavedMemory, "type">) => {
  if (type === "instruction") {
    return <Trans>Saved an instruction</Trans>;
  }
  if (type === "preference") {
    return <Trans>Saved a preference</Trans>;
  }
  return <Trans>Saved a memory</Trans>;
};

/** Its statement, and who or what it is about when it isn't the person. */
const SavedText = ({
  saved: { statement, about },
}: {
  saved: ChatSavedMemory;
}) =>
  about === undefined ? (
    statement
  ) : (
    <Trans>
      About {about}: {statement}
    </Trans>
  );

/** What the earlier memories it replaced said, as one sentence. */
const ReplacedText = ({ statements }: { statements: readonly string[] }) => {
  const replaced = formatList(statements);
  return <Trans>In place of: {replaced}</Trans>;
};

/**
 * Under a call of `remember`: what Grasp saved of what the person said,
 * as the store keeps it (whether it says how Grasp should act for them,
 * its statement, who or what it is about when it isn't them, and what it
 * replaced), and a way to undo it, which brings back what it
 * replaced, which retires the memory (core's
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
    <Trace>
      <TraceLine status={failure === undefined ? undefined : "error"}>
        <TraceIcon>
          <Icon icon={BrainIcon} />
        </TraceIcon>
        <TraceTitle>
          {outcome === "done" ? (
            <Trans>Grasp no longer remembers this.</Trans>
          ) : null}
          {outcome === "nothing" ? (
            <Trans>There was nothing to undo: Grasp no longer uses this.</Trans>
          ) : null}
          {outcome === undefined ? <SavedTitle type={saved.type} /> : null}
        </TraceTitle>
        {outcome === undefined ? (
          <TraceDescription>
            <SavedText saved={saved} />
          </TraceDescription>
        ) : null}
        {outcome === undefined && saved.replaced !== undefined ? (
          <TraceDescription>
            <ReplacedText statements={saved.replaced} />
          </TraceDescription>
        ) : null}
        {failure === undefined ? null : (
          <TraceDescription>{failure}</TraceDescription>
        )}
        {outcome === undefined ? (
          <Button
            disabled={busy}
            onClick={undo}
            size="xs"
            style={styles.undo}
            variant="ghost"
          >
            <Trans>Undo</Trans>
          </Button>
        ) : null}
      </TraceLine>
    </Trace>
  );
};
