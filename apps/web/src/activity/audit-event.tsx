import type { AuditEvent } from "@grasp-os/shared/audit";
import type { AuditRecord } from "@grasp-os/shared/audit-log";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";

import { appName, personName } from "../directory.ts";
import type { Directory } from "../directory.ts";
import { formatDateTime } from "../format.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { CopyField } from "../grasp/copy-field/index.ts";
import {
  AppWindow,
  Chat,
  Money,
  Person,
  Search,
  Sparkles,
  Workflow,
} from "../grasp/icons/index.ts";
import { InspectorPanel } from "../grasp/inspector-panel/index.ts";
import type {
  InspectorRow,
  InspectorSection,
} from "../grasp/inspector-panel/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import type { KeyValueItem } from "../grasp/key-value/index.ts";
import type { PanelLayoutStyle } from "../grasp/panel/index.ts";
import { RowListAction } from "../grasp/row-list/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { actorIcon, actorOf, entryWords } from "./audit-log.tsx";

// One audit event's details, beside the events on Settings › Audit trail
// (or in a Sheet on a phone), on the library's Inspector pattern: what
// happened in plain words and when; who did it; what it concerned, each
// opening what it names; the event's own details; and, folded at the foot,
// its place in the tamper-evident chain with its ids to copy.

const styles = stylex.create({
  // The fold at the panel's foot, as the pattern's Advanced settings.
  foot: {
    paddingBlockStart: grasp.space2,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
});

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
      case "guest": {
        return t`Guest`;
      }
      case "visitor": {
        return t`Visitor`;
      }
      case "system": {
        return t`Grasp`;
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
        detail: kindWord(event),
      },
    ];
    if (actor.type === "agent") {
      rows.push({
        id: "for",
        icon: Person,
        name: personName(directory, actor.onBehalfOf),
        detail: t`For`,
      });
    }
    if (actor.type === "guest") {
      rows.push({
        id: "invited",
        icon: Person,
        name: personName(directory, actor.invitedBy),
        detail: t`Invited by`,
      });
    }
    if (actor.type === "person" || actor.type === "agent") {
      const { via } = actor;
      if (via !== undefined) {
        rows.push({
          id: "via",
          icon: Chat,
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
        onPress: () => {
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
        icon: AppWindow,
        name: appName(directory, app),
        detail: t`App`,
        onPress: () => {
          void navigate({ to: "/apps/$app", params: { app } });
        },
      });
    }
    if (actor.type === "workflow") {
      const workflow = actor.workflowId;
      rows.push({
        id: "workflow",
        icon: Workflow,
        name: workflow,
        detail: t`Workflow`,
        onPress: () => {
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
        icon: Sparkles,
        name: `${provider} ${model}`,
        detail: t`${input} in, ${output} out`,
      });
    }
    if (event.cost !== undefined) {
      rows.push({
        id: "cost",
        icon: Money,
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
const Integrity = ({ record }: { record: AuditRecord }) => {
  const { t } = useLingui();
  const copy = (value: string, name: string) => (
    <CopyField
      aria-label={t`Copy ${name}`}
      copiedLabel={t`Copied`}
      failedLabel={t`Could not copy`}
      size="sm"
      value={value}
    />
  );
  const { event } = record;
  const items: KeyValueItem[] = [
    {
      key: t`Verified`,
      value: record.verified
        ? t`Yes: it is unchanged and links to the event before it.`
        : t`No: it was changed, or doesn't link to the event before it.`,
    },
    { key: t`Position`, value: String(record.seq) },
    { key: t`Recorded`, value: formatDateTime(record.receivedAt) },
    ...(event === null
      ? []
      : [
          { key: t`Action`, value: copy(event.action, t`the action`) },
          { key: t`Event ID`, value: copy(event.id, t`the event ID`) },
          ...(event.requestId === undefined
            ? []
            : [
                {
                  key: t`Request`,
                  value: copy(event.requestId, t`the request ID`),
                },
              ]),
          ...(event.actor.type === "workflow"
            ? [{ key: t`Run`, value: copy(event.actor.runId, t`the run ID`) }]
            : []),
        ]),
    { key: t`Hash`, value: copy(record.hash, t`the hash`) },
    {
      key: t`Previous hash`,
      value: copy(record.prevHash, t`the previous hash`),
    },
  ];
  return (
    <div {...stylex.props(styles.foot)}>
      <Collapsible title={t`Integrity`}>
        <KeyValueList items={items} />
      </Collapsible>
    </div>
  );
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
  layout?: PanelLayoutStyle;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const whoRows = useWhoRows();
  const aboutRows = useAboutRows();
  const detailRows = useDetailRows();
  const { event } = record;
  const about = event === null ? [] : aboutRows(event, directory);
  const details = event === null ? [] : detailRows(event);
  const findSimilar =
    event === null ? undefined : (
      <RowListAction
        icon={Search}
        onPress={() => {
          void navigate({
            to: "/settings/audit",
            search: { action: event.action },
          });
        }}
      >
        {t`Find similar`}
      </RowListAction>
    );
  const sections: InspectorSection[] = [];
  if (event !== null) {
    const { id } = actorOf(event.actor, directory);
    sections.push({
      id: "who",
      label: t`Who`,
      rows: whoRows(event, directory),
      ...(id === undefined
        ? {}
        : {
            action: (
              <RowListAction
                icon={Search}
                onPress={() => {
                  void navigate({
                    to: "/settings/audit",
                    search: { actor: id },
                  });
                }}
              >
                {t`Their events`}
              </RowListAction>
            ),
          }),
    });
    if (about.length > 0) {
      sections.push({
        id: "about",
        label: t`About`,
        rows: about,
        ...(details.length === 0 ? { action: findSimilar } : {}),
      });
    }
    if (details.length > 0) {
      sections.push({
        id: "details",
        label: t`Details`,
        rows: details,
        action: findSimilar,
      });
    }
  }
  return (
    <InspectorPanel
      aria-label={t`Event details`}
      description={formatDateTime(record.receivedAt)}
      foot={<Integrity record={record} />}
      framed={framed}
      icon={event === null ? undefined : actorIcon(event.actor)}
      sections={sections}
      title={entryWords(event?.action)}
      words={{ close: t`Close` }}
      {...(onClose === undefined ? {} : { onClose })}
      {...(layout === undefined ? {} : { layout })}
    />
  );
};
