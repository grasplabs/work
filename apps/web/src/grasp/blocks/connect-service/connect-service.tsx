"use client";

import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
} from "../../alert-dialog";
import { BrandIcon } from "../../brand-icon";
import type { Brand } from "../../brand-icon";
import { Button } from "../../button";
import { DropdownMenuMore } from "../../dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "../../field";
import { Flag } from "../../flags";
import type { FlagData } from "../../flags";
import { Form, FormActions } from "../../form";
import { IconTile } from "../../icon-tile";
import { Plus, Web } from "../../icons";
import { Input, SecretInput } from "../../input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../../item";
import { SectionCard } from "../../section-card";
import { Text } from "../../text";
import { grasp, media } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";

/** One service to connect: its name, its mark, where it runs and its key's shape. */
export interface ConnectServiceOption {
  /** A short, lasting id ("anthropic"). */
  id: string;
  /** Its name ("Anthropic"). */
  name: string;
  /** Its mark from BrandIcon's set; without one, its first letter in the tile. */
  brand?: Brand;
  /** Where it runs: a flag and the region's name ("European Union"). */
  region?: { flag: FlagData; label: string };
  /** How its key starts, as the field's placeholder ("sk-ant-…"). */
  placeholder?: string;
}

/** What `onConnect` is handed: the service, the key, and for your own endpoint its address. */
export interface ConnectServiceChoice {
  service: string;
  key: string;
  address?: string;
}

/** The connected service, as the host keeps it: never its key, only its last four. */
export interface ConnectServiceConnected {
  service: string;
  /** The key's last four characters ("9c1e"). */
  last: string;
}

/** Every word the block shows or says. */
export interface ConnectServiceWords {
  change: string;
  key: string;
  keyNote: string;
  keyMissing: string;
  address: string;
  addressPlaceholder: string;
  addressMissing: string;
  addressWrong: string;
  connect: string;
  connecting: string;
  connected: string;
  notConnected: string;
  replaceKey: string;
  disconnect: string;
  /** The question before disconnecting: "Disconnect Anthropic?". */
  disconnectTitle: (name: string) => string;
  /** What is lost. */
  disconnectDetail: string;
  /** The safe answer. */
  keep: string;
  /** Said while it disconnects, and when it could not. */
  disconnecting: string;
  notDisconnected: string;
  /** The connected row's line: "Key …9c1e · European Union". */
  keyLine: (last: string, region: string | undefined) => string;
  /** The form's name: "Connect Anthropic". */
  connectName: (name: string) => string;
}

export const connectServiceWords: ConnectServiceWords = {
  change: "Change",
  key: "Key",
  keyNote: "Only its last four characters are shown again.",
  keyMissing: "Paste the key.",
  address: "Address",
  addressPlaceholder: "https://models.example.com/v1",
  addressMissing: "Enter your endpoint's address.",
  addressWrong: "Enter an address that starts with https://.",
  connect: "Connect",
  connecting: "Connecting",
  connected: "Connected",
  notConnected: "Not connected",
  replaceKey: "Replace key",
  disconnect: "Disconnect",
  disconnectTitle: (name) => `Disconnect ${name}?`,
  disconnectDetail:
    "Grasp's chat, agents and workflows stop using it, and its key is removed. Connecting again takes a new key.",
  keep: "Keep it",
  disconnecting: "Disconnecting",
  notDisconnected: "Could not disconnect",
  keyLine: (last, region) =>
    region === undefined ? `Key …${last}` : `Key …${last} · ${region}`,
  connectName: (name) => `Connect ${name}`,
};

declare module "../../words/words" {
  interface GraspWordsCatalog {
    connectService: ConnectServiceWords;
  }
}

/** Every prop a ConnectService takes. */
export interface ConnectServiceProps {
  /** The card's title ("AI provider"). */
  title: string;
  /** One line in the serif under it, while nothing is chosen. */
  lead?: string;
  /** The services, as equal tiles, in order. */
  services: readonly ConnectServiceOption[];
  /** An endpoint of your own: one quiet line under the tiles that opens the same form with an address. */
  custom?: { label: string; name?: string };
  /** Adds and tests the key. Throw an Error with the service's reason ("Invalid API key") to refuse it. */
  onConnect: (choice: ConnectServiceChoice) => Promise<void>;
  /** The service connected now, if any: the card then shows it, with Replace key and Disconnect. */
  connected?: ConnectServiceConnected | null;
  /** Disconnects the connected service, once asked and answered. A Promise keeps the question open while it works. */
  onDisconnect?: () => unknown;
  /** Any of the words, in place of the English ones. */
  words?: Partial<ConnectServiceWords>;
}

const CUSTOM = "custom";

const grow = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.97)" },
  to: { opacity: 1, transform: "scale(1)" },
});

const styles = stylex.create({
  // The tiles: equal, two in a row in a settings column (45rem), more in a wider card, fewer as the
  // card narrows (by its own width); every tile in a row as tall as the tallest, a long name wrapping
  // inside.
  tiles: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(15rem, 100%), 1fr))",
    gap: grasp.space3,
  },
  // A tile's box: the row's height, the tile filling it.
  tile: { display: "grid", minWidth: 0 },
  lead: { marginBlockEnd: grasp.space4 },
  // Where it runs: one quiet line, its flag and its name, cut with an ellipsis before it wraps.
  region: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  regionName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The quiet line under the tiles: a ghost button, its icon and words.
  custom: { justifySelf: "start", marginBlockStart: grasp.space3 },
  body: { display: "grid", minWidth: 0 },
  // The card's height eases from what it was to what it is (useSwap), and the form grows from the
  // tile that was pressed (its x as the origin).
  easing: {
    overflow: "hidden",
    // The rows' edge is a 1px ring outside their box (the edge token): a hairline of room, given
    // back, keeps it inside the clip on every side, not only where a corner curves in.
    padding: grasp.hairline,
    margin: `calc(-1 * ${grasp.hairline})`,
    transitionProperty: { default: "height", [media.reduced]: "none" },
    transitionDuration: grasp.durationOpen,
    transitionTimingFunction: grasp.ease,
  },
  grow: (origin: string) => ({
    transformOrigin: `${origin} top`,
    animationName: { default: grow, [media.reduced]: "none" },
    animationDuration: grasp.durationOpen,
    animationTimingFunction: grasp.ease,
  }),
  form: { display: "grid", gap: grasp.space5 },
  // The form as wide as the card, as the tiles were: the chosen row stands where they stood.
  formWide: { maxWidth: "none" },
});

const still = () => {
  // Nothing to stop.
};

/** Eases a box's height from what it was to what it is now; returns what stops the wait. */
const ease = (element: HTMLElement, was: number, now: number) => {
  element.style.height = `${was}px`;
  // The next frame, to the new height; then free again.
  requestAnimationFrame(() => {
    element.style.height = `${now}px`;
  });
  const done = () => {
    element.style.height = "";
  };
  element.addEventListener("transitionend", done, { once: true });
  const late = setTimeout(done, 400);
  return () => {
    clearTimeout(late);
  };
};

/** The card's height eased from its last to its new as `key` changes: measured before the paint. */
const useSwap = (key: string) => {
  const box = useRef<HTMLDivElement>(null);
  const last = useRef<{ key: string; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    const before = last.current;
    if (element === null) {
      return still;
    }
    const now = element.scrollHeight;
    last.current = { key, height: now };
    if (before === null || before.key === key || before.height === now) {
      return still;
    }
    return ease(element, before.height, now);
  }, [key]);
  return box;
};

/** A service's mark, as a tile or the chosen row shows it: its brand's, or for your own endpoint the globe. */
const Lead = ({ service }: { service: ConnectServiceOption }) => (
  <ItemMedia>
    {service.id === CUSTOM ? (
      <IconTile icon={Web} variant="raised" size="md" />
    ) : (
      <BrandIcon
        brand={service.brand}
        name={service.brand === undefined ? service.name : undefined}
        size="md"
        decorative
      />
    )}
  </ItemMedia>
);

const Region = ({ service }: { service: ConnectServiceOption }) =>
  service.region === undefined ? null : (
    <ItemDescription>
      <span {...stylex.props(styles.region)}>
        <Flag flag={service.region.flag} size="sm" />
        <span {...stylex.props(styles.regionName)}>{service.region.label}</span>
      </span>
    </ItemDescription>
  );

/** The tiles, and the quiet line for your own endpoint. */
const Tiles = ({
  services,
  custom,
  onChoose,
  tiles,
}: {
  services: readonly ConnectServiceOption[];
  custom: ConnectServiceProps["custom"];
  onChoose: (id: string, from: HTMLElement | null) => void;
  tiles: RefObject<Map<string, HTMLElement>>;
}) => (
  <>
    <div {...stylex.props(styles.tiles)}>
      {services.map((service) => (
        <div
          key={service.id}
          {...stylex.props(styles.tile)}
          ref={(element) => {
            const button = element?.querySelector("button") ?? null;
            if (button === null) {
              tiles.current.delete(service.id);
            } else {
              tiles.current.set(service.id, button);
            }
          }}
        >
          <Item
            variant="outline"
            size="sm"
            onPress={() => {
              onChoose(service.id, tiles.current.get(service.id) ?? null);
            }}
          >
            <Lead service={service} />
            <ItemContent>
              <ItemTitle>{service.name}</ItemTitle>
              <Region service={service} />
            </ItemContent>
          </Item>
        </div>
      ))}
    </div>
    {custom !== undefined && (
      <div
        {...stylex.props(styles.custom)}
        ref={(element) => {
          const button = element?.querySelector("button") ?? null;
          if (button === null) {
            tiles.current.delete(CUSTOM);
          } else {
            tiles.current.set(CUSTOM, button);
          }
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          icon={Plus}
          onClick={(event) => {
            onChoose(CUSTOM, event.currentTarget);
          }}
        >
          {custom.label}
        </Button>
      </div>
    )}
  </>
);

/** The chosen service as one row, with Change at its end. */
const Chosen = ({
  service,
  onChange,
  busy,
  words,
}: {
  service: ConnectServiceOption;
  onChange: () => void;
  busy: boolean;
  words: ConnectServiceWords;
}) => (
  <Item variant="outline" size="sm">
    <Lead service={service} />
    <ItemContent>
      <ItemTitle>{service.name}</ItemTitle>
      <Region service={service} />
    </ItemContent>
    <ItemActions>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onChange}>
        {words.change}
      </Button>
    </ItemActions>
  </Item>
);

/** Runs the host's connect: nothing when it worked, else what it threw. */
const attempt = async (
  onConnect: ConnectServiceProps["onConnect"],
  choice: ConnectServiceChoice
): Promise<unknown> => {
  try {
    await onConnect(choice);
  } catch (error) {
    // A throw with nothing in it is still a refusal.
    return error ?? false;
  }
  return null;
};

/** A refusal's words: the service's reason, or the block's own. */
const reasonOf = (refusal: unknown, fallback: string) =>
  refusal instanceof Error && refusal.message !== ""
    ? refusal.message
    : fallback;

/** The form: the address for your own endpoint, the key, and Connect. A refusal under the key. */
const ConnectForm = ({
  service,
  isCustom,
  onConnect,
  onChange,
  words,
}: {
  service: ConnectServiceOption;
  isCustom: boolean;
  onConnect: ConnectServiceProps["onConnect"];
  onChange: () => void;
  words: ConnectServiceWords;
}) => {
  const [refused, setRefused] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const keyField = useRef<HTMLInputElement>(null);
  // Its own working state, not an action's result: a refusal speaks under the key, and Connect is
  // ready again at once for the key put right (an action's "failed" would hold it a moment).
  const [busy, setBusy] = useState(false);
  const connect = async (address: string | undefined) => {
    setBusy(true);
    const refusal = await attempt(onConnect, {
      service: service.id,
      key,
      ...(address === undefined ? {} : { address }),
    });
    setBusy(false);
    if (refusal !== null) {
      // The service's own reason under the key, and the key cleared: a secret that did not work is
      // not kept in the page.
      setRefused(reasonOf(refusal, words.notConnected));
      setKey("");
      requestAnimationFrame(() => keyField.current?.focus());
    }
  };
  return (
    <Form
      layout={styles.formWide}
      aria-label={words.connectName(service.name)}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const address = data.get("address");
        void connect(typeof address === "string" ? address : undefined);
      }}
    >
      <div {...stylex.props(styles.form)}>
        <Chosen
          service={service}
          onChange={onChange}
          busy={busy}
          words={words}
        />
        {isCustom && (
          <Field name="address">
            <FieldLabel>{words.address}</FieldLabel>
            <Input
              type="url"
              inputMode="url"
              // An address reads left to right in every language.
              dir="ltr"
              required
              placeholder={words.addressPlaceholder}
              data-first=""
              onValueChange={() => {
                setRefused(null);
              }}
            />
            <FieldError match="valueMissing">{words.addressMissing}</FieldError>
            <FieldError match="typeMismatch">{words.addressWrong}</FieldError>
          </Field>
        )}
        {/* Invalid only when refused: left out, not false, so the browser's own check still says a missing key. */}
        <Field name="key" {...(refused === null ? {} : { invalid: true })}>
          <FieldLabel>{words.key}</FieldLabel>
          <SecretInput
            ref={keyField}
            required
            readOnly={busy}
            placeholder={service.placeholder}
            value={key}
            data-first={isCustom ? undefined : ""}
            onValueChange={(next: string) => {
              setKey(next);
              setRefused(null);
            }}
          />
          <FieldDescription>{words.keyNote}</FieldDescription>
          <FieldError match="valueMissing">{words.keyMissing}</FieldError>
          {refused !== null && <FieldError match>{refused}</FieldError>}
        </Field>
        <FormActions>
          <Button
            type="submit"
            variant="ink"
            status={busy ? "working" : "idle"}
            workingLabel={words.connecting}
            doneLabel={words.connected}
            failedLabel={words.notConnected}
          >
            {words.connect}
          </Button>
        </FormActions>
      </div>
    </Form>
  );
};

/**
 * The connected service: its mark, its name, its key's last four. Replace key is the row's quiet
 * action; Disconnect, which cannot be undone, stands in its menu in the danger look and asks first
 * (the confirmations pattern: a grave loss names the thing and what is lost).
 */
const Connected = ({
  service,
  last,
  onReplace,
  onDisconnect,
  words,
}: {
  service: ConnectServiceOption;
  last: string;
  onReplace: () => void;
  onDisconnect?: () => unknown;
  words: ConnectServiceWords;
}) => {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Item variant="outline" size="sm">
        <Lead service={service} />
        <ItemContent>
          <ItemTitle>{service.name}</ItemTitle>
          <ItemDescription>
            {words.keyLine(last, service.region?.label)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button variant="ghost" size="sm" data-replace="" onClick={onReplace}>
            {words.replaceKey}
          </Button>
          {onDisconnect !== undefined && (
            <DropdownMenuMore
              actions={[
                {
                  label: words.disconnect,
                  danger: true,
                  onSelect: () => {
                    setAsking(true);
                  },
                },
              ]}
            />
          )}
        </ItemActions>
      </Item>
      {onDisconnect !== undefined && (
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogTitle>
              {words.disconnectTitle(service.name)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {words.disconnectDetail}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogAction>{words.keep}</AlertDialogAction>
              <AlertDialogAction
                variant="danger"
                action={onDisconnect}
                workingLabel={words.disconnecting}
                failedLabel={words.notDisconnected}
              >
                {words.disconnect}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
};

/** Connect a service by a key, in one card: the tiles, the form, the connected row. */
export const ConnectService = ({
  title,
  lead,
  services,
  custom,
  onConnect,
  connected,
  onDisconnect,
  words: given,
}: ConnectServiceProps) => {
  // The product's words through GraspWords, then this instance's.
  const words = useWords("connectService", connectServiceWords, given);
  const [chosen, setChosen] = useState<string | null>(null);
  const [origin, setOrigin] = useState("50%");
  const [replacing, setReplacing] = useState(false);
  const tiles = useRef(new Map<string, HTMLElement>());
  const body = useRef<HTMLDivElement>(null);
  const customService: ConnectServiceOption = {
    id: CUSTOM,
    name: custom?.name ?? custom?.label ?? "",
  };
  const serviceOf = (id: string) =>
    id === CUSTOM ? customService : services.find((each) => each.id === id);
  const live =
    connected !== undefined && connected !== null && !replacing
      ? serviceOf(connected.service)
      : undefined;
  const view = live === undefined ? (chosen ?? "tiles") : "connected";
  const swap = useSwap(view);
  // Focus follows the change: the first field once a service is chosen, the tile again on Change.
  // Where focus goes once the new view is drawn: its first field, Replace key, or a tile by its id.
  const focusNext = useRef<string | null>(null);
  const shown = useRef(view);
  useLayoutEffect(() => {
    if (shown.current === view) {
      return;
    }
    shown.current = view;
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "first") {
      body.current?.querySelector<HTMLElement>("[data-first]")?.focus();
    } else if (next === "replace") {
      body.current?.querySelector<HTMLElement>("[data-replace]")?.focus();
    } else if (next !== null) {
      tiles.current.get(next)?.focus();
    }
  }, [view]);
  const choose = (id: string, from: HTMLElement | null) => {
    const card = body.current?.getBoundingClientRect();
    const at = from?.getBoundingClientRect();
    if (card !== undefined && at !== undefined && card.width > 0) {
      setOrigin(
        `${Math.round(((at.left + at.width / 2 - card.left) / card.width) * 100)}%`
      );
    }
    focusNext.current = "first";
    setChosen(id);
  };
  // Change: back to the tiles and the tile it came from; while a key is being replaced, back to
  // the connected row and its Replace key.
  const change = () => {
    focusNext.current = replacing ? "replace" : chosen;
    setReplacing(false);
    setChosen(null);
  };
  const chosenService = chosen === null ? undefined : serviceOf(chosen);
  return (
    <SectionCard title={title}>
      <div
        ref={swap}
        data-slot="connect-service"
        {...stylex.props(styles.easing)}
      >
        <div
          ref={body}
          key={view}
          {...stylex.props(
            styles.body,
            view !== "tiles" && styles.grow(origin)
          )}
        >
          {live !== undefined &&
            connected !== undefined &&
            connected !== null && (
              <Connected
                service={live}
                last={connected.last}
                onReplace={() => {
                  focusNext.current = "first";
                  setReplacing(true);
                  setChosen(connected.service);
                }}
                onDisconnect={onDisconnect}
                words={words}
              />
            )}
          {live === undefined && chosenService === undefined && (
            <>
              {lead !== undefined && (
                <Text
                  variant="display"
                  size="lg"
                  tone="ink"
                  layout={styles.lead}
                >
                  {lead}
                </Text>
              )}
              <Tiles
                services={services}
                custom={custom}
                onChoose={choose}
                tiles={tiles}
              />
            </>
          )}
          {live === undefined && chosenService !== undefined && (
            <ConnectForm
              service={chosenService}
              isCustom={chosen === CUSTOM}
              onConnect={async (choice) => {
                await onConnect(choice);
                setReplacing(false);
                setChosen(null);
              }}
              onChange={change}
              words={words}
            />
          )}
        </div>
      </div>
    </SectionCard>
  );
};
