import { hrErrors, hrPlatformNames } from "@grasp-os/shared/hr";
import type { HrPlatform, OnboardingHr } from "@grasp-os/shared/hr";
import {
  onboardingPeopleMax,
  onboardingTeamsMax,
} from "@grasp-os/shared/onboarding";
import type { Roster } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input, PasswordInput } from "@grasp-os/ui/components/input";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useCore } from "../use-core.ts";
import {
  directoryListOf,
  StaffListError,
  withLeadsFrom,
} from "./staff-list.ts";

// Who leads which team, from the company's HR platform (GRA-371), on the
// leads step: the admin connects it there with a service user they make
// in it, and its departments, people and who reports to whom come to the
// organization on the screen, on the staff list's own path
// (`directoryListOf`), so people keep their ids and links. Nothing is kept
// until the admin has checked it and says it is right. HiBob is the first
// platform Grasp reads.

const styles = stylex.create({
  form: { display: "grid", gap: space[4] },
  end: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space[3],
  },
});

/** The platform the leads step offers. */
const platform: HrPlatform = "hibob";

/** Why the HR platform could not become the organization on the screen. */
type HrProblem = "refused" | "large" | "empty" | "inactive" | "failed";

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

/** Connects the platform with what was typed, if anything, and reads it: the organization it holds, or why it could not be. */
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
 * The HR platform on the leads step: a way to connect it, or to read it
 * again once it is, and what it read, given to the step as the
 * organization to check (`onRoster`), with what it says of it (`onSaid`).
 */
export const HrLeads = ({
  hr,
  roster,
  onRoster,
  onSaid,
}: {
  hr: OnboardingHr | null;
  /** The organization as the screen shows it now. */
  roster: Roster;
  onRoster: (roster: Roster) => void;
  onSaid: (said: string) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
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
      await router.invalidate({ sync: true });
    }
    if (typeof found === "string") {
      if (found === "inactive") {
        setOpen(true);
      }
      onSaid(problems[found]);
      return;
    }
    setOpen(false);
    setTyped({ id: "", secret: "" });
    onRoster(found);
    const teams = found.teams.length;
    onSaid(
      plural(teams, {
        one: `${name} is connected. I can see # team, its lead and who reports to whom.`,
        other: `${name} is connected. I can see # teams, their leads and who reports to whom.`,
      })
    );
  };
  const ready = typed.id.trim() !== "" && typed.secret.trim() !== "";
  const connectIt = t`Connect ${name}`;
  if (!open) {
    return (
      <div {...stylex.props(styles.end)}>
        <Button
          disabled={busy}
          onClick={() => {
            if (connected) {
              void read(null);
            } else {
              setOpen(true);
            }
          }}
          size="lg"
          status={busy ? "loading" : "idle"}
          variant="outline"
        >
          {connected
            ? t`Read the leads from ${name} again`
            : t`Take the leads from ${name}`}
        </Button>
      </div>
    );
  }
  return (
    <Card padding="lg">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            void read(typed);
          }
        }}
        {...stylex.props(styles.form)}
      >
        <Text>
          {t`In ${name}, make a service user that may read people’s basic and work details, and paste its ID and token here.`}
        </Text>
        <Field disabled={busy}>
          <FieldLabel>{t`Service user ID`}</FieldLabel>
          <Input
            autoComplete="off"
            onValueChange={(id) => {
              setTyped({ ...typed, id });
            }}
            value={typed.id}
          />
        </Field>
        <Field disabled={busy}>
          <FieldLabel>{t`Token`}</FieldLabel>
          <PasswordInput
            autoComplete="off"
            onValueChange={(secret) => {
              setTyped({ ...typed, secret });
            }}
            value={typed.secret}
          />
        </Field>
        <div {...stylex.props(styles.end)}>
          <Button
            disabled={busy || !ready}
            status={busy ? "loading" : "idle"}
            size="lg"
            type="submit"
            variant="outline"
          >
            {connectIt}
          </Button>
          <Button
            onClick={() => {
              setOpen(false);
            }}
            size="lg"
            variant="link"
          >
            {t`Not now`}
          </Button>
        </div>
      </form>
    </Card>
  );
};
