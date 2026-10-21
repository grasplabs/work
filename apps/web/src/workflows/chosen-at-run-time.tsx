import { Badge } from "@grasp-os/ui/components/badge";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";

import { formatList } from "../format.ts";

// A step's options that its code doesn't set, chosen at run time
// (`StepOutline.dynamic`): the review reads only how they're taken, not
// what they are, so a reviewer or a deadline the run's input, or an
// earlier step's result, picks says so.

const optionNames: Readonly<Record<string, MessageDescriptor>> = {
  from: msg`who answers`,
  timeout: msg`the deadline`,
  remindAfter: msg`the reminder`,
  duration: msg`how long it waits`,
  retries: msg`its retries`,
};

/** A step's options chosen at run time, in words; none when it has none. */
export const chosenAtRunTimeText = (
  options: readonly string[] | undefined
): string | undefined => {
  if (options === undefined || options.length === 0) {
    return undefined;
  }
  const named = options.map((option) => {
    const name = optionNames[option];
    return name === undefined ? option : i18n._(name);
  });
  return i18n._(msg`Chosen at run time: ${ph({ options: formatList(named) })}`);
};

/** A badge for a step's options chosen at run time, if it has any. */
export const ChosenAtRunTime = ({
  options,
}: {
  options: readonly string[] | undefined;
}) => {
  const text = chosenAtRunTimeText(options);
  return text === undefined ? null : <Badge variant="outline">{text}</Badge>;
};
