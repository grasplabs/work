// Concept B, Stephen's notes: the campaign page in the onboarding's own
// voice. Centred, as the onboarding's steps were: Stephen at work, one
// title, one sentence lighting up as it is read. Under it, what he learned
// as a short transcript, his lines at the start as in the interview's
// transcript, newest last; and what the admin must do, he asks as a
// question with one press to answer. On a phone, the title, the sentence
// and his latest line alone.
import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@grasp-os/ui/components/confirmation";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Message,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "@grasp-os/ui/components/message";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { AskAction } from "./campaign-asks.tsx";
import { AllFindings, OnYourComputer, wide } from "./campaign-parts.tsx";
import { statementOf, whenWords } from "./campaign-words.ts";
import type { Ask, Campaign, Finding, TeamPicture } from "./fixtures.ts";
import { ReadAloud } from "./read-aloud.tsx";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: { default: space[12], [media.maxSm]: space[8] },
    paddingBlockStart: { default: space[10], [media.maxSm]: space[4] },
  },
  centre: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space[4],
    maxWidth: "34rem",
    textAlign: "center",
    textWrap: "balance",
  },
  thread: {
    display: "flex",
    flexDirection: "column",
    gap: space[6],
    alignSelf: "stretch",
  },
  press: { display: "flex" },
  // On a phone only his latest line stands.
  earlier: { display: { default: null, [media.maxSm]: "none" } },
  foot: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space[3],
    textAlign: "center",
  },
});

/** How many of his lines the page shows: the rest are a press away. */
const shown = 4;

/** The newest findings, newest last. */
const latest = (campaign: Campaign) =>
  campaign.teams
    .flatMap((team) => team.findings.map((finding) => ({ finding, team })))
    .slice(-shown);

/** One line of his: who it is about, and what he learned there. */
const Line = ({
  finding,
  team,
  grouped,
}: {
  finding: Finding;
  team: TeamPicture;
  grouped: boolean;
}) => (
  <Message aria-label="Stephen">
    <MessageContent>
      <MessageHeader>
        {[
          grouped ? team.name : finding.topic,
          finding.kind === "difference" ? "told two ways" : "",
        ]
          .filter((part) => part !== "")
          .join(" · ")}
      </MessageHeader>
      <Bubble variant="ghost">
        <BubbleContent>{finding.text}</BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
);

/** A quiet team, as his question: one press nudges it in the admin's name. */
const Nudge = ({ ask }: { ask: Extract<Ask, { kind: "quiet" }> }) => {
  const [answer, setAnswer] = useState<boolean | undefined>();
  return (
    <Confirmation
      approval={{ id: ask.id, approved: answer }}
      state={answer === undefined ? "approval-requested" : "approval-responded"}
    >
      <ConfirmationTitle>
        <ConfirmationRequest>
          {`${ask.team} is quiet: ${ask.waiting} still to talk. Shall I nudge them in your name?`}
        </ConfirmationRequest>
        <ConfirmationAccepted>
          {`Done: ${ask.team} got a nudge from you.`}
        </ConfirmationAccepted>
        <ConfirmationRejected>
          I’ll leave them be and remind them once myself.
        </ConfirmationRejected>
      </ConfirmationTitle>
      <ConfirmationActions>
        <ConfirmationAction
          onClick={() => {
            setAnswer(false);
          }}
          variant="outline"
        >
          Not now
        </ConfirmationAction>
        <ConfirmationAction
          onClick={() => {
            setAnswer(true);
          }}
        >
          Nudge them
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
};

/** A bounced invitation, as his line, with the one press beside it. */
const Bounced = ({ ask }: { ask: Extract<Ask, { kind: "bounce" }> }) => {
  const [done, setDone] = useState(false);
  return (
    <Message aria-label="Stephen">
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            {done
              ? "Thanks. The invitation went out again."
              : `My invitation to ${ask.address} bounced. Could you check the address?`}
          </BubbleContent>
        </Bubble>
        <div {...stylex.props(styles.press)}>
          <AskAction
            ask={ask}
            done={done}
            onDone={() => {
              setDone(true);
            }}
          />
        </div>
      </MessageContent>
    </Message>
  );
};

/** Concept B: the campaign page as Stephen's notes. */
export const CampaignNotes = ({ campaign }: { campaign: Campaign }) => {
  const { lead, rest } = statementOf(campaign);
  const enough = campaign.pace === "enough";
  const lines = latest(campaign);
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.centre)}>
        <AgentIndicator
          aria-label={
            enough ? "Stephen is done listening" : "Stephen is listening"
          }
          success={enough}
        />
        <Heading level={1} size="xl">
          {lead}
        </Heading>
        <Text size="lg">
          <ReadAloud text={rest} />
        </Text>
      </header>
      {lines.length === 0 ? (
        <Text color="muted" size="sm">
          The first things I learn come in on day two.
        </Text>
      ) : (
        <MessageGroup>
          <div {...stylex.props(styles.thread)}>
            {lines.map(({ finding, team }, index) => (
              <div
                key={finding.id}
                {...stylex.props(index < lines.length - 1 && styles.earlier)}
              >
                <Line
                  finding={finding}
                  grouped={campaign.grouped}
                  team={team}
                />
              </div>
            ))}
            {campaign.asks.map((ask) => (
              <div key={ask.id} {...stylex.props(wide.only)}>
                {ask.kind === "quiet" ? (
                  <Nudge ask={ask} />
                ) : (
                  <Bounced ask={ask} />
                )}
              </div>
            ))}
          </div>
        </MessageGroup>
      )}
      <OnYourComputer />
      <div {...stylex.props(wide.only)}>
        <div {...stylex.props(styles.foot)}>
          <Text as="span" size="sm" color="muted">
            {`${whenWords(campaign)} · ${campaign.known}% known`}
          </Text>
          <AllFindings campaign={campaign} variant="outline" />
        </div>
      </div>
    </div>
  );
};
