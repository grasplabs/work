import { describe, expect, it } from "vite-plus/test";

import { auditEventTypeOf } from "../src/audit-log.ts";

const typeOf = (action: string, detail = {}) =>
  auditEventTypeOf({ action, detail });

describe("audit event types", () => {
  it("still files the removed portable host's past events: a token issued as granted access, its calls as actions", () => {
    expect(
      ["app.token.issued", "app.portable.called"].map((action) =>
        typeOf(action)
      )
    ).toStrictEqual(["permission", "action"]);
  });

  it("files the log's own events by what they do", () => {
    expect(
      ["audit.searched", "audit.exported", "audit.verified"].map((action) =>
        typeOf(action)
      )
    ).toStrictEqual(["read", "read", "read"]);
    expect(typeOf("audit.archived")).toBe("action");
    expect(typeOf("audit.purged")).toBe("action");
  });

  it("files a chat's question noted for the Brain, and how its hand-over ended, as actions", () => {
    expect(
      [
        "chat.turn_noted",
        "brain.source.handover_started",
        "brain.source.handed_over",
        "brain.source.handover_refused",
        "brain.source.handover_skipped",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["action", "action", "action", "action", "action"]);
  });

  it("files what was captured from a connection, and its erasure when it is disconnected, as actions", () => {
    expect(
      [
        "brain.capture.kept",
        "brain.capture.skipped",
        "brain.capture.failed",
        "brain.capture.erased",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["action", "action", "action", "action"]);
  });

  it("gives an audit action no rule names no type, rather than filing it as a read", () => {
    expect(typeOf("audit.something_new")).toBeNull();
  });

  it("files an admin's past word on an App's pages as a decision, code refused its data as an action, and the rest of an App as configuration", () => {
    expect(
      [
        "app.artifact.approved",
        "app.artifact.revoked",
        "app.artifact.refused",
        "app.output.classified",
        "app.version.current",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["decision", "decision", "action", "config", "config"]);
  });

  it("files past template reads as reads, and template publications as configuration", () => {
    expect(
      ["resource.template.read", "resource.template.published"].map((action) =>
        typeOf(action)
      )
    ).toStrictEqual(["read", "config"]);
  });

  it("files the onboarding's changes, its gate among them, as configuration", () => {
    expect(
      [
        "onboarding.roster.saved",
        "onboarding.paused",
        "onboarding.gate.closed",
        "onboarding.gate.opened",
        "onboarding.gate.threshold_set",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["config", "config", "config", "config", "config"]);
  });

  it("files a connector call by whether it changed something", () => {
    expect(typeOf("connection.call", { sideEffect: true })).toBe("action");
    expect(typeOf("connection.call", { sideEffect: false })).toBe("read");
    expect(typeOf("connection.call.provenance")).toBe("read");
  });

  it("files reading Knowledge as a read, and changing it as an action", () => {
    expect(
      [
        "knowledge.read",
        "knowledge.search",
        "knowledge.search.empty",
        "knowledge.document.saved",
        "knowledge.collection.created",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["read", "read", "read", "action", "config"]);
  });

  it("files the chat agent's own calls as reads, refused ones too", () => {
    expect([
      typeOf("agent.call", { method: "apps.list", outcome: "ok" }),
      typeOf("agent.call", {
        method: "connections.call",
        outcome: "refused",
      }),
    ]).toStrictEqual(["read", "read"]);
  });

  it("files a call between Apps by its export's access, and one refused before that as an action", () => {
    expect([
      typeOf("app.call", { access: "read", outcome: "called" }),
      typeOf("app.call", { access: "write", outcome: "called" }),
      typeOf("app.call", { outcome: "refused" }),
      typeOf("app.called", { access: "read" }),
      typeOf("app.called", { access: "write" }),
      // The rest of the family is still configuration.
      typeOf("app.created"),
    ]).toStrictEqual(["read", "action", "action", "read", "action", "config"]);
  });

  it("files computing improvement signals as an action, and reading them as a read", () => {
    expect(
      ["improvement.signals.computed", "improvement.signals.read"].map(
        (action) => typeOf(action)
      )
    ).toStrictEqual(["action", "read"]);
  });

  it("files a workflow's decisions as decisions, and its runs and steps as actions", () => {
    expect(
      [
        "workflow.decision.opened",
        "workflow.decision.approved",
        "workflow.decision.timed_out",
        "workflow.run.started",
        "workflow.run.waiting",
        "workflow.step.completed",
      ].map((action) => typeOf(action))
    ).toStrictEqual([
      "decision",
      "decision",
      "decision",
      "action",
      "action",
      "action",
    ]);
  });

  it("files a person deciding on proposed packages as a decision, and proposing or being refused them as an action", () => {
    expect(
      [
        "dependency.requested",
        "dependency.superseded",
        "dependency.malware_refused",
        "dependency.approval_refused",
        "dependency.advisory_found",
        "dependency.built",
        "dependency.retired",
        "dependency.withdrawn",
        // As older releases wrote them.
        "dependency.admission_refused",
        "dependency.pin_dropped",
        "dependency.lock_targets_changed",
        "dependency.approved",
        "dependency.denied",
        "dependency.revoked",
      ].map((action) => typeOf(action))
    ).toStrictEqual([
      ...Array.from({ length: 11 }, () => "action"),
      "decision",
      "decision",
      "decision",
    ]);
  });

  it("files a person deciding on a held action as a decision, and dropping one as an action", () => {
    expect(
      [
        "connection.action.confirmed",
        "connection.action.declined",
        "connection.action.confirm_refused",
        "connection.action.dropped",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["decision", "decision", "decision", "action"]);
  });

  it("files changes to what's offered, connected and configured as config", () => {
    expect(
      [
        "connection.offer_changed",
        "connection.needs_reauth",
        "connection.reconnected",
        "workflow.param.updated",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["config", "config", "config", "config"]);
  });

  it("files a model call as one, and a refused one too", () => {
    expect(typeOf("model.call")).toBe("model_call");
    expect(typeOf("model.refused")).toBe("model_call");
  });

  it("files a restricted context and a staff sign-in under permissions", () => {
    expect(typeOf("context.restricted")).toBe("permission");
    expect(typeOf("staff.session.started")).toBe("permission");
    expect(typeOf("permission.granted")).toBe("permission");
  });

  it("files what Grasp's staff read in a deployment as reads, and what they asked it to do as actions", () => {
    expect(
      [
        "admin.brain.read",
        "admin.brain.action.asked",
        "admin.brain.action.answered",
        "admin.snapshot.read",
        "admin.kickoff.read",
        "admin.command",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["read", "action", "action", "read", "read", "action"]);
  });

  it("files a visitor's sign-in, sign-out and refusals, and who may visit, under permissions, and a code sent as an action, never as configuration", () => {
    expect(
      [
        "app.visitor_signed_in",
        "app.visitor_signed_out",
        "app.visitor_refused",
        "app.visitor_listed",
        "app.visitor_unlisted",
        "app.visitor_code_sent",
      ].map((action) => typeOf(action))
    ).toStrictEqual([
      "permission",
      "permission",
      "permission",
      "permission",
      "permission",
      "action",
    ]);
  });

  it("files granting visitors a function under permissions, and a visitor's call as an action", () => {
    expect(
      [
        "app.visitor_granted",
        "app.visitor_ungranted",
        "app.visitor_called",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["permission", "permission", "action"]);
  });

  it("files a staff member's lookup of an erasure as a read, whatever it answered", () => {
    expect(
      [
        "erased",
        "erasing",
        "not_erased",
        "skipped",
        "unavailable",
        "failed",
      ].map((outcome) =>
        typeOf("admin.brain.erasure.looked_up", { kind: "person", outcome })
      )
    ).toStrictEqual(["read", "read", "read", "read", "read", "read"]);
  });

  it("files a skill share's decisions as decisions and each outcome so a search finds it, and a retirement with its outcome", () => {
    expect(
      [
        "skill.share.requested",
        "skill.share.approved",
        "skill.share.declined",
        "skill.share.added",
        "skill.share.superseded",
        "skill.retired",
        "skill.retire_done",
        "skill.retire_superseded",
      ].map((action) => typeOf(action))
    ).toStrictEqual([
      "action",
      "decision",
      "decision",
      "action",
      "action",
      "config",
      "config",
      "action",
    ]);
  });
});
