import { hrErrors, hrPlatformNames } from "@grasp-os/shared/hr";
import type { HrPlatform, OnboardingHr } from "@grasp-os/shared/hr";
import {
  onboardingPeopleMax,
  onboardingTeamsMax,
} from "@grasp-os/shared/onboarding";
import type { Roster } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { useCore } from "../use-core.ts";
import {
  Asides,
  LaterLink,
  Onward,
  SupportLink,
  tones,
} from "./setup-parts.tsx";
import type { Answer } from "./setup-parts.tsx";
import {
  directoryListOf,
  StaffListError,
  withLeadsFrom,
} from "./staff-list.ts";

// Who leads which team, from the company's HR platform (GRA-371; the
// prototype's `Leads`, with `HR_PLATFORMS`), on the confirm step: the
// admin connects it there with a service user they make in it, and its
// departments, people and who reports to whom come to the organization on
// the screen, on the staff list's own path (`directoryListOf`), so people
// keep their ids and links. Nothing is kept until the admin has checked
// it and says it is right. HiBob is the first platform Grasp reads.

/** The platform the confirm step offers. */
const platform: HrPlatform = "hibob";

/** Why the HR platform could not become the organization on the screen. */
type HrProblem = "refused" | "large" | "empty" | "inactive" | "failed";

/** The kind of problem `error` is, for Stephen to say. */
const problemOf = (error: unknown): HrProblem => {
  if (error instanceof StaffListError) {
    return error.reason === "empty" ? "empty" : "large";
  }
  const code = hrErrors.codeOf(error);
  if (code === "hr.refused" || code === "hr.invalid") {
    return "refused";
  }
  if (code === "hr.too_large") {
    return "large";
  }
  return code === "hr.inactive" || code === "hr.not_connected"
    ? "inactive"
    : "failed";
};

/** What the admin typed: the service user's ID and its token. */
interface Typed {
  id: string;
  secret: string;
}

/**
 * Connects the platform with what the admin typed, if anything, and
 * reads it: the organization it holds, with what the admin set on the
 * screen kept, or why it could not be.
 */
const readHrRoster = async (
  core: ReturnType<typeof useCore>,
  typed: Typed | null,
  noTeam: string,
  shown: Roster
): Promise<Roster | HrProblem> => {
  try {
    const { people } = await core.withSession(async (session) => {
      if (typed !== null) {
        await session.onboarding.connectHrPlatform(platform, typed);
      }
      return await session.onboarding.readHrPlatform();
    });
    return withLeadsFrom(directoryListOf(people, noTeam).roster, shown);
  } catch (error) {
    return problemOf(error);
  }
};

/**
 * The HR platform on the confirm step: a way to connect it, or to read it
 * again once it is, and what it read, given to the step as the
 * organization to check (`onRoster`), with what Stephen says (`onAnswer`).
 */
export const HrLeads = ({
  hr,
  roster,
  onRoster,
  onAnswer,
}: {
  hr: OnboardingHr | null;
  /** The organization as the screen shows it now. */
  roster: Roster;
  onRoster: (roster: Roster) => void;
  onAnswer: (answer: Answer) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState<Typed>({ id: "", secret: "" });
  const name = hrPlatformNames[platform];
  const connected = hr?.status === "active";
  const noTeam = t({
    message: "Other",
    context: "the team for people a staff list gives no team",
  });
  const peopleMost = onboardingPeopleMax;
  const teamsMost = onboardingTeamsMax;
  const problems: Record<HrProblem, string> = {
    refused: t`${name} didn’t take this service user. Check its ID and token, and that it may read people’s work details.`,
    large: t`There are more people in ${name} than I can take: up to ${peopleMost} people in up to ${teamsMost} teams.`,
    empty: t`I found nobody in ${name}.`,
    inactive: t`I could not read ${name}. Connect it again with a service user that may read people’s work details.`,
    failed: t`I could not reach ${name} just now. Try again in a moment.`,
  };
  const read = async (connecting: Typed | null) => {
    setBusy(true);
    const found = await readHrRoster(core, connecting, noTeam, roster);
    setBusy(false);
    if (connecting !== null) {
      await router.invalidate();
    }
    if (typeof found === "string") {
      if (found === "inactive") {
        setOpen(true);
      }
      onAnswer({
        text: problems[found],
        announce: true,
        tone: tones.plain,
        quick: true,
      });
      return;
    }
    setOpen(false);
    setTyped({ id: "", secret: "" });
    onRoster(found);
    const teams = found.teams.length;
    onAnswer({
      text: plural(teams, {
        one: `${name} is connected. I can see # team, its lead and who reports to whom.`,
        other: `${name} is connected. I can see # teams, their leads and who reports to whom.`,
      }),
      announce: true,
      tone: tones.plain,
      quick: true,
    });
  };
  const ready = typed.id.trim() !== "" && typed.secret.trim() !== "";
  return (
    <>
      {open ? (
        <Onward>
          <form
            className="flex w-full max-w-sm flex-col gap-4 text-left"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready) {
                void read(typed);
              }
            }}
          >
            <FieldGroup>
              <FieldDescription>
                {t`In ${name}, make a service user that may read people’s basic and work details, and paste its ID and token here.`}
              </FieldDescription>
              <Field>
                <FieldLabel
                  htmlFor={`${ids}-id`}
                >{t`Service user ID`}</FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={busy}
                  id={`${ids}-id`}
                  onChange={(event) => {
                    setTyped({ ...typed, id: event.target.value });
                  }}
                  value={typed.id}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${ids}-secret`}>{t`Token`}</FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={busy}
                  id={`${ids}-secret`}
                  onChange={(event) => {
                    setTyped({ ...typed, secret: event.target.value });
                  }}
                  type="password"
                  value={typed.secret}
                />
              </Field>
            </FieldGroup>
            <Button disabled={busy || !ready} type="submit" variant="outline">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {t`Connect ${name}`}
            </Button>
          </form>
        </Onward>
      ) : null}
      <Asides>
        {connected && !open ? (
          <LaterLink
            onClick={() => {
              if (!busy) {
                void read(null);
              }
            }}
          >
            {t`Read the leads from ${name} again`}
          </LaterLink>
        ) : null}
        {!connected && !open ? (
          <LaterLink
            onClick={() => {
              setOpen(true);
            }}
          >
            {t`Take the leads from ${name}`}
          </LaterLink>
        ) : null}
        {open ? (
          <LaterLink
            onClick={() => {
              setOpen(false);
            }}
          >
            {t`Not now`}
          </LaterLink>
        ) : null}
        <SupportLink page="hr">{t`More about this connection`}</SupportLink>
      </Asides>
    </>
  );
};
