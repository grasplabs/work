import { interviewLocales } from "@grasp-os/shared/onboarding";
import {
  stephenLimitMaxLength,
  stephenTermMaxLength,
} from "@grasp-os/shared/onboarding-staff";
import type {
  StephenSetup,
  StephenSetupView,
} from "@grasp-os/shared/onboarding-staff";
import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { localeNames } from "../i18n.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { SettingsError, SettingsSection } from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The onboarding area's Stephen (GRA-320), as in the prototype's "How he
// is set up" (`components/admin/org-stephen.tsx`): for this deployment,
// the languages he interviews in, what he leaves alone, and the words he
// has to know. Until staff change it, it is what the kickoff suggests;
// every change holds from the next interview turn on, and the kickoff's
// suggestion is one click away.

const spaces = /\s+/gu;

/** A list of lines to keep: each can go, and one can be added. */
const Lines = ({
  label,
  description,
  add,
  items,
  longest,
  short = false,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  add: string;
  items: string[];
  longest: number;
  short?: boolean;
  disabled: boolean;
  onChange: (items: string[]) => void;
}) => {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const next = draft.replaceAll(spaces, " ").trim();
  const keep = (): void => {
    if (next === "" || items.includes(next)) {
      return;
    }
    onChange([...items, next]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <span>{label}</span>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {items.length > 0 ? (
        <ul
          aria-label={label}
          className={short ? "flex flex-wrap gap-1.5" : "flex flex-col gap-1.5"}
        >
          {items.map((item) => (
            <li
              className="bg-card flex min-w-0 items-center justify-between gap-1 rounded-md border py-0.5 pr-0.5 pl-2.5"
              key={item}
            >
              <span className="min-w-0">{item}</span>
              <Button
                aria-label={t`Remove: ${item}`}
                disabled={disabled}
                onClick={() => {
                  onChange(items.filter((each) => each !== item));
                }}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="max-w-lg"
        onSubmit={(event) => {
          event.preventDefault();
          keep();
        }}
      >
        <InputGroup>
          <InputGroupInput
            aria-label={add}
            disabled={disabled}
            maxLength={longest}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder={add}
            value={draft}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={add}
              disabled={disabled || next === "" || items.includes(next)}
              size="icon-xs"
              type="submit"
            >
              <PlusIcon />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
};

/** What the kickoff said of something, to set him by; nothing when it said nothing. */
const Said = ({ text }: { text: string | null }) =>
  text === null ? null : (
    <p className="text-muted-foreground">
      <Trans>The kickoff said: {text}</Trans>
    </p>
  );

const Setup = ({ view }: { view: StephenSetupView }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { setup } = view;
  const save = async (next: StephenSetup | null): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.onboardingStaff.saveStephen(next);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const languagesLabel = t`Languages he interviews in`;
  return (
    <SettingsSection
      action={
        <Button
          disabled={busy || !view.changed}
          onClick={() => {
            void save(null);
          }}
          size="sm"
          variant="ghost"
        >
          <RotateCcwIcon data-icon="inline-start" />
          <span className="max-sm:sr-only">
            <Trans>As the kickoff suggests</Trans>
          </span>
        </Button>
      }
      description={t`From the kickoff with the sponsor. What is changed here holds from the next interview turn on.`}
      title={t`How Stephen is set up here`}
    >
      <div className="flex flex-col gap-3 border-t px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span>{languagesLabel}</span>
          <p className="text-muted-foreground">
            <Trans>
              Someone chooses their own language when they open their link.
            </Trans>
          </p>
          <Said text={view.kickoff.languages} />
        </div>
        <ToggleGroup
          aria-label={languagesLabel}
          className="flex-wrap"
          disabled={busy}
          multiple
          onValueChange={(chosen: string[]) => {
            const languages = interviewLocales.filter((locale) =>
              chosen.includes(locale)
            );
            // He always speaks at least one language.
            if (languages.length > 0) {
              void save({ ...setup, languages });
            }
          }}
          size="sm"
          value={setup.languages}
          variant="outline"
        >
          {interviewLocales.map((locale) => (
            <ToggleGroupItem key={locale} lang={locale} value={locale}>
              {localeNames[locale]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <Lines
        add={t`Add something he leaves alone`}
        description={t`He doesn't ask about it, and moves on when somebody brings it up.`}
        disabled={busy}
        items={setup.limits}
        label={t`What he leaves alone`}
        longest={stephenLimitMaxLength}
        onChange={(limits) => {
          void save({ ...setup, limits });
        }}
      />
      <Lines
        add={t`Add a word`}
        description={t`Tools, products and the company's own words, so he hears them right.`}
        disabled={busy}
        items={setup.terms}
        label={t`Words he has to know`}
        longest={stephenTermMaxLength}
        onChange={(terms) => {
          void save({ ...setup, terms });
        }}
        short
      />
      {view.kickoff.systems === null ? null : (
        <div className="border-t px-5 py-3">
          <Said text={view.kickoff.systems} />
        </div>
      )}
      <div className="px-5 empty:hidden">
        <ErrorText>{failure}</ErrorText>
      </div>
    </SettingsSection>
  );
};

const Stephen = () => {
  const loaded = Route.useLoaderData();
  if (loaded.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={loaded} />
      </div>
    );
  }
  return <Setup view={loaded.data} />;
};

export const Route = createFileRoute("/_shell/onboarding/stephen")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.stephen()
    ),
  errorComponent: SettingsError,
  component: Stephen,
});
