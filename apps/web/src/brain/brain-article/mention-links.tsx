import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { focus } from "../../grasp/focus/focus.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { statementWords } from "../brain.ts";
import type { NoteQuote } from "../brain.ts";

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    paddingTop: grasp.space2,
    paddingBottom: grasp.space4,
  },
  mention: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: { default: grasp.muted, ":hover": grasp.ink },
    textDecorationLine: "none",
  },
});

/**
 * The statements that name a note without being linked to it, each a link
 * to where it was said: in quotation marks as someone said them, a team's
 * claim in plain words (`statementWords`).
 */
export const MentionLinks = ({
  mentions,
}: {
  mentions: readonly NoteQuote[];
}) => (
  <div {...stylex.props(styles.list)}>
    {mentions.map((mention) => (
      <Link
        hash={mention.statementId}
        key={mention.statementId}
        params={{ noteId: mention.sourceId }}
        to="/brain/$noteId"
        {...stylex.props(styles.mention, focus.words)}
      >
        {statementWords(mention.statementId, mention.text)}
      </Link>
    ))}
  </div>
);
