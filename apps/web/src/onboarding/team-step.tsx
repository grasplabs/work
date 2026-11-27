import { planDays } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { CopyButton } from "@grasp-os/ui/components/copy-button";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatList } from "../format.ts";
import { TopError } from "../frame/top-error.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { CalmStep } from "./calm-frame.tsx";
import { MessageCompose } from "./message-compose.tsx";
import { SendPlanForm, useSendWords } from "./send-plan-form.tsx";
import { choiceHolds, choiceShown, dayTiles, replanOf } from "./send-plan.ts";
import type { SendChoice } from "./send-plan.ts";
import { useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
import { useAnswer } from "./step-voice.tsx";
import { planDraft } from "./visit.ts";

// Tell the team, and plan the interviews: the message the admin sends
// themselves, as a new email Stephen writes for them the first time
// (message-compose.tsx), theirs to change and copy; then the day, and
// which teams, on one card of its own. The leads get their link that
// morning; everyone else once their lead talked. There is no doing it
// later from here: until the team is told the setup isn't finished, and
// every page leads back to this step. Without a staff list there is no day
// to plan yet: the letter alone, and Grasp's staff plan the day with the
// admin.

/** Wide enough for the message and the plan side by side. */
const wide = "@media (width >= 72rem)";

const styles = stylex.create({
  // The message and when the links go out: one under the other, and on a wide screen side by side,
  // out past the column on its middle, so the whole step fits a laptop's screen without scrolling.
  stack: {
    display: "grid",
    gap: { default: space[4], [wide]: space[6] },
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [wide]: "minmax(0, 1.1fr) minmax(0, 1fr)",
    },
    alignItems: "stretch",
    width: { default: "100%", [wide]: "min(68rem, calc(100vw - 4rem))" },
    // On its middle, past the column on both sides alike.
    marginInline: {
      default: 0,
      [wide]: "calc((100% - min(68rem, calc(100vw - 4rem))) / 2)",
    },
  },
  // Copy on the end edge of the message's foot, where the hand goes on.
  foot: { display: "flex", justifyContent: "flex-end" },
});

/** What Stephen answers as the message is copied. */
const copied = msg`Copied. Send it from your own email.`;

export const TeamStep = ({
  data,
  today,
  message: kept,
  onMessage,
  onward,
}: StepProps) => {
  const { t, i18n } = useLingui();
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
  // What he says as a day is picked, as the tiles show it: today, a tile's weekday, or another day's date.
  const tiles = dayTiles(today);
  const weekday = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    timeZone: "UTC",
  });
  const longDate = new Intl.DateTimeFormat(i18n.locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const dayLine = (day: string) => {
    const date = new Date(`${day}T12:00:00Z`);
    if (day === today) {
      return msg`Today it is.`;
    }
    if (tiles.includes(day)) {
      const name = weekday.format(date);
      return msg`${name} it is.`;
    }
    const named = longDate.format(date);
    return msg`On ${named}, then.`;
  };
  const answer = useAnswer([copied, ...tiles.map(dayLine)]);
  const choose = (next: SendChoice) => {
    // Another day picked: he says it back.
    if (next.day !== choice.day) {
      answer(dayLine(next.day));
    }
    planDraft.keep(from, next);
    setChoice(next);
  };
  // A day field holding typed text that is no day to plan: the plan waits for one.
  const [wrong, setWrong] = useState({ first: false, later: false });
  // Sent, it stays busy until every step reads what core now has, so it can't be pressed twice.
  const [refreshing, setRefreshing] = useState(false);
  const sendWords = useSendWords(today);
  const when = sendWords(choice.day, choice.time);
  const heldWhen =
    choice.heldDay === null ? "" : sendWords(choice.heldDay, choice.heldTime);
  const going = teams.length - choice.held.length;
  // A team taken out waits, unplanned: one sentence after what happens next says which, or when, if a plan set before has a day for it.
  const heldNames = formatList(
    teams
      .filter((team) => choice.held.includes(team.id))
      .map((team) => team.name)
  );
  const heldCount = choice.held.length;
  const later =
    choice.heldDay === null
      ? plural(heldCount, {
          one: `${heldNames} gets no link yet.`,
          other: `${heldNames} get no link yet.`,
        })
      : plural(heldCount, {
          one: `${heldNames} gets theirs ${heldWhen}.`,
          other: `${heldNames} get theirs ${heldWhen}.`,
        });
  const first =
    heldCount === 0
      ? t`Leads get their link ${when}. Everyone else right after their lead has talked to me.`
      : t`${plural(going, {
          one: `The lead of # team gets their link ${when}. Everyone else right after their lead has talked to me.`,
          other: `The leads of # teams get their link ${when}. Everyone else right after their lead has talked to me.`,
        })}`;
  const next = heldCount === 0 ? first : `${first} ${later}`;
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
      }
      spoken={
        planned
          ? t`We’re nearly there. Before I reach out to anyone, it helps if they hear about me from you first. People open up a lot more when they know why I’m asking. So send them this message yourself, and then pick the day I can start.`
          : t`We’re nearly there. Before I reach out to anyone, it helps if they hear about me from you first. People open up a lot more when they know why I’m asking. So send them this message yourself, and Grasp’s team will plan the day I start together with you.`
      }
      title={t`Before I reach out, let your team know`}
    >
      <div {...stylex.props(styles.stack)}>
        <MessageCompose
          changed={kept !== null}
          foot={
            <div {...stylex.props(styles.foot)}>
              <CopyButton
                onCopy={() => {
                  answer(copied);
                }}
                size="lg"
                value={message}
                variant="outline"
              >
                {t`Copy the message`}
              </CopyButton>
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
        <TopError>{failure}</TopError>
      </div>
    </CalmStep>
  );
};
