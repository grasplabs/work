/** A time as the release pages show it: `YYYY-MM-DD HH:MM`, in UTC, the same on the server and in the browser. */
export const formatTime = (time: Date): string =>
  time.toISOString().slice(0, 16).replace("T", " ");
