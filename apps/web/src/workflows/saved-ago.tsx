import { Plural, Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { formatDate } from "../format.ts";

// When a workflow's draft was last saved, as the prototype says it beside
// its name (`SavedAgo` in `routes/workflows/$workflowId.tsx`): just now,
// minutes ago within the hour, else the day. It moves on by itself while
// the page stays open.

/** How often the minutes are counted again. */
const tickMs = 30_000;

/** One minute, in milliseconds. */
const minuteMs = 60_000;

/** Minutes in an hour: from then on the day is said instead. */
const hourMinutes = 60;

export const SavedAgo = ({ at }: { at: string }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const minutes = Math.floor((now - Date.parse(at)) / minuteMs);
  if (minutes < 1) {
    return <Trans>Saved just now</Trans>;
  }
  if (minutes < hourMinutes) {
    return (
      <Plural one="Saved # min ago" other="Saved # min ago" value={minutes} />
    );
  }
  const date = formatDate(at);
  return <Trans>Saved on {date}</Trans>;
};
