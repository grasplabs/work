/**
 * An organization being set up, on its Setup (src/hosting/progress.ts):
 * one calm line per thing that happens, its state, and how long it has
 * taken. Once live it is one line, its steps and who is invited folded
 * under it. Codes and the technical part only under each line's Details.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Spinner } from "@grasp-os/ui/components/spinner";
import type { ReactNode } from "react";

import { Section } from "../admin/section.tsx";
import type {
  LineState,
  ProgressLine,
  ProvisioningProgress,
} from "./progress.ts";

const stateWords: Readonly<Record<LineState, string>> = {
  waiting: "Waiting",
  doing: "Doing",
  done: "Done",
  retrying: "Trying again",
  failed: "Failed",
  needs_attention: "Needs attention",
};

/** How long from `from` to `to`, in minutes and seconds. */
const durationOf = (from: Date, to: Date): string => {
  const seconds = Math.max(
    0,
    Math.round((to.getTime() - from.getTime()) / 1000)
  );
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
};

const badgeVariants: Readonly<
  Record<LineState, "destructive" | "passed" | "outline">
> = {
  waiting: "outline",
  doing: "outline",
  done: "passed",
  retrying: "outline",
  failed: "destructive",
  needs_attention: "destructive",
};

const StateMark = ({ state }: { state: LineState }) => {
  if (state === "doing" || state === "retrying") {
    return <Spinner aria-hidden />;
  }
  return <Badge variant={badgeVariants[state]}>{stateWords[state]}</Badge>;
};

const Line = ({ line }: { line: ProgressLine }) => (
  <li className="flex flex-col gap-1 border-t py-3 first:border-t-0">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <StateMark state={line.state} />
      <span className={line.state === "waiting" ? "text-muted-foreground" : ""}>
        {line.label}
      </span>
      {/* A spinner says nothing: its state in words for screen readers. */}
      {line.state === "doing" || line.state === "retrying" ? (
        <span className="sr-only">{stateWords[line.state]}</span>
      ) : null}
    </div>
    {line.details.length === 0 ? null : (
      <Collapsible>
        <CollapsibleTrigger render={<Button size="sm" variant="link" />}>
          Details
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="text-muted-foreground list-disc pl-5 text-sm">
            {line.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    )}
  </li>
);

/** What it all comes to while it isn't ready, in a sentence. */
const headline = (progress: ProvisioningProgress, now: Date): string => {
  if (progress.state === "needs_attention") {
    return "Stopped: it needs a look";
  }
  if (progress.state === "waiting") {
    return progress.hosting === "on_prem"
      ? "Waiting for its own install"
      : "Waiting to start";
  }
  return `Setting up ${progress.hostname ?? "its address"} (${durationOf(progress.startedAt, now)} so far)`;
};

const Steps = ({ progress }: { progress: ProvisioningProgress }) => (
  <ol className="flex flex-col" aria-label="Steps">
    {progress.lines.map((line) => (
      <Line key={line.id} line={line} />
    ))}
  </ol>
);

/** Set up and live: one line, its steps and who is invited under it for who opens them. */
const Ready = ({ progress }: { progress: ProvisioningProgress }) => (
  <Collapsible>
    <Section
      action={
        <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
          Show its steps
        </CollapsibleTrigger>
      }
      title="Set up: every step is done"
    >
      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t px-5 py-4">
          {progress.admins.length === 0 ? null : (
            <p className="text-muted-foreground text-sm">
              {`Invited: ${progress.admins.join(", ")}. They become admins when they first sign in.`}
            </p>
          )}
          <Steps progress={progress} />
        </div>
      </CollapsibleContent>
    </Section>
  </Collapsible>
);

/**
 * Its progress; `children`, what staff do about it once it stopped (its
 * Retry), shown beside why.
 */
export const ProvisioningProgressView = ({
  progress,
  children,
}: {
  progress: ProvisioningProgress;
  children?: ReactNode;
}) => {
  if (progress.state === "ready") {
    return <Ready progress={progress} />;
  }
  return (
    <Section
      description={progress.notice ?? undefined}
      title={headline(progress, new Date())}
    >
      <div className="flex flex-col gap-3 border-t px-5 py-4">
        {progress.state === "needs_attention" ? children : null}
        <Steps progress={progress} />
        {progress.code === null ? null : (
          <Collapsible>
            <CollapsibleTrigger render={<Button size="sm" variant="link" />}>
              Details
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="text-muted-foreground font-mono text-sm">
                {progress.code}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </Section>
  );
};
