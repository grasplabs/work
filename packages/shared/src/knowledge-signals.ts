// The kinds of Knowledge usage signals core stored in `knowledge_signals`
// (core's db/core/schema.ts) while it computed them. Nothing computes or
// reads them any more; the table is dropped in a later release, and this
// with it.

/** Every kind of signal the table holds. */
export const knowledgeSignalKinds = [
  "unanswered_question",
  "unread_document",
  "overdue_review",
] as const;
