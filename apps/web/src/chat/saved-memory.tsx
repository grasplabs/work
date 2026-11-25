import type {
  BrainMemoryOutcome,
  ChatSavedMemory,
} from "@grasp-os/shared/brain-memories";
import { Button } from "@grasp-os/ui/components/button";
import { Text } from "@grasp-os/ui/components/text";
import {
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import { BrainIcon, Icon } from "@grasp-os/ui/lib/icons";
import { font, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { announce } from "@grasp-os/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

const styles = stylex.create({
  // Undo stands in the line of words without making it taller, so the
  // words stay level with the line's mark in every state; a step after
  // the statement, so its focus ring stays clear of the last letter.
  undo: {
    marginBlock: `calc((${font.textSmLine} - ${size.controlXs}) / 2)`,
    marginInlineStart: space["1"],
  },
  // A note on a row of its own, under the words, where they start.
  below: { flexBasis: "100%" },
});

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

/** What the earlier memories it replaced said: in their place while it is saved, back once it is undone. */
const ReplacedText = ({
  statements,
  restored,
}: {
  statements: readonly string[];
  restored: boolean;
}) => {
  const replaced = formatList(statements);
  return restored ? (
    <Trans>Restored: {replaced}</Trans>
  ) : (
    <Trans>In place of: {replaced}</Trans>
  );
};

/**
 * Under a call of `remember`, one step of the answer: that Grasp saved
 * something to memory (quiet), what it saved in the person's own words
 * (the reading ink, under the words before it when too long for their
 * line), and Undo after it. Undo retires the memory (core's
 * `session.brainMemories.forget`): it never becomes current again, and
 * what it replaced is current again. Once undone the line says so and
 * strikes the statement, in the same place; `nothing` (none of theirs in
 * use: erased, expired or never theirs) says it was already gone, which
 * pressing again wouldn't change. Either is said to a screen reader; a
 * failure is the line's own, said as Trace says a failed step.
 */
export const SavedMemoryLine = ({ saved }: { saved: ChatSavedMemory }) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [outcome, setOutcome] = useState<BrainMemoryOutcome>();
  const titles: Record<BrainMemoryOutcome, string> = {
    done: t`Removed from memory`,
    nothing: t`Already removed`,
  };
  const undo = async () => {
    const answered = await run(
      async (session) => await session.brainMemories.forget(saved.memory)
    );
    if (answered !== undefined) {
      setOutcome(answered);
      announce(titles[answered]);
    }
  };
  // Gone before Undo: whatever it replaced isn't its to bring back.
  const replaced = outcome === "nothing" ? undefined : saved.replaced;
  return (
    <Trace>
      <TraceLine status={failure === undefined ? undefined : "error"}>
        <TraceIcon>
          <Icon icon={BrainIcon} />
        </TraceIcon>
        <TraceTitle>
          {outcome === undefined ? t`Saved to memory` : titles[outcome]}
        </TraceTitle>
        <TraceDescription>
          {outcome === undefined ? (
            <>
              <Text as="span" color="secondary" size="sm">
                <SavedText saved={saved} />
              </Text>{" "}
              <Button
                onClick={() => {
                  if (!busy) {
                    void undo();
                  }
                }}
                size="xs"
                status={busy ? "loading" : "idle"}
                style={styles.undo}
                variant="ghost"
              >
                <Trans>Undo</Trans>
              </Button>
            </>
          ) : (
            <Text as="span" color="muted" size="sm">
              <del>
                <SavedText saved={saved} />
              </del>
            </Text>
          )}
        </TraceDescription>
        {replaced === undefined ? null : (
          <TraceDescription style={styles.below}>
            <ReplacedText restored={outcome === "done"} statements={replaced} />
          </TraceDescription>
        )}
        {failure === undefined ? null : (
          <TraceDescription style={styles.below}>{failure}</TraceDescription>
        )}
      </TraceLine>
    </Trace>
  );
};
