import { useLingui } from "@lingui/react/macro";

import type { Ability, Audience, Effort, Frequency } from "./model.ts";

// The words New agent's setup says its choices in, shared by the step that
// asks each one and the last step that sums them up.

export const useSetupWords = () => {
  const { t } = useLingui();
  const effortNames: Record<Effort, string> = {
    low: t`Low`,
    medium: t`Medium`,
    high: t`High`,
    extra: t`Extra high`,
    max: t`Max`,
  };
  const frequencyNames: Record<Frequency, string> = {
    asked: t`Only when someone asks`,
    daily: t`Every day`,
    weekly: t`Every week`,
    monthly: t`Every month`,
  };
  const audienceNames: Record<Audience, string> = {
    me: t`Just me`,
    teams: t`Some teams`,
    everyone: t`Everyone`,
  };
  const abilityNames: Record<Ability, { label: string; info: string }> = {
    web: { label: t`Search the web`, info: t`Looks things up online.` },
    workflows: {
      label: t`Start workflows`,
      info: t`Runs your company's workflows.`,
    },
    apps: { label: t`Use Apps`, info: t`Works in your company's Apps.` },
    read: {
      label: t`Read mail, calendars and files`,
      info: t`Only what your company allows.`,
    },
    change: {
      label: t`Write mail, events and files`,
      info: t`Asks you first, every time.`,
    },
    reach: {
      label: t`Message other people`,
      info: t`Asks you first, every time.`,
    },
  };
  return { effortNames, frequencyNames, audienceNames, abilityNames };
};
