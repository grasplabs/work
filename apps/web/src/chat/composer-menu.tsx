import { Button } from "@grasp-os/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@grasp-os/ui/components/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import type { PromptSuggestion } from "@grasp-os/ui/components/prompt-editor";
import { PromptInputButton } from "@grasp-os/ui/components/prompt-input";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ArrowLeftIcon,
  AtSignIcon,
  ChevronRightIcon,
  MousePointerClickIcon,
  PaperclipIcon,
  PlusIcon,
  SquareSlashIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { FilePicker } from "./chat-files.tsx";
import { useMentionables, useMentionKinds } from "./mentions.tsx";

// The composer's add menu, behind its "+": files or photos for the
// question, what to point Grasp at on the page (Target, to come), someone
// or something to mention, and the commands to run. Mention and Commands
// open in its place, each with a way back and a search, as one list a
// keyboard moves through.

type View = "menu" | "mention" | "commands";

/** A row that opens a list in the menu's place. */
const OpensList = ({
  icon,
  onOpen,
  children,
}: {
  icon: ReactNode;
  onOpen: () => void;
  children: ReactNode;
}) => (
  <CommandItem check={false} onSelect={onOpen}>
    {icon}
    {children}
    <ChevronRightIcon className="text-muted-foreground ml-auto" />
  </CommandItem>
);

/** The search of a list opened in the menu's place, with the way back to the menu. */
const ListSearch = ({
  placeholder,
  onBack,
}: {
  placeholder: string;
  onBack: () => void;
}) => {
  const { t } = useLingui();
  return (
    <CommandInput
      autoFocus
      placeholder={placeholder}
      start={
        <Button
          aria-label={t`Back`}
          className="-ml-1.5"
          onClick={onBack}
          size="icon-xs"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
      }
    />
  );
};

/**
 * Someone or something to mention, by kind, as the box's `@` lists them
 * (mentions.tsx): the person's Apps and workflows, and the organization's
 * people.
 */
const MentionList = ({
  onMention,
}: {
  onMention: (mentioned: PromptSuggestion) => void;
}) => {
  const { t } = useLingui();
  const found = useMentionables();
  const kinds = useMentionKinds();
  if (found === undefined) {
    return (
      <div className="flex justify-center py-6">
        <Spinner aria-label={t`Loading…`} />
      </div>
    );
  }
  return (
    <>
      <CommandEmpty>
        <Trans>Nothing found</Trans>
      </CommandEmpty>
      {Object.entries(kinds).map(([kind, shown]) => {
        const listed = found.filter((each) => each.kind === kind);
        return listed.length === 0 ? null : (
          <CommandGroup heading={shown.label} key={kind}>
            {listed.map((mentioned) => (
              <CommandItem
                check={false}
                key={mentioned.id}
                onSelect={() => {
                  onMention(mentioned);
                }}
                value={`${shown.label} ${mentioned.label} ${mentioned.id}`}
              >
                {shown.icon}
                <span className="truncate">{mentioned.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        );
      })}
    </>
  );
};

/** A command a question can run, as it will be programmed in. */
interface ComposerCommand {
  id: string;
  name: string;
}

/** The commands there are: none yet. */
const commands: readonly ComposerCommand[] = [];

/** The commands a question can run, by name. */
const CommandsList = ({ onRun }: { onRun: (name: string) => void }) => (
  <>
    <CommandEmpty>
      {commands.length === 0 ? (
        <Trans>No commands yet</Trans>
      ) : (
        <Trans>Nothing found</Trans>
      )}
    </CommandEmpty>
    {commands.length === 0 ? null : (
      <CommandGroup>
        {commands
          .toSorted((one, other) => one.name.localeCompare(other.name))
          .map(({ id, name }) => (
            <CommandItem
              check={false}
              key={id}
              onSelect={() => {
                onRun(name);
              }}
              value={`${name} ${id}`}
            >
              <SquareSlashIcon />
              <span className="truncate">{name}</span>
            </CommandItem>
          ))}
      </CommandGroup>
    )}
  </>
);

/** The "+" beside the send button and what it adds to the question. */
export const ComposerMenu = ({
  onAttach,
  onMention,
  disabled,
  trigger,
}: {
  /** Adds files to the question; without it, the menu offers none. */
  onAttach: ((files: readonly File[]) => void) | undefined;
  /**
   * Adds a mention to the question, where the cursor is, typed after
   * `trigger`: `@` and what was picked, or `/` and a command.
   */
  onMention: (mentioned: PromptSuggestion, trigger: string) => void;
  disabled: boolean;
  /** The button that opens it, where a box has its own (the chat bar's). */
  trigger?: ReactElement;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const picker = useRef<HTMLInputElement>(null);
  // The menu takes the keys as it opens and as the person comes back to
  // it, for its arrows and Enter; a list in its place gives them to its
  // search.
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && view === "menu") {
      menu.current?.focus();
    }
  }, [open, view]);
  const close = (): void => {
    setOpen(false);
  };
  const toMenu = (): void => {
    setView("menu");
  };
  return (
    <>
      {onAttach === undefined ? null : (
        <FilePicker onAttach={onAttach} ref={picker} />
      )}
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          // It opens on the menu again.
          if (!next) {
            toMenu();
          }
        }}
        open={open}
      >
        <PopoverTrigger
          render={
            trigger ?? (
              <PromptInputButton disabled={disabled} tooltip={t`Add`} />
            )
          }
        >
          <PlusIcon />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72"
          initialFocus={menu}
          variant="flush"
        >
          {/* A new list for each view, so its search starts empty. */}
          <Command key={view} loop ref={menu} tabIndex={-1}>
            {view === "menu" ? null : (
              <ListSearch
                onBack={toMenu}
                placeholder={
                  view === "mention"
                    ? t`Search Apps, people and workflows`
                    : t`Search commands`
                }
              />
            )}
            <CommandList>
              {view === "menu" ? (
                <CommandGroup>
                  {onAttach === undefined ? null : (
                    <CommandItem
                      check={false}
                      onSelect={() => {
                        close();
                        picker.current?.click();
                      }}
                    >
                      <PaperclipIcon />
                      <Trans>Add files or photos</Trans>
                    </CommandItem>
                  )}
                  <CommandItem check={false} disabled>
                    <MousePointerClickIcon />
                    <Trans>Target</Trans>
                    <CommandShortcut>
                      <Trans context="a feature still to come">Soon</Trans>
                    </CommandShortcut>
                  </CommandItem>
                  <OpensList
                    icon={<AtSignIcon />}
                    onOpen={() => {
                      setView("mention");
                    }}
                  >
                    <Trans>Mention</Trans>
                  </OpensList>
                  <OpensList
                    icon={<SquareSlashIcon />}
                    onOpen={() => {
                      setView("commands");
                    }}
                  >
                    <Trans>Commands</Trans>
                  </OpensList>
                </CommandGroup>
              ) : null}
              {view === "mention" ? (
                <MentionList
                  onMention={(mentioned) => {
                    close();
                    onMention(mentioned, "@");
                  }}
                />
              ) : null}
              {view === "commands" ? (
                <CommandsList
                  onRun={(name) => {
                    close();
                    onMention({ kind: "command", id: name, label: name }, "/");
                  }}
                />
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
};
