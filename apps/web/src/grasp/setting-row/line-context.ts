// A control in a Setting row may put a problem of its own (a file it refused) in the row's line
// under the name, in the danger tone, where a failed save's sentence goes; so the row keeps its
// height instead of the control growing a line under itself. Outside a row there is no setter, and
// the control draws the problem where it stands.
import { createContext, use } from "react";

/** Puts a problem in the row's line, or clears it with an empty string. */
export type SetRowProblem = (problem: string) => void;

export const RowProblem = createContext<SetRowProblem | null>(null);

/** The row's setter, when the control stands in a Setting row; null elsewhere. */
export const useRowProblem = (): SetRowProblem | null => use(RowProblem);
