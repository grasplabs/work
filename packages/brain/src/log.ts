// The Brain's logs: one object per line, so every field is searchable in
// the host's Workers Logs. Never secrets, text a document holds, or terms.

/** A log line's fields. */
export type LogFields = Readonly<Record<string, string | number | undefined>>;

export const log = {
  info: (event: string, fields: LogFields): void => {
    console.info({ event, ...fields });
  },
  warn: (event: string, fields: LogFields): void => {
    console.warn({ event, ...fields });
  },
  error: (event: string, fields: LogFields): void => {
    console.error({ event, ...fields });
  },
};

/** What to log about something that was thrown. */
export const errorFields = (error: unknown): LogFields =>
  error instanceof Error
    ? {
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
      }
    : { errorName: typeof error };
