import type { AuditEvent } from "@grasp-os/shared/audit";
import type { AuditRecord } from "@grasp-os/shared/audit-log";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { Inspector } from "@grasp-os/ui/blocks/inspector-01/inspector-01";
import type {
  InspectorRow,
  InspectorSection,
} from "@grasp-os/ui/blocks/inspector-01/inspector-01";
import { Button } from "@grasp-os/ui/components/button";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import {
  CircleUserIcon,
  CoinsIcon,
  Icon,
  MessageCircleIcon,
  SearchIcon,
  SparklesIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";

import { appName, personName } from "../directory.ts";
import type { Directory } from "../directory.ts";
import { formatDateTime } from "../format.ts";
import { AppWindowIcon } from "../settings/icons.ts";
import { actorIcon, actorOf, entryWords } from "./audit-log.tsx";

// One audit event's details, beside the events on Settings › Audit trail
// (or in a Sheet on a phone), on the library's Inspector pattern: what
// happened in plain words and when; who did it; what it concerned, each
// opening what it names; the event's own details; and, folded at the foot,
// its place in the tamper-evident chain with its ids to copy.

/** A number in the page's language. */
const count = (value: number): string =>
  new Intl.NumberFormat(i18n.locale).format(value);

/** A detail's key as words: `records_read` reads "Records read". */
const keyWords = (key: string): string => {
  const words = key.replaceAll("_", " ");
  return words.charAt(0).toLocaleUpperCase(i18n.locale) + words.slice(1);
};

/** The words for who did it, by their kind. */
const useKindWord = () => {
  const { t } = useLingui();
  return (event: AuditEvent): string => {
    switch (event.actor.type) {
      case "person": {
        return t`Person`;
      }
      case "staff": {
        return t`Grasp staff`;
      }
      case "agent": {
        return t`Agent`;
      }
      case "app": {
        return t`App`;
      }
      case "workflow": {
        return t`Workflow run`;
      }
      case "system": {
        return "Grasp";
      }
      default: {
        return event.actor satisfies never;
      }
    }
  };
};

/** Who did it, and for whom or through what. */
const useWhoRows = () => {
  const { t } = useLingui();
  const kindWord = useKindWord();
  return (event: AuditEvent, directory: Directory): InspectorRow[] => {
    const { actor } = event;
    const rows: InspectorRow[] = [
      {
        id: "actor",
        icon: actorIcon(actor),
        name: actorOf(actor, directory).label,
        // Grasp itself is named once: its kind would say its name again.
        ...(actor.type === "system" ? {} : { detail: kindWord(event) }),
      },
    ];
    if (actor.type === "agent") {
      rows.push({
        id: "for",
        icon: CircleUserIcon,
        name: personName(directory, actor.onBehalfOf),
        detail: t`For`,
      });
    }
    if (actor.type === "person" || actor.type === "agent") {
      const { via } = actor;
      if (via !== undefined) {
        rows.push({
          id: "via",
          icon: MessageCircleIcon,
          name: chatPlatformName(via),
          detail: t`Through`,
        });
      }
    }
    return rows;
  };
};

/**
 * What it concerned, each opening what it names: the thing acted on (its
 * events), the App and the workflow.
 */
const useAboutRows = () => {
  const { t } = useLingui();
  const navigate = useNavigate();
  return (event: AuditEvent, directory: Directory): InspectorRow[] => {
    const rows: InspectorRow[] = [];
    const { target, actor } = event;
    if (target !== undefined) {
      rows.push({
        id: "target",
        name: target.id,
        detail: target.type,
        onClick: () => {
          void navigate({
            to: "/settings/audit",
            search: { target: target.id },
          });
        },
      });
    }
    if ("appId" in actor) {
      const app = actor.appId;
      rows.push({
        id: "app",
        icon: AppWindowIcon,
        name: appName(directory, app),
        detail: t`App`,
        onClick: () => {
          void navigate({ to: "/apps/$app", params: { app } });
        },
      });
    }
    if (actor.type === "workflow") {
      const workflow = actor.workflowId;
      rows.push({
        id: "workflow",
        icon: WorkflowIcon,
        name: workflow,
        detail: t`Workflow`,
        onClick: () => {
          void navigate({ to: "/workflows/$workflow", params: { workflow } });
        },
      });
    }
    return rows;
  };
};

/** The event's own details: what it recorded beyond who and what. */
const useDetailRows = () => {
  const { t } = useLingui();
  return (event: AuditEvent): InspectorRow[] => {
    const rows: InspectorRow[] = Object.entries(event.detail).map(
      ([key, value]) => ({
        id: `detail-${key}`,
        name: keyWords(key),
        detail: value === null ? "–" : String(value),
      })
    );
    if (event.model !== undefined) {
      const { provider, model, inputTokens, outputTokens } = event.model;
      const input = count(inputTokens);
      const output = count(outputTokens);
      rows.push({
        id: "model",
        icon: SparklesIcon,
        name: `${provider} ${model}`,
        detail: t`${input} in, ${output} out`,
      });
    }
    if (event.cost !== undefined) {
      rows.push({
        id: "cost",
        icon: CoinsIcon,
        name: t`Cost`,
        detail: new Intl.NumberFormat(i18n.locale, {
          style: "currency",
          currency: event.cost.currency,
        }).format(event.cost.amount),
      });
    }
    for (const [at, resource] of event.provenance.entries()) {
      rows.push({ id: `read-${at}`, name: resource, detail: t`Read from` });
    }
    return rows;
  };
};

/**
 * Its place in the tamper-evident chain, folded at the foot: whether it
 * checks out, where it stands, and the ids to copy, each on its own line.
 */
/** One fact of the chain, to copy where `copyable`. */
const fact = (
  id: string,
  label: string,
  value: string,
  copyable = false
): KeyValueItem => ({ id, label, value, ...(copyable ? { copyable } : {}) });

const useIntegrity = (record: AuditRecord): KeyValueItem[] => {
  const { t } = useLingui();
  const { event } = record;
  return [
    fact(
      "verified",
      t`Verified`,
      record.verified
        ? t`Yes: it is unchanged and links to the event before it.`
        : t`No: it was changed, or doesn't link to the event before it.`
    ),
    fact("position", t`Position`, String(record.seq)),
    fact("recorded", t`Recorded`, formatDateTime(record.receivedAt)),
    ...(event === null
      ? []
      : [
          fact("action", t`Action`, event.action, true),
          fact("event", t`Event ID`, event.id, true),
          ...(event.requestId === undefined
            ? []
            : [fact("request", t`Request`, event.requestId, true)]),
          ...(event.actor.type === "workflow"
            ? [fact("run", t`Run`, event.actor.runId, true)]
            : []),
        ]),
    fact("hash", t`Hash`, record.hash, true),
    fact("previous", t`Previous hash`, record.prevHash, true),
  ];
};

/**
 * One event's details, on the library's Inspector panel: beside the table
 * (`framed`), or in a Sheet on a phone. `onClose` closes whichever holds
 * it.
 */
export const EventInspector = ({
  record,
  directory,
  framed,
  onClose,
  layout,
}: {
  record: AuditRecord;
  directory: Directory;
  framed: boolean;
  onClose?: () => void;
  /** Where it sits and how tall it is: the whole of what holds it, beside the table. */
  layout?: LayoutStyle;
}) => {
  const { t, i18n: page } = useLingui();
  // A section's name inside the panel's own sentences, lower case as the
  // library has it, but for German, whose nouns keep their capital.
  const inSentence = (label: string): string =>
    page.locale === "de" ? label : label.toLocaleLowerCase(page.locale);
  const navigate = useNavigate();
  const whoRows = useWhoRows();
  const integrity = useIntegrity(record);
  const aboutRows = useAboutRows();
  const detailRows = useDetailRows();
  const { event } = record;
  const about = event === null ? [] : aboutRows(event, directory);
  const details = event === null ? [] : detailRows(event);
  const findSimilar =
    event === null ? undefined : (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          void navigate({
            to: "/settings/audit",
            search: { action: event.action },
          });
        }}
      >
        <Icon icon={SearchIcon} />
        {t`Find similar`}
      </Button>
    );
  const sections: InspectorSection[] = [];
  if (event !== null) {
    const { id } = actorOf(event.actor, directory);
    sections.push({
      id: "who",
      title: t`Who`,
      rows: whoRows(event, directory),
      ...(id === undefined
        ? {}
        : {
            action: (
              <Button
                onClick={() => {
                  void navigate({
                    to: "/settings/audit",
                    search: { actor: id },
                  });
                }}
                size="xs"
                variant="ghost"
              >
                <Icon icon={SearchIcon} />
                {t`Their events`}
              </Button>
            ),
          }),
    });
    if (about.length > 0) {
      sections.push({
        id: "about",
        title: t`About`,
        rows: about,
        ...(details.length === 0 ? { action: findSimilar } : {}),
      });
    }
    if (details.length > 0) {
      sections.push({
        id: "details",
        title: t`Details`,
        rows: details,
        action: findSimilar,
      });
    }
  }
  return (
    <Inspector
      aria-label={t`Event details`}
      description={formatDateTime(record.receivedAt)}
      framed={framed}
      {...(event === null ? {} : { icon: actorIcon(event.actor) })}
      labels={{
        add: t({ message: "Add", context: "a panel section's action" }),
        addTo: (label) => {
          const section = inSentence(label);
          return t`Add ${section}`;
        },
        none: t`Not set`,
        remove: (name) => t`Remove ${name}`,
        showAll: (label) => {
          const section = inSentence(label);
          return t`Show all the ${section}`;
        },
        views: t`Views`,
      }}
      sections={[
        ...sections,
        // Its place in the tamper-evident chain, last; Damsko's Inspector
        // has no foot to fold it in.
        { id: "integrity", title: t`Integrity`, facts: integrity },
      ]}
      title={entryWords(event?.action)}
      {...(onClose === undefined ? {} : { onClose })}
      {...(layout === undefined ? {} : { style: layout })}
    />
  );
};
