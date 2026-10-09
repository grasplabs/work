import type { OnboardingView } from "@grasp-os/shared/onboarding";
import { gateThresholds } from "@grasp-os/shared/onboarding-gate";
import type { GateThreshold, GateView } from "@grasp-os/shared/onboarding-gate";
import { Button } from "@grasp-os/ui/components/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress } from "@grasp-os/ui/components/progress";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  CircleCheckIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useId } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { knownSourceTitles } from "../onboarding/staff-words.ts";
import { SettingsError, SettingsSection } from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The onboarding area's go (GRA-320), as in the prototype
// (`components/admin/stage-open.tsx`): the company's platform stays
// closed until Grasp gives its go, a decision made here on how much of
// what Grasp needs is known against the share it opens at (70, 80 or 90
// percent). Once the interviews are over it can open anyway, and a go
// taken back can be given again; before either, it waits. Opening is
// never automatic. Pausing the interviews is here too: it stops every
// link at once, whatever the agreements say.

const isThreshold = (value: number): value is GateThreshold =>
  gateThresholds.some((each) => each === value);

/** A change to the gate or the interviews, then the page read again. */
const useChange = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const change = async (
    action: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return { busy, failure, change };
};

/** What the gate's state says, under the go. */
const GateLine = ({ gate }: { gate: GateView }) => {
  const { threshold } = gate;
  if (gate.open) {
    if (gate.openedAt === null) {
      return (
        <span className="text-muted-foreground">
          <Trans>
            The platform is open to everyone at the company: it was never closed
            for the onboarding.
          </Trans>
        </span>
      );
    }
    const since = formatDateTime(gate.openedAt);
    return (
      <span className="flex items-center gap-1.5">
        <CircleCheckIcon aria-hidden="true" className="size-4" />
        <Trans>Open since Grasp&apos;s go on {since}.</Trans>
      </span>
    );
  }
  if (gate.known >= threshold) {
    return (
      <span className="text-status-attention">
        <Trans>
          Enough is known: it is past {threshold}%. The company comes in the
          moment Grasp gives its go.
        </Trans>
      </span>
    );
  }
  if (gate.over) {
    return (
      <span className="text-status-attention">
        <Trans>
          The interviews are over and it stayed below {threshold}%. Grasp can
          open it anyway, with what isn&apos;t known shown as still open.
        </Trans>
      </span>
    );
  }
  if (gate.openedAt !== null) {
    return (
      <span className="text-status-attention">
        <Trans>
          Grasp&apos;s go was taken back: only the admins and Grasp&apos;s staff
          come in until it is given again.
        </Trans>
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      <Trans>
        Not enough is known yet. It can open once it is past {threshold}%, or
        once the interviews are over.
      </Trans>
    </span>
  );
};

/** The go, or taking it back: what the gate allows now. */
const GoButton = ({
  gate,
  busy,
  change,
}: {
  gate: GateView;
  busy: boolean;
  change: ReturnType<typeof useChange>["change"];
}) => {
  if (gate.open) {
    return (
      <Button
        disabled={busy}
        onClick={() => {
          void change(async (session) => await session.onboardingGate.close());
        }}
        variant="outline"
      >
        <RotateCcwIcon data-icon="inline-start" />
        {gate.openedAt === null ? (
          <Trans>Close it for the onboarding</Trans>
        ) : (
          <Trans>Take the go back</Trans>
        )}
      </Button>
    );
  }
  const enough = gate.known >= gate.threshold;
  const given = gate.openedAt !== null;
  let label = <Trans>Give the go</Trans>;
  if (!enough && given) {
    label = <Trans>Give the go again</Trans>;
  } else if (!enough && gate.over) {
    label = <Trans>Open it anyway</Trans>;
  }
  return (
    <Button
      disabled={busy || !(gate.ready || given)}
      onClick={() => {
        void change(async (session) => await session.onboardingGate.open());
      }}
    >
      {label}
    </Button>
  );
};

const Go = ({ gate }: { gate: GateView }) => {
  const { t, i18n } = useLingui();
  const thresholdId = useId();
  const { busy, failure, change } = useChange();
  const { known } = gate;
  return (
    <SettingsSection
      description={t`The company's platform stays closed until Grasp gives its go. Closing it signs out everyone but its admins and Grasp's staff.`}
      title={t`Grasp opens`}
    >
      <div className="flex flex-col gap-4 border-t px-5 py-5">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="flex flex-col gap-1">
            <span className="text-2xl leading-none font-medium tabular-nums">
              {known}%
            </span>
            <span className="text-muted-foreground">
              <Trans>of what Grasp needs is known</Trans>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={thresholdId}>
              <Trans>How much has to be known before it opens</Trans>
            </label>
            <NativeSelect
              disabled={busy || gate.open}
              id={thresholdId}
              onChange={(event) => {
                const threshold = Number(event.target.value);
                if (isThreshold(threshold)) {
                  void change(
                    async (session) =>
                      await session.onboardingGate.setThreshold(threshold)
                  );
                }
              }}
              value={String(gate.threshold)}
            >
              {gateThresholds.map((threshold) => (
                <NativeSelectOption key={threshold} value={String(threshold)}>
                  {t`Opens at ${threshold}%`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <GoButton busy={busy} change={change} gate={gate} />
          </div>
        </div>
        <div aria-live="polite">
          <GateLine gate={gate} />
        </div>
        <ErrorText>{failure}</ErrorText>
      </div>
      <div className="flex flex-col gap-0.5 border-t px-5 py-4">
        <span className="font-medium">
          <Trans>Where it comes from</Trans>
        </span>
        <p className="text-muted-foreground">
          <Trans>
            Every source adds its own share, and only once it is in.
          </Trans>
        </p>
      </div>
      <ul className="flex flex-col">
        {gate.parts.map((part) => {
          const label = i18n._(knownSourceTitles[part.source]);
          const points = Math.round(part.known * part.weight);
          const { weight } = part;
          return (
            <li
              className="grid items-center gap-x-6 gap-y-1.5 border-t px-5 py-2.5 sm:grid-cols-3"
              key={part.source}
            >
              <span className="min-w-0">{label}</span>
              <Progress aria-label={label} value={part.known * 100} />
              <span className="text-muted-foreground tabular-nums sm:text-right">
                <Trans>
                  {points} of {weight}
                </Trans>
              </span>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
};

/** Pausing the interviews, and letting them run again. */
const Interviews = ({ onboarding }: { onboarding: OnboardingView }) => {
  const { t } = useLingui();
  const { busy, failure, change } = useChange();
  const { paused } = onboarding;
  return (
    <SettingsSection
      action={
        <Button
          disabled={busy}
          onClick={() => {
            void change(async (session) => {
              await (paused
                ? session.onboardingStaff.resume()
                : session.onboardingStaff.pause());
            });
          }}
          size="sm"
          variant="outline"
        >
          {paused ? (
            <>
              <PlayIcon data-icon="inline-start" />
              <Trans>Let the interviews run again</Trans>
            </>
          ) : (
            <>
              <PauseIcon data-icon="inline-start" />
              <Trans>Pause the interviews</Trans>
            </>
          )}
        </Button>
      }
      description={
        paused
          ? t`Paused: no link opens and none goes out. The links that are due go out once they run again.`
          : t`While paused, no link opens and none goes out, whatever was agreed.`
      }
      title={t`The interviews`}
    >
      {failure === undefined ? null : (
        <div className="border-t px-5 py-3">
          <ErrorText>{failure}</ErrorText>
        </div>
      )}
    </SettingsSection>
  );
};

const Open = () => {
  const loaded = Route.useLoaderData();
  if (loaded.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={loaded} />
      </div>
    );
  }
  return (
    <>
      <Go gate={loaded.data.gate} />
      <Interviews onboarding={loaded.data.onboarding} />
    </>
  );
};

export const Route = createFileRoute("/_shell/onboarding/open")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [gate, onboarding] = await Promise.all([
        session.onboardingGate.view(),
        session.onboarding.view(),
      ]);
      return { gate, onboarding };
    }),
  errorComponent: SettingsError,
  component: Open,
});
