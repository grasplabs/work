import { Link } from "@tanstack/react-router";

import { statementWords } from "../brain.ts";
import type { NoteQuote } from "../brain.ts";

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
  <div className="flex flex-col gap-1 pt-2 pb-4">
    {mentions.map((mention) => (
      <Link
        className="text-muted-foreground hover:text-foreground text-sm leading-snug"
        hash={mention.statementId}
        key={mention.statementId}
        params={{ noteId: mention.sourceId }}
        to="/brain/$noteId"
      >
        {statementWords(mention.statementId, mention.text)}
      </Link>
    ))}
  </div>
);
