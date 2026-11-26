import { TopError } from "../frame/top-error.tsx";

// What a setup step shows when a sign-in didn't connect: it came back
// refused, or couldn't start. Said in the bar at the top, as every error
// in the setup is: what happened as its title, what it means and what to
// do in its words, and trying again as its button. Closing it leaves the
// step as it was, for the other way on.

export interface ConnectionProblemProps {
  /** What happened, as the title: "Microsoft didn't connect". */
  title: string;
  /** What it means and what to do; null while nothing went wrong. */
  message: string | null;
  /** Trying again: its words and what it does. */
  retry: { label: string; run: () => Promise<void> | void };
  onClose: () => void;
}

export const ConnectionProblem = ({
  title,
  message,
  retry,
  onClose,
}: ConnectionProblemProps) => (
  <TopError
    action={{
      label: retry.label,
      run: async () => {
        onClose();
        await retry.run();
      },
    }}
    onClose={onClose}
    title={title}
  >
    {message}
  </TopError>
);
