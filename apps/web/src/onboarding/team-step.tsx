import { planDays } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { CopyButton } from "@grasp-os/ui/components/copy-button";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { CalmStep } from "./calm-frame.tsx";
import { MessageCompose } from "./message-compose.tsx";
import { Postmark } from "./postmark.tsx";
import { SendPlanForm, useSendWords } from "./send-plan-form.tsx";
import { choiceHolds, choiceShown, replanOf } from "./send-plan.ts";
import type { SendChoice } from "./send-plan.ts";
import { useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
import { planDraft } from "./visit.ts";

// Tell the team, and plan the interviews: the message the admin sends
// themselves, as a new email Stephen writes for them the first time
// (message-compose.tsx), theirs to change and copy, postmarked
// with the day the interviews start (postmark.tsx); then that day, and
// which teams, on one card of its own. The leads get their link that
// morning; everyone else once their lead talked. Not ready yet, the admin
// can do it later: the setup ends here for now, and Settings, Onboarding
// keeps it as an open to-do. Letting Grasp's mail through is the review
// step's, which comes next. Without a staff list there is no day to plan
// yet: the letter alone, and Grasp's staff plan the day with the admin.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  // Copy on the end edge, where the hand goes on (Ruben), the postmark before it; alone, copy is still on the end.
  foot: {
    display: "flex",
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[3],
  },
});

export const TeamStep = ({
  data,
  today,
  message: kept,
  onMessage,
  onward,
}: StepProps) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { admin, company, view } = data;
  const { run, busy, failure } = useCoreAction();
  const refresh = useRefresh();
  const written = [
    t`Hi everyone,`,
    t`We want to spend less time on repetitive work, so there’s more time for our clients. This is about how work flows, not about jobs.`,
    t`This week you’ll get a short personal link to talk with Stephen, Grasp’s AI interviewer. It takes 20 minutes at most, by voice or by typing.`,
    admin,
  ].join("\n\n");
  const message = kept ?? written;
  // The teams that take part, with how many of their people do.
  const teams = (view.roster?.teams ?? [])
    .filter((team) => !team.off)
    .map((team) => ({
      id: team.id,
      name: team.name,
      people: (view.roster?.people ?? []).filter(
        (person) => person.team === team.id && !person.away
      ).length,
    }));
  // What they set before stands; else the next working day at nine, every team. Changed and not sent yet, it is as they left it.
  const from = JSON.stringify(view.plan);
  const [choice, setChoice] = useState(
    () =>
      planDraft.of(from) ??
      choiceShown(
        view.plan,
        today,
        teams.map((team) => team.id)
      )
  );
  const choose = (next: SendChoice) => {
    planDraft.keep(from, next);
    setChoice(next);
  };
  // A day field holding typed text that is no day to plan: the plan waits for one.
  const [wrong, setWrong] = useState({ first: false, later: false });
  // Sent, it stays busy until every step reads what core now has, so it can't be pressed twice.
  const [refreshing, setRefreshing] = useState(false);
  const when = useSendWords(today)(choice.day, choice.time);
  const going = teams.length - choice.held.length;
  const next =
    choice.held.length === 0
      ? t`Leads get their link ${when}. Everyone else right after their lead has talked to me.`
      : t`${plural(going, {
          one: `The lead of # team gets their link ${when}. Everyone else right after their lead has talked to me.`,
          other: `The leads of # teams get their link ${when}. Everyone else right after their lead has talked to me.`,
        })}`;
  const holds =
    !wrong.first &&
    !wrong.later &&
    choiceHolds(
      choice,
      teams.map((team) => team.id)
    );
  const send = async () => {
    if (!holds || busy || refreshing) {
      return;
    }
    const saved = await run(
      async (session) =>
        await session.onboarding.savePlan(
          replanOf(choice, view.plan, planDays.usual)
        )
    );
    if (saved !== undefined) {
      setRefreshing(true);
      await refresh();
      setRefreshing(false);
      void onward();
    }
  };
  // No staff list yet: core plans no day without one. The message still goes; Grasp's staff plan
  // the day with the admin once the teams are set up.
  const planned = view.roster !== null;
  return (
    <CalmStep
      body={
        planned
          ? t`People respond better when they know why I’m reaching out. Send them this message yourself, then pick the day I start.`
          : t`People respond better when they know why I’m reaching out. Send them this message yourself. Grasp’s staff plan the day I start with you.`
      }
      end={
        <>
          <Button
            disabled={planned && !holds}
            onClick={() => {
              if (planned) {
                void send();
              } else {
                void onward();
              }
            }}
            size="lg"
            status={busy || refreshing ? "loading" : "idle"}
          >
            {t`Continue`}
          </Button>
          {view.plan === null ? (
            <Button
              onClick={() => {
                void navigate({ to: "/settings/onboarding" });
              }}
              size="lg"
              variant="outline"
            >
              {t`Do this later`}
            </Button>
          ) : null}
        </>
      }
      title={t`Before I reach out, let your team know`}
    >
      <div {...stylex.props(styles.stack)}>
        <MessageCompose
          changed={kept !== null}
          foot={
            <div {...stylex.props(styles.foot)}>
              <CopyButton size="lg" value={message} variant="outline">
                {t`Copy the message`}
              </CopyButton>
              {planned ? <Postmark day={choice.day} /> : null}
            </div>
          }
          onValueChange={onMessage}
          to={
            company === null
              ? t`Everyone on your team`
              : t`Everyone at ${company}`
          }
          value={message}
        />
        {planned ? (
          <SendPlanForm
            choice={choice}
            onChange={choose}
            onWrong={(field, now) => {
              setWrong((before) => ({ ...before, [field]: now }));
            }}
            summary={
              <output aria-live="polite">
                <Text as="span">{next}</Text>
              </output>
            }
            teams={teams}
            today={today}
          />
        ) : null}
        <ErrorText>{failure}</ErrorText>
      </div>
    </CalmStep>
  );
};
