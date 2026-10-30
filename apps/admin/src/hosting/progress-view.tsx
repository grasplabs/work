/**
 * An organization being set up, on its Setup (src/hosting/progress.ts):
 * one calm line per thing that happens, its state, and how long it has
 * taken; once live, where to open it and who is invited. Codes and the
 * technical part only under each line's Details.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Spinner } from "@grasp-os/ui/components/spinner";

import { SetupSection } from "../admin/setup-parts.tsx";
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
  Record<LineState, "destructive" | "secondary" | "outline">
> = {
  waiting: "outline",
  doing: "outline",
  done: "secondary",
  retrying: "outline",
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

/** What it all comes to, in a sentence. */
const headline = (progress: ProvisioningProgress, now: Date): string => {
  const host = progress.hostname ?? "its address";
  if (progress.state === "ready") {
    return `Ready: open ${host}`;
  }
  if (progress.state === "needs_attention") {
    return "Setting it up needs a look";
  }
  if (progress.state === "waiting") {
    return progress.hosting === "on_prem"
      ? "Waiting for its own install"
      : "Waiting to start";
  }
  return `Setting up ${host} (${durationOf(progress.startedAt, now)} so far)`;
};

export const ProvisioningProgressView = ({
  progress,
}: {
  progress: ProvisioningProgress;
}) => {
  const now = new Date();
  return (
    <SetupSection
      description={
        progress.readyAt === null
          ? (progress.notice ??
            "Each step runs by itself, and is tried again if it fails.")
          : `Took ${durationOf(progress.startedAt, progress.readyAt)}.`
      }
      title={headline(progress, now)}
    >
      <div className="flex flex-col gap-3 border-t px-5 py-4">
        {progress.state === "ready" && progress.hostname !== null ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button
              nativeButton={false}
              render={
                <a
                  aria-label={`Open ${progress.hostname}`}
                  href={`https://${progress.hostname}`}
                  rel="noopener"
                  target="_blank"
                />
              }
            >
              {`Open ${progress.hostname}`}
            </Button>
            <span className="text-muted-foreground">
              {`Invited: ${progress.admins.join(", ")}. They become admins when they first sign in.`}
            </span>
          </div>
        ) : null}
        <ol className="flex flex-col" aria-label="Steps">
          {progress.lines.map((line) => (
            <Line key={line.id} line={line} />
          ))}
        </ol>
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
    </SetupSection>
  );
};
