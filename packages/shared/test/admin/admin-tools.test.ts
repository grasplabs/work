import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { needsGrasp } from "../../src/admin/admin-integrations.ts";
import type { Rollout } from "../../src/admin/admin-platform.ts";
import { ADMIN_SOURCES } from "../../src/admin/admin-sources.ts";
import {
  ADMIN_TOOLS,
  adminDocument,
  callAdminTool,
  findOrganization,
  MEASURES,
  MILESTONE,
} from "../../src/admin/admin-tools.ts";
import type { Fleet } from "../../src/admin/admin-tools.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import { SAMPLE_BUILDS } from "./fixtures/admin-integrations-sample.ts";
import {
  SAMPLE_PLATFORMS,
  SAMPLE_RELEASES,
} from "./fixtures/admin-platform-sample.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";
import {
  HARTOG_CONVERSATION,
  NOORDKADE_CONVERSATION,
  VANRIJN_CONVERSATION,
  VELDKAMP_CONVERSATION,
} from "./fixtures/admin-transcripts.ts";

const today = "2026-10-02";
const views = SAMPLE_ORGS.map((org) => adminViewOf(org, org.seed, today));
const call = (name: string, input: Record<string, unknown> = {}) =>
  callAdminTool(name, input, views, today);
const rollout: Rollout = {
  id: "ro",
  kind: "release",
  release: "r418-3f9c2ab",
  status: "waiting",
  ring: 1,
  by: "Nick",
  at: "2026-10-14",
  targets: [],
};
const fleet: Fleet = {
  platforms: Object.entries(SAMPLE_PLATFORMS).map(([org, platform]) => ({
    org,
    platform,
  })),
  releases: SAMPLE_RELEASES,
  rollout,
};
/** A transcript's line without who said it: "Mark Jansen: …" is "…". */
const SPEAKER = /^\S+\s+[^:]+:\s*/u;

describe("the admin’s tools", () => {
  it("only read: whatever changes a company stays a button in the admin", () => {
    for (const tool of ADMIN_TOOLS) {
      expect(tool.annotations.readOnlyHint).toBeTruthy();
    }
  });

  it("answers every tool it lists, and no other", () => {
    for (const tool of ADMIN_TOOLS) {
      const input =
        "required" in tool.inputSchema
          ? Object.fromEntries(
              tool.inputSchema.required.map((field) => [
                field,
                field === "measure" ? "known" : "Hartog",
              ])
            )
          : {};
      expect(call(tool.name, input).failed).toBeUndefined();
    }
    for (const name of [
      "delete_organization",
      "toString",
      "__proto__",
      "constructor",
    ]) {
      expect(call(name).failed).toBeTruthy();
    }
  });

  it("lists one phase when asked, and refuses a phase there is not", () => {
    const ready = call("list_organizations", { phase: "ready" });
    expect(ready.structured).toStrictEqual({
      organizations: [
        expect.objectContaining({ id: "noordkade", phase: "ready" }),
      ],
    });
    expect(call("list_organizations", { phase: "later" }).failed).toBeTruthy();
  });

  it("finds an organization by its id or a part of its name, and says so when that is not one", () => {
    expect(findOrganization(views, "hartog")).toBe(views[3]);
    expect(findOrganization(views, "van rijn")).toBe(views[2]);
    expect(findOrganization(views, "nobody")).toContain("No organization fits");
    expect(call("brief", { organization: "" }).failed).toBeTruthy();
  });

  it("ranks by a measure, the most first", () => {
    for (const measure of MEASURES) {
      const answer = call("compare_organizations", { measure });
      const ranked = z
        .array(z.object({ value: z.number() }))
        .parse(answer.structured?.ranked);
      expect(ranked).toHaveLength(views.length);
      expect(ranked.map((each) => each.value)).toStrictEqual(
        ranked.map((each) => each.value).toSorted((a, b) => b - a)
      );
    }
  });

  it("lists everything that needs Grasp, at every organization", () => {
    const { needs } = z
      .object({ needs: z.array(z.unknown()) })
      .parse(call("what_needs_grasp").structured);
    expect(needs).toHaveLength(
      views.reduce((sum, view) => sum + view.needs.length, 0)
    );
  });

  it("calls out in the digest who passed the milestone and is still closed", () => {
    const digest = call("daily_digest").text;
    const past = views.filter(
      (view) => !view.open && view.knowledge.percent >= MILESTONE
    );
    expect(past.length).toBeGreaterThan(0);
    for (const view of past) {
      expect(digest).toContain(view.org.name);
    }
    expect(digest).toContain(`Past ${MILESTONE}% known`);
  });

  it("never tells what anyone said: no line of a conversation reaches a chat or a tool's answer", () => {
    const answers = [
      adminDocument(views, today, SAMPLE_BUILDS, fleet),
      ...ADMIN_TOOLS.flatMap((tool) =>
        views.map((view) => {
          const answer = callAdminTool(
            tool.name,
            { organization: view.org.id, measure: "known" },
            views,
            today,
            SAMPLE_BUILDS,
            fleet
          );
          return `${answer.text}\n${JSON.stringify(answer.structured ?? {})}`;
        })
      ),
    ].join("\n");
    const said = [
      NOORDKADE_CONVERSATION,
      VELDKAMP_CONVERSATION,
      VANRIJN_CONVERSATION,
      HARTOG_CONVERSATION,
    ]
      .flatMap((conversation) => conversation.split("\n"))
      .map((line) => line.replace(SPEAKER, ""))
      .filter((line) => line.length > 30);
    expect(said.length).toBeGreaterThan(0);
    for (const line of said) {
      expect(answers).not.toContain(line);
    }
  });
});

describe("the integrations to build, in a chat", () => {
  const answer = callAdminTool(
    "integrations_to_build",
    {},
    views,
    today,
    SAMPLE_BUILDS
  );

  it("lists every one with where it stands and who asked, what waits on Grasp first", () => {
    const listed = z
      .array(
        z.object({
          app: z.string(),
          waitsOn: z.string(),
          askedBy: z.array(z.object({ organization: z.string() })),
        })
      )
      .parse(answer.structured?.integrations);
    expect(listed.map((each) => each.app).toSorted()).toStrictEqual(
      SAMPLE_BUILDS.map((build) => build.app).toSorted()
    );
    const waiting = SAMPLE_BUILDS.filter(needsGrasp).length;
    expect(
      listed.slice(0, waiting).every((each) => each.waitsOn === "grasp")
    ).toBeTruthy();
    for (const each of listed) {
      expect(each.askedBy.length).toBeGreaterThan(0);
    }
    expect(answer.text).toContain("Transporeon: the pull request is in review");
    expect(answer.text).toContain("Hartog Groothandel (Booking in a delivery)");
  });

  it("says so when nothing is asked for, as on a server that has none", () => {
    expect(call("integrations_to_build").text).toContain("No integration");
  });

  it("goes into what the admin’s chat reads, when it is given them", () => {
    expect(adminDocument(views, today, SAMPLE_BUILDS)).toContain(
      "Integrations to build, for every company:"
    );
    expect(adminDocument(views, today)).not.toContain("Integrations to build");
  });
});

describe("every company’s platform, in a chat", () => {
  it("says how each company’s platform stands, what needs a look, and the release going out", () => {
    const answer = callAdminTool("platforms", {}, views, today, [], fleet);
    expect(answer.failed).toBeUndefined();
    expect(answer.text).toContain("Hartog Groothandel: attention");
    expect(answer.text).toContain("needs a look: failed, errors, secrets");
    expect(answer.text).toContain("Van Rijn Accountants: not set up yet.");
    expect(answer.text).toContain(
      "waiting for someone at Grasp to approve ring 2"
    );
  });

  it("goes into what the admin’s chat reads, when it is given them", () => {
    expect(adminDocument(views, today, [], fleet)).toContain(
      "Every company’s own platform:"
    );
  });

  it("says it knows none while the admin does not read the console", () => {
    expect(callAdminTool("platforms", {}, views, today).text).toContain(
      "does not read the console yet"
    );
  });
});

describe("the sources of the admin", () => {
  it("has the admin’s own MCP live, and every source in an order of its own", () => {
    expect(ADMIN_SOURCES.find((source) => source.id === "grasp")?.state).toBe(
      "live"
    );
    expect(new Set(ADMIN_SOURCES.map((source) => source.order)).size).toBe(
      ADMIN_SOURCES.length
    );
  });
});
