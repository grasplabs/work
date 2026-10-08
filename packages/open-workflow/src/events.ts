import { parseSlot } from "@grasp-os/workflow-expressions/source";

import { member } from "./checker.ts";
import type { Binding, Checker, Site } from "./checker.ts";
import { pointerJoin } from "./diagnostics.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";
import {
  requireBinding,
  taskDefinition,
  textOrExpression,
} from "./task-parts.ts";
import type { TaskMetadata } from "./task-parts.ts";
import {
  allowKeys,
  at,
  dataValue,
  expressionOnly,
  literalText,
  objectAt,
  requireKey,
  isOneLine,
  isUri,
} from "./values.ts";

/**
 * Events: `emit` through a declared event binding, and `listen` for a
 * bounded set of events with a timeout.
 */

/** CloudEvents attributes an emit sets; the host sets id and time. */
const emitAttributes = [
  "type",
  "source",
  "subject",
  "data",
  "datacontenttype",
  "dataschema",
];

/** CloudEvents attributes a listen filters on. */
const filterAttributes = [
  "type",
  "source",
  "subject",
  "id",
  "datacontenttype",
  "dataschema",
];

const maxEventFilters = 16;

const maxCorrelations = 16;

/** The attributes upstream types as a URI or a runtime expression. */
const uriAttributes = new Set(["source", "dataschema"]);

/**
 * An event attribute: literal text or `${ … }`. `source` and `dataschema`
 * are URIs, or an expression on one line, as upstream has them.
 */
const attributeValue = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  key = ""
): void => {
  if (uriAttributes.has(key) && typeof value === "string") {
    const isExpression = parseSlot(value).kind === "expression";
    const valid = isExpression ? isOneLine(value) : isUri(value);
    if (!valid) {
      checker.report.error(
        "profile.invalid_value",
        at(site, pointer),
        isExpression
          ? "Write the expression on one line."
          : "Give an absolute URI, such as https://example.com/jobs.",
        { expected: "URI" }
      );
      return;
    }
  }
  textOrExpression(checker, value, pointer, site, 1024);
};

const checkEventType = (
  checker: Checker,
  attributes: JsonObject,
  pointer: string,
  site: Site,
  binding: Binding | undefined
): void => {
  if (!requireKey(checker, attributes, "type", pointer, site)) {
    return;
  }
  const typePointer = pointerJoin(pointer, "type");
  const type = literalText(checker, attributes.type, typePointer, site, 256);
  const admitted = binding?.contract?.eventTypes;
  if (type !== undefined && admitted !== undefined && !admitted.has(type)) {
    checker.report.error(
      "binding.contract_mismatch",
      at(site, typePointer),
      "Use an event type the event binding admits.",
      { expected: [...admitted].slice(0, 20).join(", ") }
    );
  }
};

export const checkEmit = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  metadata: TaskMetadata
): void => {
  const binding = requireBinding(checker, metadata, pointer, site, "event");
  const emitPointer = pointerJoin(pointer, "emit");
  const emit = objectAt(checker, task.emit, emitPointer, site, "emit");
  if (emit === undefined) {
    return;
  }
  allowKeys(checker, emit, ["event"], emitPointer, site);
  const eventPointer = pointerJoin(emitPointer, "event");
  if (!requireKey(checker, emit, "event", emitPointer, site)) {
    return;
  }
  const event = objectAt(checker, emit.event, eventPointer, site, "the event");
  if (event === undefined) {
    return;
  }
  allowKeys(checker, event, ["with"], eventPointer, site);
  const withPointer = pointerJoin(eventPointer, "with");
  if (!requireKey(checker, event, "with", eventPointer, site)) {
    return;
  }
  const attributes = objectAt(
    checker,
    event.with,
    withPointer,
    site,
    "the event's attributes"
  );
  if (attributes === undefined) {
    return;
  }
  allowKeys(checker, attributes, emitAttributes, withPointer, site, {
    id: "Leave id out: the host sets it.",
    time: "Leave time out: the host records it.",
  });
  checkEventType(checker, attributes, withPointer, site, binding);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "data") {
      dataValue(
        checker,
        value,
        pointerJoin(withPointer, key),
        taskDefinition,
        site
      );
    } else if (key !== "type" && emitAttributes.includes(key)) {
      attributeValue(checker, value, pointerJoin(withPointer, key), site, key);
    }
  }
};

const checkEventFilter = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  binding: Binding | undefined
): void => {
  const filter = objectAt(checker, value, pointer, site, "the event filter");
  if (filter === undefined) {
    return;
  }
  allowKeys(checker, filter, ["with", "correlate"], pointer, site);
  const withPointer = pointerJoin(pointer, "with");
  if (requireKey(checker, filter, "with", pointer, site)) {
    const attributes = objectAt(
      checker,
      filter.with,
      withPointer,
      site,
      "the filter's attributes"
    );
    if (attributes !== undefined) {
      allowKeys(checker, attributes, filterAttributes, withPointer, site);
      checkEventType(checker, attributes, withPointer, site, binding);
      for (const [key, attribute] of Object.entries(attributes)) {
        if (key !== "type" && filterAttributes.includes(key)) {
          attributeValue(
            checker,
            attribute,
            pointerJoin(withPointer, key),
            site,
            key
          );
        }
      }
    }
  }
  if (!Object.hasOwn(filter, "correlate")) {
    return;
  }
  const correlatePointer = pointerJoin(pointer, "correlate");
  const correlate = objectAt(
    checker,
    filter.correlate,
    correlatePointer,
    site,
    "correlate"
  );
  if (correlate === undefined) {
    return;
  }
  const entries = Object.entries(correlate);
  if (entries.length === 0 || entries.length > maxCorrelations) {
    checker.report.error(
      "profile.invalid_value",
      at(site, correlatePointer),
      `Correlate on 1 to ${maxCorrelations} values.`
    );
  }
  for (const [name, entry] of entries.slice(0, maxCorrelations)) {
    const entryPointer = pointerJoin(correlatePointer, name);
    const correlation = objectAt(
      checker,
      entry,
      entryPointer,
      site,
      "a correlation"
    );
    if (correlation === undefined) {
      continue;
    }
    allowKeys(checker, correlation, ["from", "expect"], entryPointer, site);
    if (requireKey(checker, correlation, "from", entryPointer, site)) {
      expressionOnly(
        checker,
        correlation.from,
        pointerJoin(entryPointer, "from"),
        taskDefinition,
        site
      );
    }
    if (Object.hasOwn(correlation, "expect")) {
      attributeValue(
        checker,
        correlation.expect,
        pointerJoin(entryPointer, "expect"),
        site
      );
    }
  }
};

export const checkListen = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  metadata: TaskMetadata
): void => {
  const binding = requireBinding(checker, metadata, pointer, site, "event");
  if (!Object.hasOwn(task, "timeout")) {
    checker.report.error(
      "profile.missing_property",
      at(site, pointerJoin(pointer, "timeout")),
      "Give the listen a timeout: no listener waits forever.",
      { expected: "timeout" }
    );
  }
  const listenPointer = pointerJoin(pointer, "listen");
  const listen = objectAt(checker, task.listen, listenPointer, site, "listen");
  if (listen === undefined) {
    return;
  }
  allowKeys(checker, listen, ["to", "read"], listenPointer, site);
  if (
    Object.hasOwn(listen, "read") &&
    listen.read !== "data" &&
    listen.read !== "envelope"
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(listenPointer, "read")),
      "Read the event's data or its envelope; raw transport bytes aren't available.",
      { expected: "data or envelope" }
    );
  }
  const toPointer = pointerJoin(listenPointer, "to");
  if (!requireKey(checker, listen, "to", listenPointer, site)) {
    return;
  }
  const to = objectAt(checker, listen.to, toPointer, site, "to");
  if (to === undefined) {
    return;
  }
  const strategies = Object.keys(to).filter((key) =>
    ["one", "any", "all"].includes(key)
  );
  allowKeys(checker, to, ["one", "any", "all"], toPointer, site, {
    until:
      "Wait for a bounded set of events: until isn't available; use a bounded loop of listens.",
  });
  const [strategy] = strategies;
  if (strategies.length !== 1 || strategy === undefined) {
    checker.report.error(
      "profile.invalid_value",
      at(site, toPointer),
      "Listen to exactly one of one, any or all.",
      { expected: "one, any or all" }
    );
    return;
  }
  const strategyPointer = pointerJoin(toPointer, strategy);
  if (strategy === "one") {
    checkEventFilter(checker, to.one, strategyPointer, site, binding);
    return;
  }
  const filters = member(to, strategy);
  if (
    !Array.isArray(filters) ||
    filters.length === 0 ||
    filters.length > maxEventFilters
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, strategyPointer),
      `List 1 to ${maxEventFilters} event filters.`,
      { expected: "nonempty list" }
    );
    return;
  }
  for (const [index, filter] of filters.entries()) {
    checkEventFilter(
      checker,
      filter,
      pointerJoin(strategyPointer, index),
      site,
      binding
    );
  }
};
