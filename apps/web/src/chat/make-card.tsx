import type { ChatMessage } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import type { ThreadBuild } from "./build-progress.tsx";

// What making something in a chat looks like, whatever it makes: an App
// or a workflow (a plan, `proposePlan`), an agent (`draftAgent`) or a
// change to one (`draftAgentChange`). The chat proposes it as a card in
// the thread, and nothing is made until the person presses the card's
// button: Build it, Make it, Change it. Each card keeps its own content
// and its own words; the frame, the press and when it waits are the same.

/** The cards the chat proposes, by where a reply keeps each. */
export type MakeKind = "planned" | "agentDraft" | "agentChange";

/** The card waiting for the person, if one does: the latest reply's, while nothing runs and nothing was said since. */
export const pendingCard = (
  messages: readonly ChatMessage[],
  running: boolean
): { kind: MakeKind; callId: string } | undefined => {
  if (running) {
    return undefined;
  }
  const last = messages.findLast(({ role }) => role !== "result");
  if (last?.role !== "assistant") {
    return undefined;
  }
  for (const kind of ["planned", "agentDraft", "agentChange"] as const) {
    const card = last[kind];
    if (card !== undefined) {
      return { kind, callId: card.callId };
    }
  }
  return undefined;
};

/** A card the chat proposes: its title, the line that nothing is made yet, what it holds, and the press while it waits. */
export const MakeCard = ({
  label,
  title,
  description,
  children,
  actions,
}: {
  /** What the card is, to a screen reader. */
  label: string;
  title: ReactNode;
  /** That nothing is made until the press, in the card's own words. */
  description: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) => (
  <Card aria-label={label} render={<section />}>
    <CardHeader>
      <CardTitle>
        <h2 className="type-display">{title}</h2>
      </CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent>{children}</CardContent>
    {actions === undefined ? null : <CardFooter>{actions}</CardFooter>}
  </Card>
);

/** What a press asks with: the person's words, and the model and effort the box names. */
export interface Asked {
  text: string;
  model: string;
  effort?: NonNullable<ThreadBuild["effort"]>;
}

/**
 * The card's press and the way to change it: the press asks core with
 * the box's model and effort (`press`), then `onDone` with what it made;
 * off while it isn't `ready` (a plan's connection still missing). Why it
 * failed shows under it, and what only part of it made (`notice`).
 */
export const MakeActions = <T,>({
  label,
  changeLabel,
  build,
  press,
  onDone,
  ready = true,
  notice,
}: {
  /** Build it, Make it, Change it. */
  label: string;
  /** Change the plan, Change something. */
  changeLabel: string;
  build: ThreadBuild;
  press: (session: Session, asked: Asked) => Promise<T>;
  onDone: (made: T) => void;
  ready?: boolean;
  notice?: ReactNode;
}) => {
  const { busy, failure, run } = useCoreAction();
  const { model, effort } = build;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!ready || busy || model === undefined}
          onClick={() => {
            if (model === undefined) {
              return;
            }
            void (async () => {
              const made = await run(
                async (session) =>
                  await press(session, {
                    text: label,
                    model,
                    ...(effort === undefined ? {} : { effort }),
                  })
              );
              if (made !== undefined) {
                onDone(made);
              }
            })();
          }}
          variant="highlight"
        >
          {label}
        </Button>
        <Button
          onClick={() => {
            build.onChangePlan();
          }}
          variant="outline"
        >
          {changeLabel}
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
      {notice}
    </div>
  );
};
