import type { Agreements } from "@grasp-os/shared/onboarding";
import type { StaffAgreements } from "@grasp-os/shared/onboarding-staff";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Switch } from "@grasp-os/ui/components/switch";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CircleCheckIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { today } from "../onboarding/days.ts";
import { SettingsError, SettingsSection } from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The onboarding area's agreements (GRA-320), as in the prototype
// (`components/admin/stage-agreed.tsx`): what must be in place before
// anyone is invited, each with the day it was: the data processing
// agreement, the company's risk assessment, and the works council's yes,
// or that there is none. Until all three are in, the admin's links wait;
// once they are, those that are due go out at once. Once the team is told
// (a link went out), what was agreed stays as it was: staff pause the
// interviews instead.

const none: Agreements = {
  processing: false,
  assessment: false,
  council: "waiting",
};

type Council = Agreements["council"];

const councils: readonly Council[] = ["agreed", "none", "waiting"];

const isCouncil = (value: string): value is Council =>
  councils.some((each) => each === value);

/** Done, with its mark; or what is still missing, in the colour of attention. */
const Status = ({ done, children }: { done: boolean; children: string }) =>
  done ? (
    <span className="flex items-center gap-1.5">
      <CircleCheckIcon aria-hidden="true" className="size-4" />
      {children}
    </span>
  ) : (
    <span className="text-status-attention">{children}</span>
  );

/** One thing to agree on: where it stands, what it is, its control and its day. */
const Tile = ({
  label,
  description,
  status,
  done,
  control,
  day,
}: {
  label: string;
  description: string;
  status: string;
  done: boolean;
  control: ReactNode;
  day: ReactNode;
}) => (
  <div className="bg-card flex flex-col gap-3 p-5">
    <Status done={done}>{status}</Status>
    <div className="flex flex-1 flex-col gap-0.5">
      <span className="font-medium">{label}</span>
      <p className="text-muted-foreground">{description}</p>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      {control}
      {day}
    </div>
  </div>
);

/** The day an agreement was, once it is in. */
const Day = ({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string | undefined;
  disabled: boolean;
  onChange: (day: string) => void;
}) =>
  value === undefined ? null : (
    <Input
      aria-label={label}
      className="w-40"
      disabled={disabled}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      required
      type="date"
      value={value}
    />
  );

/** The agreements with `on` in place or not, its day today when it comes in. */
const withProcessing = (draft: Agreements, on: boolean): Agreements => {
  const { processingOn: _, ...rest } = draft;
  return on
    ? { ...rest, processing: true, processingOn: draft.processingOn ?? today() }
    : { ...rest, processing: false };
};

const withAssessment = (draft: Agreements, on: boolean): Agreements => {
  const { assessmentOn: _, ...rest } = draft;
  return on
    ? { ...rest, assessment: true, assessmentOn: draft.assessmentOn ?? today() }
    : { ...rest, assessment: false };
};

const withCouncil = (draft: Agreements, council: Council): Agreements => {
  const { councilOn: _, ...rest } = draft;
  return council === "waiting"
    ? { ...rest, council }
    : { ...rest, council, councilOn: draft.councilOn ?? today() };
};

/** Whether `draft` is what is kept. */
const same = (draft: Agreements, kept: Agreements): boolean =>
  draft.processing === kept.processing &&
  draft.processingOn === kept.processingOn &&
  draft.assessment === kept.assessment &&
  draft.assessmentOn === kept.assessmentOn &&
  draft.council === kept.council &&
  draft.councilOn === kept.councilOn;

/** What the links do now, under the tiles. */
const LinksLine = ({ state }: { state: StaffAgreements }) => {
  const { out, waiting } = state;
  if (!state.agreed) {
    return (
      <Status done={false}>
        {plural(waiting, {
          one: "All three in place, or no link goes out: # link waits.",
          other: "All three in place, or no link goes out: # links wait.",
        })}
      </Status>
    );
  }
  return (
    <Status done>
      {plural(out, {
        one: "All in place: # link is out, the rest go by the plan.",
        other: "All in place: # links are out, the rest go by the plan.",
      })}
    </Status>
  );
};

const AgreementsForm = ({ state }: { state: StaffAgreements }) => {
  const { t } = useLingui();
  const router = useRouter();
  const councilId = useId();
  const kept = state.agreements ?? none;
  const [draft, setDraft] = useState(kept);
  const { busy, failure, run } = useCoreAction();
  // Once the team is told the links are out, what was agreed stays agreed.
  const locked = state.told;
  const off = busy || locked;
  const save = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.onboardingStaff.setAgreements(draft);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const councilStatus = {
    agreed: t`Said yes`,
    none: t`No works council`,
    waiting: t`Still deciding`,
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="bg-border grid gap-px border-t lg:grid-cols-3">
        <Tile
          control={
            <Switch
              aria-label={t`Data processing agreement signed`}
              checked={draft.processing}
              disabled={off}
              onCheckedChange={(on) => {
                setDraft(withProcessing(draft, on));
              }}
            />
          }
          day={
            <Day
              disabled={off}
              label={t`Day the data processing agreement was signed`}
              onChange={(day) => {
                setDraft({ ...draft, processingOn: day });
              }}
              value={draft.processingOn}
            />
          }
          description={t`The agreement between the company and Grasp on handling data, signed in the first talk.`}
          done={draft.processing}
          label={t`Data processing agreement`}
          status={
            draft.processing
              ? t({
                  message: "Signed",
                  context: "state of a data processing agreement",
                })
              : t`Not signed yet`
          }
        />
        <Tile
          control={
            <Switch
              aria-label={t`Risk assessment signed off`}
              checked={draft.assessment}
              disabled={off}
              onCheckedChange={(on) => {
                setDraft(withAssessment(draft, on));
              }}
            />
          }
          day={
            <Day
              disabled={off}
              label={t`Day the risk assessment was signed off`}
              onChange={(day) => {
                setDraft({ ...draft, assessmentOn: day });
              }}
              value={draft.assessmentOn}
            />
          }
          description={t`The company's look at the risks to its people, the data protection impact assessment. Grasp brings it filled in, and the company signs it off.`}
          done={draft.assessment}
          label={t`Risk assessment`}
          status={draft.assessment ? t`Signed off` : t`Not signed off yet`}
        />
        <Tile
          control={
            <>
              <label className="sr-only" htmlFor={councilId}>
                <Trans>Works council</Trans>
              </label>
              <NativeSelect
                disabled={off}
                id={councilId}
                onChange={(event) => {
                  const { value } = event.target;
                  if (isCouncil(value)) {
                    setDraft(withCouncil(draft, value));
                  }
                }}
                value={draft.council}
              >
                {councils.map((council) => (
                  <NativeSelectOption key={council} value={council}>
                    {councilStatus[council]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </>
          }
          day={
            <Day
              disabled={off}
              label={t`Day the works council said yes, or it was found there is none`}
              onChange={(day) => {
                setDraft({ ...draft, councilOn: day });
              }}
              value={draft.councilOn}
            />
          }
          description={t`Only the works council can agree to this, not the sponsor. It often takes several weeks.`}
          done={draft.council !== "waiting"}
          label={t`Works council`}
          status={councilStatus[draft.council]}
        />
      </div>
      <div
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-5 py-3"
      >
        <LinksLine state={state} />
        {locked ? (
          <span className="text-muted-foreground">
            <Trans>
              The team is told, so this stays as it was agreed. To stop the
              interviews, pause them.
            </Trans>
          </span>
        ) : (
          <Button disabled={busy || same(draft, kept)} type="submit">
            <Trans>Save the agreements</Trans>
          </Button>
        )}
      </div>
      <div className="px-5 empty:hidden">
        <ErrorText>{failure}</ErrorText>
      </div>
    </form>
  );
};

const AgreementsPage = () => {
  const { t } = useLingui();
  const loaded = Route.useLoaderData();
  if (loaded.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={loaded} />
      </div>
    );
  }
  return (
    <SettingsSection
      description={t`Without all three, nobody is invited: the admin's links wait, and go out once all are in place.`}
      title={t`Agreed before the first interview`}
    >
      <AgreementsForm
        key={JSON.stringify(loaded.data.agreements)}
        state={loaded.data}
      />
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/onboarding/agreements")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.agreements()
    ),
  errorComponent: SettingsError,
  component: AgreementsPage,
});
