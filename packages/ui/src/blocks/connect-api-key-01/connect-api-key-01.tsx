// Connect API key: connect a service by its key, in one card. Nothing chosen: one line that opens
// the card, in the serif, the providers as tiles, as many in a row as fit, and under them a quiet
// line for one that runs at an address of your own. Chosen: its row with Change, an address first when it asks for one, then its key (a
// SecretInput, read from the form as it is sent and never held in state) and Connect. The product
// tests the key in `onConnect`: a refusal stands under the key in the service's own words and the
// key is cleared, as a secret's should be. Connected: its
// row with the key's last four, Replace key, and Disconnect in its menu, which asks first.
//
//   <ConnectApiKey
//     title="AI provider"
//     providers={[{ id: "acme", name: "Acme AI", logo: acmeLogo, placeholder: "sk-…" }]}
//     connected={saved}
//     onConnect={async ({ provider, key }) => { await addAndTest(provider, key); }}
//     onDisconnect={remove}
//   />
//
// A block: install it and edit it. The providers, their marks and the copy are the product's.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/alert-dialog";
import { BrandIcon } from "../../components/brand-icon";
import { Button } from "../../components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/card";
import { DropdownMenuMore } from "../../components/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/field";
import { Form, FormFooter } from "../../components/form";
import { Input, SecretInput } from "../../components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../../components/item";
import { Text } from "../../components/text";
import { useAction } from "../../hooks/use-action";
import { Icon, PlusIcon } from "../../lib/icons";
import type { IconData } from "../../lib/icons";
import { font, size, space } from "../../lib/tokens.stylex";
import type { LayoutStyle } from "../../lib/utils";

/** The words a ConnectApiKey says itself: English here; pass the product's as `labels`. */
export interface ConnectApiKeyLabels {
  /** The address field's label. */
  address: string;
  /** The address field's error when it is empty. */
  addressMissing: string;
  /** The address field's placeholder. */
  addressPlaceholder: string;
  /** The address field's error when it is not an https address. */
  addressWrong: string;
  /** The button back to the tiles from a chosen provider. */
  change: string;
  /** The form's submit button. */
  connect: string;
  /** The form's name, from the provider's. */
  connectName: (name: string) => string;
  /** Said once the key is connected. */
  connected: string;
  /** Said while the key is tested. */
  connecting: string;
  /** The disconnect action and the question's yes. */
  disconnect: string;
  /** What disconnecting loses, when `disconnectDetail` is not given. */
  disconnectDetail: string;
  /** The question before disconnecting, from the provider's name. */
  disconnectTitle: (name: string) => string;
  /** Said while it disconnects. */
  disconnecting: string;
  /** The question's safe answer. */
  keep: string;
  /** The key field's label. */
  key: string;
  /** The connected row's line: the key's last characters, and the region when there is one. */
  keyLine: (last: string, region: string | undefined) => string;
  /** The key field's error when it is empty. */
  keyMissing: string;
  /** The key field's description. */
  keyNote: string;
  /** Said when connecting failed with no reason of the service's. */
  notConnected: string;
  /** Said when disconnecting failed. */
  notDisconnected: string;
  /** The connected row's button that asks for a new key. */
  replaceKey: string;
}

const LABELS: ConnectApiKeyLabels = {
  address: "Address",
  addressMissing: "Enter your endpoint's address.",
  addressPlaceholder: "https://models.example.com/v1",
  addressWrong: "Enter an address that starts with https://.",
  change: "Change",
  connect: "Connect",
  connectName: (name) => `Connect ${name}`,
  connected: "Connected",
  connecting: "Connecting",
  disconnect: "Disconnect",
  disconnectDetail:
    "Nothing can use it any more, and its key is removed. Connecting again takes a new key.",
  disconnectTitle: (name) => `Disconnect ${name}?`,
  disconnecting: "Disconnecting",
  keep: "Keep it",
  key: "Key",
  keyLine: (last, region) =>
    region === undefined ? `Key …${last}` : `Key …${last} · ${region}`,
  keyMissing: "Paste the key.",
  keyNote: "Only its last four characters are shown again.",
  notConnected: "Not connected",
  notDisconnected: "Could not disconnect",
  replaceKey: "Replace key",
};

/** One provider to connect: its name, its mark, where it runs and its key's shape. */
export interface ConnectApiKeyProvider {
  /** A short, lasting id ("acme"). */
  id: string;
  /** Its name ("Acme AI"). */
  name: string;
  /** Its mark, from the product's logos; without one, its first letter in the tile. */
  logo?: IconData;
  /** Where it runs: a mark (a flag) and the region's name ("European Union"). */
  region?: { icon: ReactNode; label: string };
  /** How its key starts, as the field's placeholder ("sk-…"). */
  placeholder?: string;
  /**
   * It runs at an address of your own: a quiet line under the tiles, and the form asks for the
   * address first.
   * @default false
   */
  address?: boolean;
  /** The words of that line, when they are not its name ("Use an endpoint of your own"). */
  addressLabel?: string;
}

/** Every prop a ConnectApiKey takes. */
export interface ConnectApiKeyProps {
  /** The card's title ("AI provider"). */
  title: string;
  /** One line that opens the card, over the tiles, in the serif. */
  description?: ReactNode;
  /** The providers, as tiles, in order. */
  providers: readonly ConnectApiKeyProvider[];
  /** The provider connected now, if any: never its key, only the key's last four characters. */
  connected?: { provider: string; last: string } | null;
  /**
   * Adds and tests the key. Throw an Error with the service's reason ("Invalid API key") to
   * refuse it.
   */
  onConnect: (choice: {
    provider: string;
    key: string;
    address?: string;
  }) => Promise<void>;
  /** Disconnects the connected provider, once asked and answered. Return a Promise to wait on it. */
  onDisconnect?: () => unknown;
  /** What disconnecting loses, in the question before it. */
  disconnectDetail?: ReactNode;
  /** Its words in the product's language; each one left out keeps its English. */
  labels?: Partial<ConnectApiKeyLabels>;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  form: { display: "grid", rowGap: space["5"] },
  lead: { marginBlockEnd: space["4"] },
  // The tiles: equal, as many in a row as fit at their least width, one a row on a phone; every
  // tile in a row as tall as the tallest, a long name wrapping inside.
  tiles: {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fit, minmax(min(${size.connectTile}, 100%), 1fr))`,
    gap: space["3"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  tile: { display: "grid", minWidth: 0 },
  // Where it runs: one quiet line, its mark and its name, cut with an ellipsis before it wraps.
  region: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    minWidth: 0,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  regionName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The quiet line under the tiles: a ghost button, its plus and its words.
  own: { display: "grid", justifyItems: "start", marginBlockStart: space["3"] },
});

/** A provider's mark: its logo, or its first letter. */
const Logo = ({ provider }: { provider: ConnectApiKeyProvider }) => (
  <ItemMedia align="center">
    <BrandIcon logo={provider.logo} label={provider.name} decorative />
  </ItemMedia>
);

/** The form: the chosen provider with Change, its address when it asks, its key, and Connect. */
const ConnectForm = ({
  provider,
  onConnect,
  onChange,
  words,
}: {
  provider: ConnectApiKeyProvider;
  onConnect: ConnectApiKeyProps["onConnect"];
  onChange: () => void;
  words: ConnectApiKeyLabels;
}) => {
  const [refused, setRefused] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const connect = useAction(onConnect, {
    loadingLabel: words.connecting,
    successLabel: words.connected,
    errorLabel: words.notConnected,
  });
  // Chosen: the focus goes to its first field.
  useEffect(() => {
    form.current?.querySelector("input")?.focus();
  }, []);
  const submit = async (key: string, address: string | undefined) => {
    const result = await connect.run({
      provider: provider.id,
      key,
      ...(address === undefined ? {} : { address }),
    });
    if (!result.ok && !("busy" in result)) {
      // The service's own reason under the key, and the key cleared: a secret that did not work
      // is not kept in the page.
      setRefused(
        result.error instanceof Error && result.error.message !== ""
          ? result.error.message
          : words.notConnected
      );
      const field =
        form.current?.querySelector<HTMLInputElement>("[type=password]");
      if (field) {
        field.value = "";
        field.focus();
      }
    }
  };
  return (
    <Form
      ref={form}
      aria-label={words.connectName(provider.name)}
      onSubmit={(event) => {
        event.preventDefault();
        // The key is read from the form as it is sent, never held in state: a field the page
        // controls mirrors its value into the page's markup.
        const sent = new FormData(event.currentTarget);
        const key = sent.get("key");
        const address = sent.get("address");
        void submit(
          typeof key === "string" ? key : "",
          typeof address === "string" ? address : undefined
        );
      }}
    >
      <div {...stylex.props(styles.form)}>
        <Item variant="outline" size="sm">
          <Logo provider={provider} />
          <ItemContent>
            <ItemTitle>{provider.name}</ItemTitle>
          </ItemContent>
          <ItemActions>
            <Button
              variant="ghost"
              size="sm"
              disabled={connect.status === "loading"}
              onClick={onChange}
            >
              {words.change}
            </Button>
          </ItemActions>
        </Item>
        {provider.address === true && (
          <Field name="address">
            <FieldLabel>{words.address}</FieldLabel>
            <Input
              type="url"
              // An address reads left to right in every language.
              dir="ltr"
              required
              placeholder={words.addressPlaceholder}
            />
            <FieldError match="valueMissing">{words.addressMissing}</FieldError>
            <FieldError match="typeMismatch">{words.addressWrong}</FieldError>
          </Field>
        )}
        {/* Invalid only when refused: left out otherwise, so the browser's own check still says a missing key. */}
        <Field name="key" {...(refused === null ? {} : { invalid: true })}>
          <FieldLabel>{words.key}</FieldLabel>
          <SecretInput
            required
            readOnly={connect.status === "loading"}
            placeholder={provider.placeholder}
            onValueChange={() => {
              setRefused(null);
            }}
          />
          <FieldDescription>{words.keyNote}</FieldDescription>
          <FieldError match="valueMissing">{words.keyMissing}</FieldError>
          {refused !== null && <FieldError match>{refused}</FieldError>}
        </Field>
        <FormFooter align="start">
          <Button
            type="submit"
            status={connect.status}
            successLabel={words.connected}
            errorLabel={words.notConnected}
          >
            {words.connect}
          </Button>
        </FormFooter>
      </div>
    </Form>
  );
};

/** The connected provider: its row, Replace key, and Disconnect in its menu, which asks first. */
const Connected = ({
  provider,
  last,
  onReplace,
  onDisconnect,
  disconnectDetail,
  words,
}: {
  provider: ConnectApiKeyProvider;
  last: string;
  onReplace: () => void;
  onDisconnect: ConnectApiKeyProps["onDisconnect"];
  disconnectDetail: ReactNode;
  words: ConnectApiKeyLabels;
}) => {
  const [asking, setAsking] = useState(false);
  const disconnect = useAction(
    async () => {
      await onDisconnect?.();
      setAsking(false);
    },
    {
      loadingLabel: words.disconnecting,
      errorLabel: words.notDisconnected,
    }
  );
  return (
    <>
      <Item variant="outline" size="sm">
        <Logo provider={provider} />
        <ItemContent>
          <ItemTitle>{provider.name}</ItemTitle>
          <ItemDescription>
            {words.keyLine(last, provider.region?.label)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button variant="ghost" size="sm" onClick={onReplace}>
            {words.replaceKey}
          </Button>
          {onDisconnect !== undefined && (
            <DropdownMenuMore
              items={[
                {
                  label: words.disconnect,
                  variant: "destructive",
                  onSelect: () => {
                    setAsking(true);
                  },
                },
              ]}
            />
          )}
        </ItemActions>
      </Item>
      <AlertDialog
        open={asking}
        onOpenChange={(next, details) => {
          // While it disconnects, the question stays.
          if (disconnect.status === "loading") {
            details.cancel();
            return;
          }
          setAsking(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {words.disconnectTitle(provider.name)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {disconnectDetail ?? words.disconnectDetail}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{words.keep}</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              status={disconnect.status}
              onClick={async () => {
                await disconnect.run();
              }}
              loadingLabel={words.disconnecting}
              errorLabel={words.notDisconnected}
            >
              {words.disconnect}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** Connect a service by its key, in one card: the tiles, the form, the connected row. */
export const ConnectApiKey = ({
  title,
  description,
  providers,
  connected,
  onConnect,
  onDisconnect,
  disconnectDetail,
  labels,
  style,
}: ConnectApiKeyProps) => {
  const words = { ...LABELS, ...labels };
  const [chosen, setChosen] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  // Where the focus goes once the next view is drawn: a tile by its place, or Replace key.
  const focusNext = useRef<number | "replace" | null>(null);
  const shown = useRef("tiles");
  const live =
    connected === undefined || connected === null || replacing
      ? undefined
      : providers.find((provider) => provider.id === connected.provider);
  const form = providers.find((provider) => provider.id === chosen);
  const view = live === undefined ? (chosen ?? "tiles") : "connected";
  useEffect(() => {
    if (shown.current === view) {
      return;
    }
    shown.current = view;
    const next = focusNext.current;
    focusNext.current = null;
    const buttons = body.current?.querySelectorAll("button");
    if (next === "replace") {
      buttons?.[0]?.focus();
    } else if (next !== null) {
      buttons?.[next]?.focus();
    }
  }, [view]);
  // Change: back to the tile it came from; while a key is replaced, back to Replace key.
  // The tiles first, then the lines of those that run at an address of your own: the order the
  // buttons stand in.
  const tiles = providers.filter((provider) => provider.address !== true);
  const lines = providers.filter((provider) => provider.address === true);
  const placeOf = (id: string | null) =>
    [...tiles, ...lines].findIndex((provider) => provider.id === id);
  const change = () => {
    focusNext.current = replacing ? "replace" : placeOf(chosen);
    setReplacing(false);
    setChosen(null);
  };
  return (
    <Card style={style}>
      <CardHeader>
        <CardTitle level={2}>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div ref={body} data-slot="connect-api-key">
          {live !== undefined &&
            connected !== undefined &&
            connected !== null && (
              <Connected
                provider={live}
                last={connected.last}
                onReplace={() => {
                  setReplacing(true);
                  setChosen(connected.provider);
                }}
                onDisconnect={
                  onDisconnect === undefined
                    ? undefined
                    : async () => {
                        // Once it is gone, the focus goes to its tile.
                        focusNext.current = placeOf(connected.provider);
                        try {
                          await onDisconnect();
                        } catch (error) {
                          focusNext.current = null;
                          throw error;
                        }
                      }
                }
                disconnectDetail={disconnectDetail}
                words={words}
              />
            )}
          {live === undefined && form !== undefined && (
            <ConnectForm
              provider={form}
              onConnect={async (choice) => {
                // Once connected, the focus goes to Replace key, in the row that says so.
                focusNext.current = "replace";
                try {
                  await onConnect(choice);
                } catch (error) {
                  focusNext.current = null;
                  throw error;
                }
                setReplacing(false);
                setChosen(null);
              }}
              onChange={change}
              words={words}
            />
          )}
          {live === undefined && form === undefined && (
            <>
              {description !== undefined && (
                <div {...stylex.props(styles.lead)}>
                  <Text variant="display" size="lg">
                    {description}
                  </Text>
                </div>
              )}
              <ul
                // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops a list's role once its markers are hidden
                role="list"
                aria-label={title}
                {...stylex.props(styles.tiles)}
              >
                {tiles.map((provider) => (
                  <li key={provider.id} {...stylex.props(styles.tile)}>
                    <Item
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setChosen(provider.id);
                      }}
                    >
                      <Logo provider={provider} />
                      <ItemContent>
                        <ItemTitle>{provider.name}</ItemTitle>
                        {provider.region !== undefined && (
                          <ItemDescription>
                            <span {...stylex.props(styles.region)}>
                              {provider.region.icon}
                              <span {...stylex.props(styles.regionName)}>
                                {provider.region.label}
                              </span>
                            </span>
                          </ItemDescription>
                        )}
                      </ItemContent>
                    </Item>
                  </li>
                ))}
              </ul>
              {lines.length > 0 && (
                <div {...stylex.props(styles.own)}>
                  {lines.map((provider) => (
                    <Button
                      key={provider.id}
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setChosen(provider.id);
                      }}
                    >
                      <Icon icon={PlusIcon} />
                      {provider.addressLabel ?? provider.name}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
