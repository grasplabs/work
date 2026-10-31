import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@grasp-os/ui/components/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { beyond, find, kindOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";

// Adding an app to the Landscape, as the prototype's dialog does
// (`components/landscape/add-app-dialog.tsx`): pick it from the catalog,
// or name one the catalog doesn't have. Grasp knows an app once it is
// connected, so an app from the catalog opens its page, where it is
// connected; one the catalog doesn't have is asked for, as on
// Integrations.

/** How many of the catalog's apps the list shows: the closest matches. */
const shownMost = 8;

/** Fewest characters typed before an app the catalog doesn't have is offered. */
const shortestName = 2;

export const AddAppDialog = ({
  integrations,
  open,
  onOpenChange,
  onRequest,
}: {
  /** Every integration, the catalog's and the company's own. */
  integrations: readonly Integration[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Asks Grasp for an app the catalog doesn't have, by its name. */
  onRequest: (name: string) => void;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const found = find(beyond(integrations), typed).slice(0, shownMost);
  // An app the catalog has under exactly that name is never asked for.
  const named = integrations.some(
    ({ name }) => name.toLocaleLowerCase() === typed.toLocaleLowerCase()
  );
  const close = (): void => {
    onOpenChange(false);
    setQuery("");
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
        } else {
          close();
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add an app</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Which app should Grasp start tracking? Grasp knows an app once it
              is connected, so one from the catalog opens where you connect it.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-hidden rounded-lg border">
          {/* The catalog holds some 1,500 apps: the list is narrowed here, not by the menu. */}
          <Command shouldFilter={false}>
            <CommandInput
              aria-label={t`Search the catalog`}
              onValueChange={setQuery}
              placeholder={t`Search the catalog`}
              value={query}
            />
            <CommandList>
              {/* Only once something is typed: an empty box matches nothing yet. */}
              {typed === "" ? null : (
                <CommandEmpty>
                  <Trans>Nothing in the catalog matches “{typed}”.</Trans>
                </CommandEmpty>
              )}
              {found.length === 0 ? null : (
                <CommandGroup
                  heading={
                    typed === ""
                      ? t`Popular in the catalog`
                      : t`From the catalog`
                  }
                >
                  {found.map((integration) => (
                    <CommandItem
                      key={integration.key}
                      onSelect={() => {
                        close();
                        void navigate({
                          to: "/integrations/$integration",
                          params: { integration: integration.key },
                        });
                      }}
                      value={integration.key}
                    >
                      <AppLogo
                        logo={integration.logo}
                        name={integration.name}
                        size="sm"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{integration.name}</span>
                        <span className="text-muted-foreground truncate">
                          {kindOf(integration)}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {typed.length < shortestName || named ? null : (
                <CommandGroup heading={t`Not in the catalog`}>
                  <CommandItem
                    onSelect={() => {
                      close();
                      onRequest(typed);
                    }}
                    value={`request:${typed}`}
                  >
                    <PlusIcon />
                    <Trans>Ask Grasp to add “{typed}”</Trans>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </div>
      </DialogContent>
    </Dialog>
  );
};
