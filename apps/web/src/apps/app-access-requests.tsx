import type { ViewedApp } from "@grasp-os/shared/apps";
import type { CatalogTool } from "@grasp-os/shared/connect";
import type { Collection } from "@grasp-os/shared/knowledge";
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
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import { integrationsOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { formatDateTime, formatList } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox, CheckboxGroup } from "../grasp/checkbox/index.ts";
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
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Cable, Folder, Icon, Key } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import { ScrollArea } from "../grasp/scroll-area/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";

// Asking for a permission for an App's App outside chat, on its
// Integrations tab (`permissions.request`), and the App's requests still
// waiting for an admin. Core takes a request only from the App's builders,
// never Grasp staff, and only for what the App may hold: a connection (by
// the tools it may call) or a collection to read, under a name its code
// reaches it by. A request allows nothing until an admin grants it, from
// what they review; this page only asks. The connections and collections
// offered are those the person sees; core refuses any the App can't hold
// (a personal collection, a connection that isn't there) with its reason.

/** What a request names, as a client sends it. */
type AskedObject = PermissionRequest["object"];

/** What an App asks for: a connection's tools, or a collection to read. */
type Kind = "connection" | "collection";

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
  collections: Collection[];
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
  const [listed, catalog, collections] = await Promise.all([
    session.connections.list(),
    session.connections.catalog(),
    session.knowledge.listCollections(),
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
  return { connections, collections };
};

const styles = stylex.create({
  // The tools of a connection scroll inside the dialog, so it keeps its
  // size with a connection of sixty.
  tools: { maxHeight: "15rem" },
  kind: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
});

/** How a request names what it asks for, by the names the person sees. */
const objectName = (
  object: PermissionObject,
  read: Askable,
  words: { connection: string; collection: string }
): string => {
  if (object.type === "connection") {
    const found = read.connections.find(({ id }) => id === object.connectionId);
    return found === undefined ? words.connection : found.label;
  }
  if (object.type === "collection") {
    const found = read.collections.find(({ id }) => id === object.collectionId);
    return found === undefined ? words.collection : found.name;
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
  }, [connection.provider, connection.source, core]);
  if (tools === undefined) {
    return <LoadingLines lines={2} />;
  }
  if (tools.state !== "ready") {
    return <NotLoaded page={tools} />;
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
        layout={styles.tools}
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

/** Asking for a connection's tools or a collection, under a name. */
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
  const [kind, setKind] = useState<Kind>("connection");
  const [target, setTarget] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [binding, setBinding] = useState("");
  const connection = askable.connections.find(({ id }) => id === target);
  const collection = askable.collections.find(({ id }) => id === target);
  const named = bindingNameSchema.safeParse(binding).success;
  const object: AskedObject | undefined =
    kind === "connection" && connection !== undefined
      ? { type: "connection", connectionId: connection.id }
      : undefined;
  const collectionObject: AskedObject | undefined =
    kind === "collection" && collection !== undefined
      ? { type: "collection", collectionId: collection.id }
      : undefined;
  const asked = object ?? collectionObject;
  const actions = kind === "collection" ? ["read"] : tools;
  const ready = asked !== undefined && actions.length > 0 && named;
  const ask = async (): Promise<void> => {
    if (asked === undefined) {
      return;
    }
    const permission = await run(
      async (session) =>
        await session.permissions.request({
          subject: { type: "app", appId: app },
          object: asked,
          actions,
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
  const kinds = [
    { value: "connection", label: t`A connection`, icon: Cable },
    { value: "collection", label: t`A collection to read`, icon: Folder },
  ] as const;
  const targets =
    kind === "connection"
      ? askable.connections.map(({ id, label }) => ({ value: id, label }))
      : askable.collections.map(({ id, name }) => ({ value: id, label: name }));
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
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Ask for access for this App`}</DialogTitle>
        <DialogDescription>
          {t`The request allows nothing until an admin grants it. They see what the app asks for and decide.`}
        </DialogDescription>
        <DialogBody>
          <Form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <Field>
              <FieldLabel>{t`What it needs`}</FieldLabel>
              <RadioGroup
                onValueChange={(value) => {
                  if (value === "connection" || value === "collection") {
                    setKind(value);
                    setTarget(null);
                    setTools([]);
                    setBinding("");
                  }
                }}
                value={kind}
              >
                {kinds.map((each) => (
                  <Field key={each.value} orientation="horizontal">
                    <RadioGroupItem value={each.value} />
                    <FieldContent>
                      <FieldLabel>
                        <span {...stylex.props(styles.kind)}>
                          <Icon icon={each.icon} />
                          {each.label}
                        </span>
                      </FieldLabel>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>
            </Field>
            <Field>
              <FieldLabel>
                {kind === "connection" ? t`Connection` : t`Collection`}
              </FieldLabel>
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
            {kind === "connection" && connection !== undefined ? (
              <ToolChoice
                chosen={tools}
                connection={connection}
                onChange={setTools}
              />
            ) : null}
            <Field invalid={binding !== "" && !named}>
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
              <Alert tone="danger">{failure}</Alert>
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={ask}
            disabled={busy || !ready}
            failedLabel={t`Could not ask`}
            variant="ink"
            workingLabel={t`Asking`}
          >
            {t`Ask an admin`}
          </DialogAction>
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
  const unnamed = { connection: t`A connection`, collection: t`A collection` };
  return (
    <SectionCard
      actions={
        asks ? (
          <Button
            icon={Key}
            onClick={() => {
              setAsking(true);
            }}
            size="sm"
          >
            {t`Ask for access`}
          </Button>
        ) : undefined
      }
      density="compact"
      flush={requested.length > 0}
      headingLevel={3}
      title={t`Access waiting for an admin`}
    >
      {requested.length === 0 ? (
        <Text size="sm" tone="muted">
          {t`Nothing this App asked for is waiting.`}
        </Text>
      ) : (
        <Table aria-label={t`Access waiting for an admin`} density="compact">
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
                <TableCell lead>
                  {objectName(permission.object, read, unnamed)}
                </TableCell>
                <TableCell wrap>{formatList(permission.actions)}</TableCell>
                <TableCell>{permission.binding}</TableCell>
                <TableCell>{formatDateTime(permission.requestedAt)}</TableCell>
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
    </SectionCard>
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
    return <NotLoaded page={read} />;
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
