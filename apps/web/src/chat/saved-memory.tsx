import type {
  BrainMemoryOutcome,
  ChatSavedMemory,
} from "@grasp-os/shared/brain-memories";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";

const styles = stylex.create({
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space2,
    rowGap: grasp.space1,
  },
});

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
      <Badge>
        <Trans>Instruction</Trans>
      </Badge>
    );
  }
  if (type === "preference") {
    return (
      <Badge>
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
  const { t } = useLingui();
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
    <div {...stylex.props(styles.line)}>
      {outcome === "done" ? (
        <Text size="sm" tone="muted">
          <Trans>Grasp no longer remembers this.</Trans>
        </Text>
      ) : null}
      {outcome === "nothing" ? (
        <Text size="sm" tone="muted">
          <Trans>There was nothing to undo: Grasp no longer uses this.</Trans>
        </Text>
      ) : null}
      {outcome === undefined ? (
        <>
          <SavedKind type={saved.type} />
          <Text size="sm" tone="muted">
            <SavedText saved={saved} />
          </Text>
          <Button
            disabled={busy}
            onClick={() => {
              void undo();
            }}
            size="xs"
            variant="ghost"
          >
            {t`Undo`}
          </Button>
        </>
      ) : null}
      {failure === undefined ? null : <Alert variant="danger">{failure}</Alert>}
    </div>
  );
};
