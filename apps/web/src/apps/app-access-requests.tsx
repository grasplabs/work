import type { ViewedApp } from "@grasp-os/shared/apps";
import type { CatalogTool } from "@grasp-os/shared/connect";
import {
  bindingNameSchema,
  permissionMaxActions,
} from "@grasp-os/shared/permissions";
import type {
  Permission,
  PermissionObject,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Checkbox, CheckboxGroup } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { Input } from "@grasp-os/ui/components/input";
import { ScrollArea } from "@grasp-os/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, KeyIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import { integrationsOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { formatDateTime, formatList } from "../format.ts";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";

// Asking for a permission for an App's App outside chat, on its
// Integrations tab (`permissions.request`), and the App's requests still
// waiting for an admin. Core takes a request only from the App's builders,
// never Grasp staff, and only for what the App may hold: a connection, by
// the tools it may call, under a name its code reaches it by. A request
// allows nothing until an admin grants it, from what they review; this
// page only asks. The connections offered are those the person sees; core
// refuses any the App can't hold (a connection that isn't there) with its
// reason.

/** What a request names, as a client sends it. */
type AskedObject = PermissionRequest["object"];

/** A connection the person sees, with the name of its integration. */
interface Connectable {
  id: string;
  label: string;
  source: Integration["source"];
  provider: string;
  /** A Composio connection's offered tools; none listed for a native one. */
  offered: readonly string[] | undefined;
}

/** What the dialog reads to ask from. */
interface Askable {
  connections: Connectable[];
}

/** What the section reads: the App's requests, and the names to show them by. */
interface Read extends Askable {
  requested: Permission[];
}

const nonName = /[^A-Z0-9_]+/gu;
const nameEnds = /^_+|_+$/gu;
const leadingDigits = /^[0-9_]+/u;

/** A binding name to start from: "Microsoft 365" as "MICROSOFT_365". */
const suggestedName = (label: string): string =>
  label
    .toUpperCase()
    .replaceAll(nonName, "_")
    .replaceAll(nameEnds, "")
    .replace(leadingDigits, "")
    .slice(0, 64);

const readAskable = async (session: Session): Promise<Askable> => {
  const [listed, catalog] = await Promise.all([
    session.connections.list(),
    session.connections.catalog(),
  ]);
  const connections = integrationsOf(catalog.entries, listed).flatMap(
    (integration) =>
      integration.connections
        .filter(({ status }) => status !== "disconnected")
        .map((connection) => ({
          id: connection.id,
          label:
            connection.accountName === null
              ? integration.name
              : `${integration.name} · ${connection.accountName}`,
          source: connection.source,
          provider: connection.provider,
          offered: connection.offeredTools,
        }))
  );
  return { connections };
};

const styles = stylex.create({
  // The tools of a connection scroll inside the dialog, so it keeps its
  // size with a connection of sixty.
  tools: { maxHeight: "15rem" },
});

/** How a request names what it asks for, by the names the person sees. */
const objectName = (
  object: PermissionObject,
  read: Askable,
  words: { connection: string }
): string => {
  if (object.type === "connection") {
    const found = read.connections.find(({ id }) => id === object.connectionId);
    return found === undefined ? words.connection : found.label;
  }
  return object.type;
};

/** The tools of the connection chosen, to tick those the App may call. */
const ToolChoice = ({
  connection,
  chosen,
  onChange,
}: {
  connection: Connectable;
  chosen: readonly string[];
  onChange: (tools: string[]) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [tools, setTools] = useState<Loaded<CatalogTool[]>>();
  // Counts the tries, so Try again reads them again.
  const [tried, setTried] = useState(0);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) =>
          await session.connections.catalogTools(
            connection.source,
            connection.provider
          ),
        left.signal
      );
      if (!left.signal.aborted) {
        setTools(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `tried` says when to read again
  }, [connection.provider, connection.source, core, tried]);
  if (tools === undefined) {
    return <LoadingLines lines={2} />;
  }
  if (tools.state !== "ready") {
    return (
      <NotLoadedState
        again={() => {
          setTried(tried + 1);
        }}
        heading="h3"
        page={tools}
      />
    );
  }
  const { offered } = connection;
  const choices = tools.data.filter(
    ({ name }) => offered === undefined || offered.includes(name)
  );
  const full = chosen.length >= permissionMaxActions;
  return (
    <Field>
      <FieldLabel>{t`What the App may do with it`}</FieldLabel>
      <ScrollArea
        aria-label={t`What the App may do with it`}
        style={styles.tools}
      >
        <CheckboxGroup onValueChange={onChange} value={[...chosen]}>
          {choices.map((tool) => (
            <Field key={tool.name} orientation="horizontal">
              <Checkbox
                disabled={full && !chosen.includes(tool.name)}
                value={tool.name}
              />
              <FieldContent>
                <FieldLabel>{tool.name}</FieldLabel>
                {tool.description === null ? null : (
                  <FieldDescription>{tool.description}</FieldDescription>
                )}
              </FieldContent>
            </Field>
          ))}
        </CheckboxGroup>
      </ScrollArea>
    </Field>
  );
};

/** Asking for a connection's tools, under a name. */
const AskDialog = ({
  app,
  askable,
  onClose,
  onAsked,
}: {
  app: string;
  askable: Askable;
  onClose: () => void;
  onAsked: () => void;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const { busy, failure, run } = useCoreAction();
  const [target, setTarget] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [binding, setBinding] = useState("");
  const connection = askable.connections.find(({ id }) => id === target);
  const named = bindingNameSchema.safeParse(binding).success;
  const asked: AskedObject | undefined =
    connection === undefined
      ? undefined
      : { type: "connection", connectionId: connection.id };
  const ready = asked !== undefined && tools.length > 0 && named;
  const ask = async (): Promise<void> => {
    if (asked === undefined) {
      return;
    }
    const permission = await run(
      async (session) =>
        await session.permissions.request({
          subject: { type: "app", appId: app },
          object: asked,
          actions: tools,
          binding,
        })
    );
    if (permission === undefined) {
      // The dialog stays open, with core's reason in it.
      throw new Error("Not asked");
    }
    onAsked();
    onClose();
  };
  const targets = askable.connections.map(({ id, label }) => ({
    value: id,
    label,
  }));
  const choose = (value: string): void => {
    setTarget(value);
    setTools([]);
    const label = targets.find((each) => each.value === value)?.label ?? "";
    setBinding(suggestedName(label));
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Ask for access for this App`}</DialogTitle>
          <DialogDescription>
            {t`The request allows nothing until an admin grants it. They see what the app asks for and decide.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <Field>
              <FieldLabel>{t`Connection`}</FieldLabel>
              <Select
                items={targets}
                onValueChange={(value) => {
                  if (value !== null) {
                    choose(value);
                  }
                }}
                value={target}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t`Choose one`} />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </Field>
            {connection === undefined ? null : (
              <ToolChoice
                chosen={tools}
                connection={connection}
                onChange={setTools}
              />
            )}
            <Field data-invalid={binding !== "" && !named}>
              <FieldLabel>{t`Name in the App's code`}</FieldLabel>
              <Input
                maxLength={64}
                onValueChange={setBinding}
                value={binding}
              />
              {binding === "" || named ? (
                <FieldDescription>
                  {t`Capital letters, digits and underscores, starting with a letter, such as CRM.`}
                </FieldDescription>
              ) : (
                <FieldError match>
                  {t`Use capital letters, digits and underscores, starting with a letter, and not a name the platform uses itself.`}
                </FieldError>
              )}
            </Field>
            {failure === undefined ? null : (
              <Alert variant="destructive">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            disabled={busy || !ready}
            errorText={t`Could not ask`}
            loadingText={t`Asking`}
            onClick={ask}
            variant="default"
          >
            {t`Ask an admin`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** The App's requests waiting for an admin, and asking for another. */
const RequestsView = ({
  app,
  read,
  asks,
  onAsked,
}: {
  app: string;
  read: Read;
  /** Whether the person may ask: not on an archived App. */
  asks: boolean;
  onAsked: () => void;
}) => {
  const { t } = useLingui();
  const [asking, setAsking] = useState(false);
  const { requested } = read;
  const unnamed = { connection: t`A connection` };
  return (
    <Card size="sm" asChild>
      <section aria-label={t`Access waiting for an admin`}>
        <CardHeader>
          <CardTitle level={3}>{t`Access waiting for an admin`}</CardTitle>
          <CardAction>
            {asks ? (
              <Button
                onClick={() => {
                  setAsking(true);
                }}
                size="sm"
                variant="outline"
              >
                <Icon icon={KeyIcon} />
                {t`Ask for access`}
              </Button>
            ) : undefined}
          </CardAction>
        </CardHeader>
        <CardContent flush={requested.length > 0}>
          {requested.length === 0 ? (
            <Text size="sm" color="muted">
              {t`Nothing this App asked for is waiting.`}
            </Text>
          ) : (
            <Table
              aria-label={t`Access waiting for an admin`}
              density="compact"
            >
              <TableHeader>
                <TableRow>
                  <TableHead>{t`Asked for`}</TableHead>
                  <TableHead>{t`To`}</TableHead>
                  <TableHead>{t`Name in the App's code`}</TableHead>
                  <TableHead>{t`Asked`}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requested.map((permission) => (
                  <TableRow key={permission.id}>
                    <TableCell rowHeader>
                      {objectName(permission.object, read, unnamed)}
                    </TableCell>
                    <TableCell wrap>{formatList(permission.actions)}</TableCell>
                    <TableCell>{permission.binding}</TableCell>
                    <TableCell>
                      {formatDateTime(permission.requestedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {asking ? (
            <AskDialog
              app={app}
              askable={read}
              onAsked={onAsked}
              onClose={() => {
                setAsking(false);
              }}
            />
          ) : null}
        </CardContent>
      </section>
    </Card>
  );
};

/**
 * An App's requests for access, and asking for more, for its builders:
 * read when the Integrations tab opens and again after each request.
 */
export const AppAccessRequests = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "staff">;
}) => {
  const core = useCore();
  const builds = buildsApp(app, identity);
  const [read, setRead] = useState<Loaded<Read>>();
  // Counts the requests made here, so each reads them again.
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      if (!builds) {
        return;
      }
      const loaded = await loadFromCore(
        core,
        async (session) => {
          const [requested, askable] = await Promise.all([
            session.permissions.list(
              { type: "app", appId: app.id },
              "requested"
            ),
            readAskable(session),
          ]);
          return { requested, ...askable };
        },
        left.signal
      );
      if (!left.signal.aborted) {
        setRead(loaded);
      }
    };
    void load();
    return () => {
      left.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `asked` says when to read again
  }, [app.id, asked, builds, core]);
  if (!builds) {
    return null;
  }
  if (read === undefined) {
    return <LoadingLines lines={2} />;
  }
  if (read.state !== "ready") {
    return (
      <NotLoadedState
        again={() => {
          setAsked(asked + 1);
        }}
        heading="h3"
        page={read}
      />
    );
  }
  return (
    <RequestsView
      app={app.id}
      asks={!app.archived}
      onAsked={() => {
        setAsked((count) => count + 1);
      }}
      read={read.data}
    />
  );
};
