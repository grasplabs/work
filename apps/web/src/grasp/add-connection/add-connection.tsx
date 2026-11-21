// Add connection: adding one of many providers, after Capy's "Add a connection" sheet. A trigger opens
// a wide sheet along the end: its title and close, a search field, then the providers in groups
// (the groups are data), two tiles to a row, one on a phone. Each tile is the provider's mark in its
// square, its name and its host, muted. A tile already connected ends in a quiet "Add another"; a
// tile that opens the key step ends in a chevron. Choosing one moves the sheet to its key step: back,
// the tile as its head, the key (masked, show and hide, Paste), a name if `nameField`, the link to where
// keys are made, and Cancel and Connect. The host checks the key: `onConnect` resolves, and the step
// says it connected, or rejects, and the key is cleared and the reason stands under it.
//
//   <AddConnection groups={groups} onConnect={async ({ provider, key, name }) => { await core.add(provider, key, name); }} />
//
// Every word is a prop (`words`, or GraspWords' `addConnection`). Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useLayoutEffect, useRef, useState } from "react";

import type { ButtonSize, ButtonVariant } from "../button";
import { Plus } from "../icons";
import type { IconData } from "../icons";
import { simply } from "../motion/simply.stylex";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "../sheet";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { KeyStep, readClipboard, StepFoot } from "./key-step";
import type { KeyStepValues } from "./key-step";
import type {
  AddConnectionChoice,
  AddConnectionGroup,
  AddConnectionProvider,
  AddConnectionStatus,
} from "./model";
import { ConnectionSearch, ConnectionTiles, TILE } from "./tiles";
import { addConnectionWords } from "./words";
import type { AddConnectionWords } from "./words";

/** Every prop an AddConnection takes. */
export interface AddConnectionProps {
  /** The providers, in groups under their headings ("API keys"), in order. */
  groups: readonly AddConnectionGroup[];
  /**
   * Checks and adds the key. Resolve when it works; reject with an Error whose message is the
   * provider's reason, or with nothing for "That key didn't work".
   */
  onConnect: (choice: AddConnectionChoice) => Promise<void>;
  /** A tile with `opens="host"` was chosen: the sheet closes, and the host opens its own way in. */
  onSelect?: (provider: string) => void;
  /** Open now. Pass it with `onOpenChange` to open and close the sheet yourself. */
  open?: boolean;
  /** Open when the page loads. @default false */
  defaultOpen?: boolean;
  /** Runs when the sheet opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** The trigger's look: `quiet` beside other buttons, `ink` as the page's one step. @default "quiet" */
  variant?: ButtonVariant;
  /** The trigger's height: `xs` in a card's head, `sm` on a page. @default "sm" */
  size?: ButtonSize;
  /** The trigger's icon, before its words. @default Plus */
  icon?: IconData;
  /** Any of the words, in place of the English ones. */
  words?: Partial<AddConnectionWords>;
  /** Ask for an optional name for the key, handed to `onConnect`. Give it only where the host keeps the name. @default false */
  nameField?: boolean;
}

const arrive = stylex.keyframes({
  from: { opacity: 0, transform: `translateY(${grasp.space1})` },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  // The panel's own column: the search, the body and the foot one under another.
  contents: { display: "contents" },
  // A view arriving: a short fade up, within the ui time, at once with reduced motion.
  view: {
    animationName: { default: arrive, [media.reduced]: "none" },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
  },
});

const empty: KeyStepValues = { key: "", name: "", address: "" };

/** Runs the host's connect: null when it worked, else what it threw. */
const attempt = async (
  onConnect: AddConnectionProps["onConnect"],
  choice: AddConnectionChoice
): Promise<unknown> => {
  try {
    await onConnect(choice);
  } catch (error) {
    return error ?? false;
  }
  return null;
};

/** A refusal's words: the provider's reason, or the component's own. */
const reasonOf = (refusal: unknown, fallback: string) =>
  refusal instanceof Error && refusal.message !== ""
    ? refusal.message
    : fallback;

/** Focuses what `selector` finds in the sheet once the next view is drawn. */
const focusLater = (box: HTMLElement | null, selector: string) => {
  requestAnimationFrame(() => {
    box?.parentElement?.querySelector<HTMLElement>(selector)?.focus();
  });
};

/** Each provider by its id, across the groups. */
const findProvider = (
  groups: readonly AddConnectionGroup[],
  id: string | null
) =>
  id === null
    ? undefined
    : groups
        .flatMap((group) => group.providers)
        .find((provider) => provider.id === id);

/** The sheet of providers, and the key step that follows a tile. */
export const AddConnection = ({
  groups,
  onConnect,
  onSelect,
  open: openGiven,
  defaultOpen = false,
  onOpenChange,
  variant = "quiet",
  size = "sm",
  icon = Plus,
  words: given,
  nameField = false,
}: AddConnectionProps) => {
  const words = useWords("addConnection", addConnectionWords, given);
  const formId = useId();
  const [openOwn, setOpenOwn] = useState(defaultOpen);
  const open = openGiven ?? openOwn;
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [values, setValues] = useState(empty);
  const [revealed, setRevealed] = useState(false);
  const [status, setStatus] = useState<AddConnectionStatus>("idle");
  const [refusal, setRefusal] = useState("");
  // Each opening and each provider's step is its own: a connect or a paste that resolves after the
  // sheet closed, opened again or moved to another provider is dropped, so it cannot fill another step.
  const [step, setStep] = useState(() => ({}));
  const live = useRef({ step, values });
  useLayoutEffect(() => {
    live.current = { step, values };
  }, [step, values]);
  // Each opening starts at the tiles, the search empty.
  const [seen, setSeen] = useState(open);
  if (seen !== open) {
    setSeen(open);
    setStep({});
    if (open) {
      setQuery("");
      setChosen(null);
      setValues(empty);
      setRevealed(false);
      setStatus("idle");
    }
  }
  const box = useRef<HTMLDivElement>(null);
  const provider = findProvider(groups, chosen);
  const view =
    provider === undefined
      ? "tiles"
      : `${provider.id}:${status === "done" ? "done" : "form"}`;
  const setOpen = (next: boolean) => {
    setOpenOwn(next);
    onOpenChange?.(next);
  };
  const choose = (picked: AddConnectionProvider) => {
    if ((picked.opens ?? "key") === "host") {
      onSelect?.(picked.id);
      setOpen(false);
      return;
    }
    setValues(empty);
    setRevealed(false);
    setStatus("idle");
    setChosen(picked.id);
    setStep({});
    focusLater(box.current, "[data-first]");
  };
  const back = () => {
    if (chosen !== null) {
      focusLater(
        box.current,
        `[data-provider="${CSS.escape(chosen)}"] ${TILE}`
      );
    }
    setChosen(null);
    setStatus("idle");
    setValues(empty);
    setStep({});
  };
  const connect = async () => {
    if (provider === undefined) {
      return;
    }
    setStatus("working");
    const refused = await attempt(onConnect, {
      provider: provider.id,
      key: values.key,
      name: values.name.trim(),
      ...(provider.address === true ? { address: values.address } : {}),
    });
    if (live.current.step !== step) {
      return;
    }
    if (refused === null) {
      setValues(empty);
      setStatus("done");
      focusLater(box.current, "[data-done]");
      return;
    }
    // The reason under the key, and the key cleared and focused: a secret that did not work is not kept.
    focusLater(box.current, "[data-first]");
    setRefusal(reasonOf(refused, words.refused));
    setValues({ ...values, key: "" });
    setStatus("refused");
  };
  const paste = async () => {
    const clip = await readClipboard();
    // A permission prompt can stand a while: what changed under it wins over the clipboard.
    if (live.current.step !== step || live.current.values !== values) {
      return;
    }
    if (clip !== null && clip.trim() !== "") {
      setValues({ ...values, key: clip.trim() });
      setStatus("idle");
    }
    // The field takes the focus either way: a refused clipboard leaves the keys to paste.
    focusLater(box.current, "[data-first]");
  };
  return (
    <Sheet
      size="lg"
      open={open}
      onOpenChange={setOpen}
      dismissible={status !== "working"}
    >
      <SheetTrigger variant={variant} size={size} icon={icon}>
        {words.trigger}
      </SheetTrigger>
      <SheetContent words={{ close: words.close }}>
        <SheetTitle>{words.title}</SheetTitle>
        <div
          ref={box}
          data-slot="add-connection"
          {...stylex.props(styles.contents)}
        >
          {provider === undefined && (
            <ConnectionSearch
              query={query}
              onQueryChange={setQuery}
              words={words}
            />
          )}
          <SheetBody>
            <div key={view} {...stylex.props(styles.view)}>
              {provider === undefined ? (
                <ConnectionTiles
                  groups={groups}
                  query={query}
                  onChoose={choose}
                  words={words}
                />
              ) : (
                <KeyStep
                  provider={provider}
                  nameField={nameField}
                  values={values}
                  onValues={(next) => {
                    setValues(next);
                    if (status === "refused") {
                      setStatus("idle");
                    }
                  }}
                  status={status}
                  refusal={refusal}
                  revealed={revealed}
                  onReveal={() => {
                    setRevealed(!revealed);
                  }}
                  onPaste={() => {
                    void paste();
                  }}
                  onBack={back}
                  onSubmit={() => {
                    void connect();
                  }}
                  formId={formId}
                  words={words}
                />
              )}
            </div>
          </SheetBody>
          {provider !== undefined && (
            <StepFoot status={status} formId={formId} words={words} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
