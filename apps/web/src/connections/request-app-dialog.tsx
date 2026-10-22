import type { AppRequest, AppRequestInput } from "@grasp-os/shared/connect";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CircleCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatDate } from "../format.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { AppLogo } from "./app-logo.tsx";
import { beyond, nearestApps, stateOf } from "./integrations.ts";
import type { Integration } from "./integrations.ts";

// Asking Grasp for an app it can't reach yet, as in the prototype
// (`components/request-app-dialog.tsx`). While the name is typed the apps
// that are already here show first, the company's own and then the
// catalog's, so nobody asks for one that exists; "It is not one of these"
// goes on to the link and the reason. Core keeps one request per name.

const asName = (value: string): string => value.trim().toLocaleLowerCase();

/** Whether `text` is an address core accepts for an app: http or https. */
const isWebAddress = (text: string): boolean => {
  try {
    const { protocol } = new URL(text);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const Match = ({
  integration,
  own,
}: {
  integration: Integration;
  own: boolean;
}) => (
  <li className="flex h-12 items-center gap-3">
    <AppLogo logo={integration.logo} name={integration.name} size="sm" />
    <span className="min-w-0 flex-1 truncate">{integration.name}</span>
    <Button
      nativeButton={false}
      render={
        <Link
          params={{ integration: integration.key }}
          to="/integrations/$integration"
        />
      }
      size="sm"
      variant="outline"
    >
      {own ? <Trans>Open</Trans> : <Trans>Connect</Trans>}
    </Button>
  </li>
);

/** The apps nearest to what is typed: the company's own, then the catalog's. */
const Matches = ({
  own,
  others,
}: {
  own: Integration[];
  others: Integration[];
}) => (
  <section aria-labelledby="request-here" className="flex flex-col gap-1">
    <h3 className="text-muted-foreground" id="request-here">
      <Trans>Already here, in case you mean one of these</Trans>
    </h3>
    <ul className="flex flex-col">
      {own.map((integration) => (
        <Match integration={integration} key={integration.key} own />
      ))}
      {others.map((integration) => (
        <Match integration={integration} key={integration.key} own={false} />
      ))}
    </ul>
  </section>
);

const Sent = ({ onClose }: { onClose: () => void }) => (
  <>
    <DialogHeader className="items-center text-center">
      <CircleCheckIcon aria-hidden="true" className="size-8" />
      <DialogTitle>
        <Trans>Forwarded to our team</Trans>
      </DialogTitle>
      <DialogDescription>
        <Trans context="“Requested” is the name of a section on the Integrations page.">
          Grasp checks what it takes to connect it. You find it under Requested.
        </Trans>
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button onClick={onClose} variant="outline">
        <Trans>Close</Trans>
      </Button>
    </DialogFooter>
  </>
);

/** The link and the reason, asked once none of the apps here is meant. */
const Details = ({
  badUrl,
  onUrl,
  onWhy,
  url,
  why,
}: {
  badUrl: boolean;
  onUrl: (url: string) => void;
  onWhy: (why: string) => void;
  url: string;
  why: string;
}) => {
  const { t } = useLingui();
  return (
    <>
      <Field data-invalid={badUrl}>
        <FieldLabel htmlFor="request-url">
          <Trans>Its link</Trans>
        </FieldLabel>
        <Input
          aria-invalid={badUrl}
          id="request-url"
          inputMode="url"
          maxLength={2048}
          onChange={(event) => {
            onUrl(event.target.value);
          }}
          placeholder="https://"
          type="url"
          value={url}
        />
        {badUrl ? (
          <FieldError>
            <Trans>Use an address that starts with https://.</Trans>
          </FieldError>
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="request-why">
          <Trans>What should Grasp do there?</Trans>
        </FieldLabel>
        <Textarea
          id="request-why"
          maxLength={2000}
          onChange={(event) => {
            onWhy(event.target.value);
          }}
          placeholder={t`For example: read new hires and prepare their first day`}
          value={why}
        />
      </Field>
    </>
  );
};

/** What core is sent: the name, and the link and reason when given. */
const requestOf = (
  name: string,
  url: string,
  why: string
): AppRequestInput => ({
  name,
  ...(why.trim() === "" ? {} : { why: why.trim() }),
  ...(url.trim() === "" ? {} : { url: url.trim() }),
});

/** The request asked for before under the same name, once they are read. */
const askedBefore = (
  asked: Loaded<AppRequest[]> | undefined,
  sought: string
): AppRequest | undefined =>
  asked?.state === "ready"
    ? asked.data.find((each) => asName(each.name) === asName(sought))
    : undefined;

const RequestFlow = ({
  integrations,
  onClose,
}: {
  integrations: readonly Integration[];
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [why, setWhy] = useState("");
  // Pressed once the apps shown are none of what is meant.
  const [none, setNone] = useState(false);
  const [asked, setAsked] = useState<Loaded<AppRequest[]>>();
  const [sent, setSent] = useState(false);
  // What was asked for already, read on its own: a failed read only
  // leaves it to core, which returns the earlier request.
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) => await session.connections.appRequests(),
        left.signal
      );
      if (!left.signal.aborted) {
        setAsked(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);

  const sought = name.trim();
  const own = nearestApps(
    integrations.filter((each) => stateOf(each) !== "not_connected"),
    sought
  );
  const others = nearestApps(beyond(integrations), sought);
  const hasMatches = own.length + others.length > 0;
  const exact = [...own, ...others].some(
    (each) => asName(each.name) === asName(sought)
  );
  const before = askedBefore(asked, sought);
  const asker = before?.requestedBy.name ?? t`A former member`;
  const askedOn = before === undefined ? "" : formatDate(before.requestedAt);
  const details = sought !== "" && (!hasMatches || none);
  const badUrl = url.trim() !== "" && !isWebAddress(url.trim());
  const send = async (): Promise<void> => {
    const result = await run(
      async (session) =>
        await session.connections.requestApp(requestOf(sought, url, why))
    );
    if (result !== undefined) {
      setSent(true);
    }
  };
  if (sent) {
    return <Sent onClose={onClose} />;
  }
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (details && !badUrl && before === undefined && !busy) {
          void send();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>Request an app</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            A workflow needs an app that is not here yet? Tell Grasp which one,
            and what it should do there.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="request-name">
          <Trans>App</Trans>
        </FieldLabel>
        <Input
          id="request-name"
          maxLength={128}
          onChange={(event) => {
            setName(event.target.value);
            setNone(false);
          }}
          placeholder={t`For example Personio or Twinfield`}
          value={name}
        />
        {before === undefined ? null : (
          <FieldDescription>
            <Trans>
              {asker} already asked for it on {askedOn}.
            </Trans>
          </FieldDescription>
        )}
      </Field>
      {hasMatches ? <Matches others={others} own={own} /> : null}
      {hasMatches && !none && !exact ? (
        <Button
          className="self-start"
          onClick={() => {
            setNone(true);
          }}
          variant="outline"
        >
          <Trans>It is not one of these</Trans>
        </Button>
      ) : null}
      {details ? (
        <Details
          badUrl={badUrl}
          onUrl={setUrl}
          onWhy={setWhy}
          url={url}
          why={why}
        />
      ) : null}
      {failure === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      )}
      <DialogFooter>
        <Button onClick={onClose} variant="outline">
          <Trans>Cancel</Trans>
        </Button>
        <Button
          disabled={!details || badUrl || before !== undefined || busy}
          type="submit"
        >
          <Trans>Send request</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
};

/** The Request app dialog; `integrations` is the page's whole list. */
export const RequestAppDialog = ({
  integrations,
  onOpenChange,
  open,
}: {
  integrations: readonly Integration[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent className="sm:max-w-md">
      {open ? (
        <RequestFlow
          integrations={integrations}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      ) : null}
    </DialogContent>
  </Dialog>
);
