import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";

import { invalidCall } from "./workflow-error.ts";
import type { Duration } from "./workflow-steps.ts";

/** A duration in milliseconds, as the format writes one. */
const durationUnits: Readonly<Record<string, number>> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

const durationPattern =
  /^(?<count>[1-9][0-9]{0,8}) (?<unit>second|minute|hour|day|week)s?$/u;

/** `duration`'s milliseconds: refused unless it is one of up to a year. */
export const millisecondsOf = (duration: Duration): number => {
  const groups = durationPattern.exec(duration)?.groups;
  const ms = Number(groups?.count) * (durationUnits[groups?.unit ?? ""] ?? 0);
  if (
    !Number.isSafeInteger(ms) ||
    ms <= 0 ||
    ms > sealedBuildLimits.deadlineMs
  ) {
    throw invalidCall(`"${duration}" isn't a duration of up to a year`);
  }
  return ms;
};
