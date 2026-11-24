import { planDays } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { CopyButton } from "@grasp-os/ui/components/copy-button";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { CalmStep } from "./calm-frame.tsx";
import { MailToLetThrough } from "./review-parts.tsx";
import { SendPlanForm, useSendWords } from "./send-plan-form.tsx";
import { choiceHolds, choiceShown, replanOf } from "./send-plan.ts";
import type { SendChoice } from "./send-plan.ts";
import { useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
import { planDraft } from "./visit.ts";

// Tell the team, and plan the interviews: the message the admin sends
// themselves, written here and copied, and the day the interviews start.
// The leads get their link that morning; everyone else once their lead
// talked. Not ready yet, the admin can do it later: the setup ends here
// for now, and Settings, Onboarding keeps it as an open to-do.

const styles = stylex.create({
  stack: { display: "grid", gap: space[6] },
  message: { display: "grid", gap: space[3] },
  copy: { justifySelf: "start" },
});

export const TeamStep = ({
  data,
  today,
  message: kept,
  onMessage,
  onward,
  settled,
  onSettle,
}: StepProps) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { admin, view } = data;
  const { run, busy, failure } = useCoreAction();
  const refresh = useRefresh();
  const written = [
    t`Hi everyone,`,
    t`We want to spend less time on repetitive work, so there’s more time for our clients. This is about how work flows, not about jobs.`,
    t`Over the next two weeks you’ll get a short personal link to talk with Stephen, Grasp’s AI interviewer: leads for about 20 minutes, everyone else for 10 to 15. By voice or by typing.`,
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
      onward();
    }
  };
  return (
    <CalmStep
      body={t`People respond better when they know why I’m reaching out. Send them this message yourself, then pick the day I start.`}
      end={
        <>
          <Button
            disabled={!holds}
            onClick={() => {
              void send();
            }}
            size="lg"
            status={busy || refreshing ? "loading" : "idle"}
          >
            {t`I sent it`}
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
        <div {...stylex.props(styles.message)}>
          <Textarea
            aria-label={t`The message`}
            onValueChange={onMessage}
            rows={9}
            value={message}
          />
          <CopyButton
            size="lg"
            style={styles.copy}
            value={message}
            variant="outline"
          >
            {t`Copy the message`}
          </CopyButton>
        </div>
        <SendPlanForm
          choice={choice}
          onChange={choose}
          onWrong={(field, now) => {
            setWrong((before) => ({ ...before, [field]: now }));
          }}
          summary={
            <output aria-live="polite">
              <Text as="span" size="lg">
                {next}
              </Text>
            </output>
          }
          teams={teams}
          today={today}
        />
        <ErrorText>{failure}</ErrorText>
        <MailToLetThrough data={data} onSettle={onSettle} settled={settled} />
      </div>
    </CalmStep>
  );
};
