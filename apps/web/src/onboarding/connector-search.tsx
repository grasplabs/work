import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@grasp-os/ui/components/command";
import type { CommandItemData } from "@grasp-os/ui/components/command";
import { PlusIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { find } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";

// "Something else" on the documents step, and "Another platform" on the HR
// step: a search over the apps Grasp connects through Integrations
// (Composio's toolkits and Grasp's own), over the page, instead of a field
// that opened in its tile and pushed the grid about (Ruben: "it should just
// open a search modal from all our composio connectors"). A name the
// catalog doesn't hold is still asked for, as the last row, as typed.

/**
 * One row an app: the catalog can hold one twice (Grasp's own and Composio's Linear), and the
 * search shows it once, as the one with a logo where only one has, in the first one's place.
 */
const oncePerName = (all: readonly Integration[]): Integration[] => {
  const kept = new Map<string, Integration>();
  for (const each of all) {
    const name = each.name.toLocaleLowerCase();
    const first = kept.get(name);
    if (first === undefined || (first.logo === null && each.logo !== null)) {
      kept.set(name, each);
    }
  }
  return [...kept.values()];
};

/** The value of the row that asks for what was typed. */
const askValue = "ask";

export const ConnectorSearch = ({
  open,
  onOpenChange,
  integrations,
  onPick,
  onAsk,
  placeholder,
}: {
  /** The search field's words, with an example of what to look for. */
  placeholder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrations: readonly Integration[];
  /** One of the catalog's apps was chosen. */
  onPick: (integration: Integration) => Promise<void>;
  /** A name the catalog doesn't hold, asked for as typed. */
  onAsk: (name: string) => Promise<void>;
}) => {
  const { t } = useLingui();
  const [typed, setTyped] = useState("");
  const offered = oncePerName(
    find(integrations.filter((each) => each.offered))
  );
  const byKey = new Map(offered.map((each) => [each.key, each]));
  const name = typed.trim();
  const held = offered.some(
    (each) => each.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  const items: CommandItemData[] = offered.map((integration) => ({
    value: integration.key,
    label: integration.name,
    keywords: [integration.id, ...integration.categories],
    media: (
      <AppLogo logo={integration.logo} name={integration.name} size="xs" />
    ),
  }));
  if (name !== "" && !held) {
    items.push({
      value: askValue,
      label: t`Ask for “${name}”`,
      // Always found by what was typed, whatever its words become in another language.
      keywords: [name],
      icon: PlusIcon,
    });
  }
  return (
    <CommandDialog
      aria-label={t`Search apps`}
      inputValue={typed}
      items={items}
      onAction={async (value) => {
        if (value === askValue) {
          await onAsk(name);
        } else {
          const integration = byKey.get(value);
          if (integration !== undefined) {
            await onPick(integration);
          }
        }
        setTyped("");
      }}
      onInputValueChange={setTyped}
      onOpenChange={(next) => {
        if (!next) {
          setTyped("");
        }
        onOpenChange(next);
      }}
      open={open}
      shortcut={null}
      size="large"
      trigger={null}
    >
      <CommandInput aria-label={t`Search apps`} placeholder={placeholder} />
      <CommandEmpty>{t`Nothing matches. Type its name to ask for it.`}</CommandEmpty>
      <CommandList />
    </CommandDialog>
  );
};
