/* oxlint-disable typescript/no-deprecated -- the breaking release's step 3: Severity stays a wrapper over Badge's dot until step 9 removes it (handover/audit/RELEASE.md §7). */
export { Severity } from "./severity";
export type {
  SeverityLayoutStyle,
  SeverityLevel,
  SeverityProps,
} from "./severity";
