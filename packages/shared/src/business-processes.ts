import { z } from "zod";

// The business processes Apps and workflows serve (GRA-511): a fixed list,
// each by the short ID of its standard name, so the UI shows a process's
// icon and groups by it. Their names and what each covers are the web's
// to say, in each language; core keeps the ID alone.
//
// - `o2c` Opportunity-to-Cash: from a first client conversation until the
//   money is in the bank.
// - `i2r` Issue-to-Resolution: every client question or complaint, until
//   it is solved.
// - `p2p` Purchase-to-Pay: from ordering from a supplier until their
//   invoice is paid.
// - `r2c` Risk-to-Compliance: the checks, reviews and records a regulator
//   expects.
// - `r2r` Record-to-Report: closing the books and producing the numbers
//   leadership looks at.
// - `h2r` Hire-to-Retire: everything around employees, from hiring to
//   leaving.

/** Every business process, in the order the UI lists them. */
export const businessProcesses = [
  "o2c",
  "i2r",
  "p2p",
  "r2c",
  "r2r",
  "h2r",
] as const;

export const businessProcessSchema = z.enum(businessProcesses);

/** A business process an App or a workflow serves. */
export type BusinessProcess = z.infer<typeof businessProcessSchema>;

/**
 * A stored process as a reader sees it: one the list doesn't hold (none
 * is ever written) reads as none, never as an error.
 */
export const storedProcessOf = (
  stored: string | null
): BusinessProcess | null => {
  const parsed = businessProcessSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
};
