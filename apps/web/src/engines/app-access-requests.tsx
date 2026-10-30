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
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
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
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import { integrationsOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime, formatList } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";

// Asking for a permission for a domain's App outside chat, on its
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

/** How a request names what it asks for, by the names the person sees. */
const ObjectName = ({
  object,
  read,
}: {
  object: PermissionObject;
  read: Askable;
}) => {
  if (object.type === "connection") {
    const found = read.connections.find(({ id }) => id === object.connectionId);
    return found === undefined ? <Trans>A connection</Trans> : found.label;
  }
  if (object.type === "collection") {
    const found = read.collections.find(({ id }) => id === object.collectionId);
    return found === undefined ? <Trans>A collection</Trans> : found.name;
  }
  return <span className="font-mono text-xs">{object.type}</span>;
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
  const core = useCore();
  const ids = useId();
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
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-sm font-medium">
        <Trans>What the app may do with it</Trans>
      </legend>
      <div className="flex max-h-60 flex-col gap-2 overflow-y-auto">
        {choices.map((tool) => {
          const id = `${ids}-${tool.name}`;
          const ticked = chosen.includes(tool.name);
          return (
            <label className="flex items-start gap-2" key={id}>
              <Checkbox
                checked={ticked}
                disabled={!ticked && chosen.length >= permissionMaxActions}
                id={id}
                onCheckedChange={(checked) => {
                  onChange(
                    checked
                      ? [...chosen, tool.name]
                      : chosen.filter((each) => each !== tool.name)
                  );
                }}
              />
              <span className="flex flex-col">
                <span className="font-mono text-xs">{tool.name}</span>
                {tool.description === null ? null : (
                  <span className="text-muted-foreground text-xs">
                    {tool.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
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
  const { busy, failure, run } = useCoreAction();
  const [kind, setKind] = useState<Kind>("connection");
  const [target, setTarget] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [binding, setBinding] = useState("");
  const kindId = useId();
  const targetId = useId();
  const bindingId = useId();
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
    if (permission !== undefined) {
      onAsked();
      onClose();
    }
  };
  const kinds = [
    { value: "connection", label: t`A connection` },
    { value: "collection", label: t`A collection to read` },
  ];
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
        <DialogHeader>
          <DialogTitle>
            <Trans>Ask for access for this domain</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              The request allows nothing until an admin grants it. They see what
              the app asks for and decide.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={kindId}>
            <Trans>What it needs</Trans>
          </FieldLabel>
          <Select
            items={kinds}
            onValueChange={(value: unknown) => {
              if (value === "connection" || value === "collection") {
                setKind(value);
                setTarget(null);
                setTools([]);
                setBinding("");
              }
            }}
            value={kind}
          >
            <SelectTrigger className="w-full" id={kindId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={targetId}>
            {kind === "connection" ? (
              <Trans>Connection</Trans>
            ) : (
              <Trans>Collection</Trans>
            )}
          </FieldLabel>
          <Select
            items={targets}
            onValueChange={(value: unknown) => {
              if (typeof value === "string") {
                choose(value);
              }
            }}
            value={target}
          >
            <SelectTrigger className="w-full" id={targetId}>
              <SelectValue placeholder={t`Choose one`} />
            </SelectTrigger>
            <SelectContent>
              {targets.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {kind === "connection" && connection !== undefined ? (
          <ToolChoice
            chosen={tools}
            connection={connection}
            onChange={setTools}
          />
        ) : null}
        <Field>
          <FieldLabel htmlFor={bindingId}>
            <Trans>Name in the app&apos;s code</Trans>
          </FieldLabel>
          <Input
            id={bindingId}
            maxLength={64}
            onChange={(event) => {
              setBinding(event.target.value);
            }}
            value={binding}
          />
          {binding === "" || named ? (
            <FieldDescription>
              <Trans>
                Capital letters, digits and underscores, starting with a letter,
                such as CRM.
              </Trans>
            </FieldDescription>
          ) : (
            <FieldError>
              <Trans>
                Use capital letters, digits and underscores, starting with a
                letter, and not a name the platform uses itself.
              </Trans>
            </FieldError>
          )}
        </Field>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy || !ready}
            onClick={() => {
              void ask();
            }}
          >
            <Trans>Ask an admin</Trans>
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
  const [asking, setAsking] = useState(false);
  const { requested } = read;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          <Trans>Access waiting for an admin</Trans>
        </h2>
        {asks ? (
          <Button
            onClick={() => {
              setAsking(true);
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Ask for access</Trans>
          </Button>
        ) : null}
      </div>
      {requested.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>Nothing this domain asked for is waiting.</Trans>
        </p>
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">
                  <Trans>Asked for</Trans>
                </TableHead>
                <TableHead variant="card">
                  <Trans>To</Trans>
                </TableHead>
                <TableHead variant="card">
                  <Trans>Name in the app&apos;s code</Trans>
                </TableHead>
                <TableHead className="w-44" variant="card">
                  <Trans>Asked</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requested.map((permission) => (
                <TableRow key={permission.id}>
                  <TableCell variant="card">
                    <ObjectName object={permission.object} read={read} />
                  </TableCell>
                  <TableCell className="whitespace-normal" variant="card">
                    <span className="font-mono text-xs">
                      {formatList(permission.actions)}
                    </span>
                  </TableCell>
                  <TableCell variant="card">
                    <span className="font-mono text-xs">
                      {permission.binding}
                    </span>
                  </TableCell>
                  <TableCell variant="card">
                    {formatDateTime(permission.requestedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
    </section>
  );
};

/**
 * A domain's requests for access, and asking for more, for its builders:
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
      asks={app.status !== "archived"}
      onAsked={() => {
        setAsked((count) => count + 1);
      }}
      read={read.data}
    />
  );
};
