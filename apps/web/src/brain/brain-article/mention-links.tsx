import { focusRingText } from "@grasp-os/ui/lib/styles";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { statementWords } from "../brain.ts";
import type { NoteQuote } from "../brain.ts";

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    paddingTop: space["2"],
    paddingBottom: space["4"],
  },
  mention: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
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
        {...stylex.props(styles.mention, focusRingText)}
      >
        {statementWords(mention.statementId, mention.text)}
      </Link>
    ))}
  </div>
);
