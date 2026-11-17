import type { AppRequest, AppRequestInput } from "@grasp-os/shared/connect";
import { useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { formatDate } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { beyond, nearestApps, stateOf } from "./integrations.ts";
import type { Integration } from "./integrations.ts";
import { ProviderMark } from "./provider-mark.tsx";

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
}) => {
  const { t } = useLingui();
  return (
    <Item size="xs">
      <ItemMedia>
        <ProviderMark
          id={integration.id}
          logo={integration.logo}
          name={integration.name}
        />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{integration.name}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button
          render={
            <Link
              params={{ integration: integration.key }}
              to="/integrations/$integration"
            />
          }
          size="sm"
        >
          {own ? t`Open` : t`Connect`}
        </Button>
      </ItemActions>
    </Item>
  );
};

/** The apps nearest to what is typed: the company's own, then the catalog's. */
const Matches = ({
  own,
  others,
}: {
  own: Integration[];
  others: Integration[];
}) => {
  const { t } = useLingui();
  const title = t`Already here, in case you mean one of these`;
  return (
    <section>
      <SectionHeader size="sm" title={title} />
      <ItemGroup aria-label={title} separated>
        {own.map((integration) => (
          <Match integration={integration} key={integration.key} own />
        ))}
        {others.map((integration) => (
          <Match integration={integration} key={integration.key} own={false} />
        ))}
      </ItemGroup>
    </section>
  );
};

/** The request went: where to find it now. */
const Sent = () => {
  const { t } = useLingui();
  return (
    <>
      <DialogTitle>{t`Forwarded to our team`}</DialogTitle>
      <DialogDescription>
        {t({
          message:
            "Grasp checks what it takes to connect it. You find it under Requested.",
          context:
            "“Requested” is the name of a section on the Integrations page.",
        })}
      </DialogDescription>
      <DialogFooter>
        <DialogAction>{t`Close`}</DialogAction>
      </DialogFooter>
    </>
  );
};

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
      <Field invalid={badUrl}>
        <FieldLabel>{t`Its link`}</FieldLabel>
        <Input
          id="request-url"
          maxLength={2048}
          onValueChange={onUrl}
          placeholder="https://"
          type="url"
          value={url}
        />
        {badUrl ? (
          <FieldError match>
            {t`Use an address that starts with http:// or https://.`}
          </FieldError>
        ) : null}
      </Field>
      <Field>
        <FieldLabel>{t`What should Grasp do there?`}</FieldLabel>
        <Textarea
          id="request-why"
          maxLength={2000}
          onValueChange={onWhy}
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
}: {
  integrations: readonly Integration[];
}) => {
  const { t } = useLingui();
  const formId = useId();
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const router = useRouter();
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
  const connected = integrations.filter(
    (each) => stateOf(each) !== "not_connected"
  );
  const offered = beyond(integrations);
  const own = nearestApps(connected, sought);
  const others = nearestApps(offered, sought);
  const hasMatches = own.length + others.length > 0;
  // Over every app offered, not only those shown: one already here is
  // never asked for.
  const exact = [...connected, ...offered].some(
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
      // The page reads its requests again, so the new one shows under
      // Requested, where "Forwarded to our team" says to find it.
      await router.invalidate();
    }
  };
  if (sent) {
    return <Sent />;
  }
  return (
    <>
      <DialogTitle>{t`Request an app`}</DialogTitle>
      <DialogDescription>
        {t`A workflow needs an app that is not here yet? Tell Grasp which one, and what it should do there.`}
      </DialogDescription>
      <DialogBody>
        <Form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (details && !badUrl && before === undefined && !busy) {
              void send();
            }
          }}
        >
          <Field>
            <FieldLabel>{t`App`}</FieldLabel>
            <Input
              id="request-name"
              maxLength={128}
              onValueChange={(typed) => {
                setName(typed);
                setNone(false);
              }}
              placeholder={t`For example Personio or Twinfield`}
              value={name}
            />
            {before === undefined ? null : (
              <FieldDescription>
                {t`${asker} already asked for it on ${askedOn}.`}
              </FieldDescription>
            )}
          </Field>
          {hasMatches ? <Matches others={others} own={own} /> : null}
          {hasMatches && !none && !exact ? (
            <Button
              onClick={() => {
                setNone(true);
              }}
              size="sm"
            >
              {t`It is not one of these`}
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
            <Alert title={failure} variant="danger" />
          )}
        </Form>
      </DialogBody>
      <DialogFooter>
        <DialogAction>{t`Cancel`}</DialogAction>
        <Button
          disabled={!details || badUrl || before !== undefined || busy}
          form={formId}
          type="submit"
          variant="ink"
        >
          {t`Send request`}
        </Button>
      </DialogFooter>
    </>
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
}) => {
  const { t } = useLingui();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent closeLabel={t`Close`}>
        {/* Mounted only while open, so it starts empty each time. */}
        {open ? <RequestFlow integrations={integrations} /> : null}
      </DialogContent>
    </Dialog>
  );
};
