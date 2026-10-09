import type {
  StaffNeed,
  StaffStage,
  StageView,
} from "@grasp-os/shared/onboarding-staff";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { needText, stageTitles, todoText } from "../onboarding/staff-words.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// The onboarding area's overview (prototype `org-home.tsx`,
// `org-steps.tsx`): what needs Grasp, the most pressing first, then the
// stages, each a list of what it asks for, ticked off as it is done.
// Each stage and need that a section of the area deals with links to it;
// the people, the leads and the interviews are the company admin's.

type Section =
  | "/onboarding/kickoff"
  | "/onboarding/agreements"
  | "/onboarding/open";

/** Where the area deals with each stage, when it does. */
const stageSections: Partial<Record<StaffStage, Section>> = {
  kickoff: "/onboarding/kickoff",
  agreements: "/onboarding/agreements",
  open: "/onboarding/open",
};

/** Where the area deals with a need, when it does. */
const needSection = (need: StaffNeed): Section | undefined => {
  if (need.kind === "agreement") {
    return "/onboarding/agreements";
  }
  return need.kind === "lead" ? undefined : "/onboarding/open";
};

const linkClass = "underline-offset-4 hover:underline";

const statusIcon = {
  done: CircleCheckIcon,
  now: CircleDotIcon,
  later: CircleIcon,
} as const;

const Needs = ({ needs }: { needs: StaffNeed[] }) => {
  const { t, i18n } = useLingui();
  return (
    <SettingsSection
      description={t`The most pressing first.`}
      title={t`What needs Grasp`}
    >
      <SettingsBody>
        {needs.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>Nothing needs Grasp right now.</Trans>
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {needs.map((need) => {
              const to = needSection(need);
              const text = needText(i18n, need);
              return (
                <li
                  className="flex items-start gap-2"
                  key={JSON.stringify(need)}
                >
                  <span
                    aria-hidden="true"
                    className="bg-status-attention mt-1.5 size-1.5 flex-none rounded-full"
                  />
                  {to === undefined ? (
                    text
                  ) : (
                    <Link className={linkClass} to={to}>
                      {text}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </SettingsBody>
    </SettingsSection>
  );
};

const Stage = ({ stage }: { stage: StageView }) => {
  const { t, i18n } = useLingui();
  const Icon = statusIcon[stage.status];
  const title = i18n._(stageTitles[stage.stage]);
  const to = stageSections[stage.stage];
  const statusLabel = {
    done: t({ message: "done", context: "onboarding stage status" }),
    now: t({ message: "now", context: "onboarding stage status" }),
    later: t({ message: "later", context: "onboarding stage status" }),
  }[stage.status];
  return (
    <li className="flex flex-col gap-2 border-t px-5 py-4">
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className={
            stage.status === "later" ? "text-muted-foreground size-4" : "size-4"
          }
        />
        <h3 className="font-medium">
          {to === undefined ? (
            title
          ) : (
            <Link className={linkClass} to={to}>
              {title}
            </Link>
          )}
        </h3>
        <span className="text-muted-foreground text-xs">{statusLabel}</span>
      </div>
      <ul className="flex flex-col gap-1 pl-6">
        {stage.todos.map((todo) => (
          <li className="flex items-center gap-2" key={todo.kind}>
            <input
              aria-label={todoText(i18n, todo)}
              checked={todo.done}
              className="accent-primary"
              readOnly
              type="checkbox"
            />
            <span className={todo.done ? "text-muted-foreground" : undefined}>
              {todoText(i18n, todo)}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
};

const Overview = () => {
  const { t } = useLingui();
  const overview = Route.useLoaderData();
  if (overview.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={overview} />
      </div>
    );
  }
  const { needs, stages } = overview.data;
  return (
    <>
      <Needs needs={needs} />
      <SettingsSection
        description={t`Where the onboarding stands, stage by stage.`}
        title={t`Stages`}
      >
        <ol>
          {stages.map((stage) => (
            <Stage key={stage.stage} stage={stage} />
          ))}
        </ol>
      </SettingsSection>
    </>
  );
};

export const Route = createFileRoute("/_shell/onboarding/")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.overview()
    ),
  errorComponent: SettingsError,
  component: Overview,
});
