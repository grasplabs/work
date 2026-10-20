import { Badge } from "@grasp-os/ui/components/badge";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";

import { formatList } from "../format.ts";

// A step's options that its code doesn't set, chosen when the run starts
// (`StepOutline.dynamic`): the review reads only how they're taken, not
// what they are, so a reviewer or a deadline the run's input picks says so.

const optionNames: Readonly<Record<string, MessageDescriptor>> = {
  from: msg`who answers`,
  timeout: msg`the deadline`,
  remindAfter: msg`the reminder`,
  duration: msg`how long it waits`,
  retries: msg`its retries`,
};

/** A step's options chosen when the run starts, in words; none when it has none. */
export const chosenAtStartText = (
  options: readonly string[] | undefined
): string | undefined => {
  if (options === undefined || options.length === 0) {
    return undefined;
  }
  const named = options.map((option) => {
    const name = optionNames[option];
    return name === undefined ? option : i18n._(name);
  });
  return i18n._(
    msg`Chosen when the run starts: ${ph({ options: formatList(named) })}`
  );
};

/** A badge for a step's options chosen when the run starts, if it has any. */
export const ChosenAtStart = ({
  options,
}: {
  options: readonly string[] | undefined;
}) => {
  const text = chosenAtStartText(options);
  return text === undefined ? null : <Badge variant="outline">{text}</Badge>;
};
