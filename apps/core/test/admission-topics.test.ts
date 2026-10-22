import { admissionErrors, topicLeadMs } from "@grasp-os/shared/admission";
import type { TopicInput } from "@grasp-os/shared/admission";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { saveTopic } from "../src/knowledge/admission-records.ts";
import { saveUserMemory } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// A company's own exclusion topics: what its admins keep out of the brain
// beyond Grasp's sensitive-data minimum. These tests start from the ways
// they can fail: someone but the company's admins changes them (a member,
// Grasp staff); a new topic lets writes through until it takes effect;
// retiring one loosens admission before its retirement is in effect; a
// topic edit loosens or rewrites Grasp's own topics; two admins' revisions
// overwrite each other; a topic's name or terms reach the audit log; and
// a revision saved while a write is being checked lets that write commit
// after the revision took effect, unchecked against it.

const idp = mockIdp();

/** A topic about a confidential project, with `term` as its one term. */
const topicWith = (term: string): TopicInput => ({
  ifRevision: 0,
  name: "Project Falcon",
  coverage: "The planned acquisition, code-named Falcon.",
  examples: [{ language: "en", text: `The ${term} deal closes in May.` }],
  terms: [term],
});

/** A signed-in person with a collection of their own. */
const personWithCollection = async (role: "admin" | "user" = "admin") => {
  const person = await signedInApi(idp, role);
  const { id } = await person.api.knowledge.createCollection({
    name: `Notes ${unique()}`,
    access: "me",
  });
  return { ...person, collectionId: id };
};

/** A unique word, as a confidential code name. */
const codeName = () => `falcon${unique().replaceAll("-", "")}`;

describe("company topics", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are changed by the company's admins only, and listed for admins, Grasp staff included", async () => {
    const user = await signedInApi(idp, "user");
    const builder = await signedInApi(idp, "builder");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = { api: staffCore.authenticate() };
    const admin = await signedInApi(idp, "admin");
    const topic = topicWith(codeName());

    expect({
      userSaves: await outcome(user.api.admission.saveTopic(topic)),
      builderSaves: await outcome(builder.api.admission.saveTopic(topic)),
      staffSaves: await outcome(staff.api.admission.saveTopic(topic)),
      userLists: await outcome(user.api.admission.topics()),
      staffLists: await outcome(staff.api.admission.topics()),
      adminSaves: await outcome(admin.api.admission.saveTopic(topic)),
    }).toStrictEqual({
      userSaves: "role.forbidden",
      builderSaves: "role.forbidden",
      staffSaves: "role.forbidden",
      userLists: "role.forbidden",
      staffLists: "ok",
      adminSaves: "ok",
    });
  });

  it("keep a topic's text out from the moment it's saved, and record only its ID and revision", async () => {
    const admin = await personWithCollection();
    const term = codeName();
    let saved:
      | Awaited<ReturnType<typeof admin.api.admission.saveTopic>>
      | undefined;
    const events = await auditedDuring(async () => {
      saved = await admin.api.admission.saveTopic({
        ...topicWith(term),
        // Sooner than the lead: moved to it.
        effectiveAt: new Date(Date.now() - 3_600_000).toISOString(),
      });
    });
    const save = async (path: string, text: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: admin.collectionId,
          path,
          text,
          ifVersion: 0,
        })
      );
    await admin.api.admission.saveTopic({
      ...topicWith(`${term}x*`),
      name: "Stem",
    });
    const topics = await admin.api.admission.topics();
    const mine = topics.find(
      ({ upcoming, current }) => (upcoming ?? current)?.id === saved?.id
    );

    expect({
      leadKept:
        Date.parse(saved?.effectiveAt ?? "") >= Date.now() + topicLeadMs - 5000,
      // Its terms as matched: any case or accents, any hyphenation.
      excluded: await save(
        "plan.md",
        `# Plan\nThe ${term.toUpperCase()} deal.`
      ),
      other: await save("runbook.md", "# Runbook\nRestart the queue."),
      // A trailing `*` matches any ending.
      stem: await save("stem.md", `The ${term}xyz deal.`),
      // Grasp's own topics, first, and unchanged.
      platformFirst: topics[0]?.current?.owner,
      health: await save("leave.md", "She is on sick leave."),
      listed: {
        upcoming: mine?.upcoming?.name,
        terms: mine?.upcoming?.terms,
        current: mine?.current ?? null,
      },
      events: events.map(({ action, target, detail }) => ({
        action,
        target,
        keys: Object.keys(detail).toSorted(),
      })),
      leaks: JSON.stringify(events).includes(term),
    }).toStrictEqual({
      leadKept: true,
      excluded: "knowledge.excluded",
      other: "ok",
      stem: "knowledge.excluded",
      platformFirst: "platform",
      health: "knowledge.held",
      listed: { upcoming: "Project Falcon", terms: [term], current: null },
      events: [
        {
          action: "knowledge.admission.topic_saved",
          target: { type: "admission_topic", id: saved?.id },
          keys: ["effectiveAt", "revision"],
        },
      ],
      leaks: false,
    });
  });

  it("keep applying a retired topic until its retirement is in effect", async () => {
    const admin = await personWithCollection();
    const term = codeName();
    const saved = await admin.api.admission.saveTopic(topicWith(term));
    const retired = await admin.api.admission.retireTopic({
      id: saved.id,
      ifRevision: 1,
    });
    const text = `# Plan\nThe ${term} deal.`;
    const save = async (path: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: admin.collectionId,
          path,
          text,
          ifVersion: 0,
        })
      );
    const beforeEffect = await save("before.md");
    // Two minutes on: the retirement is in effect.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * topicLeadMs);
    const afterEffect = await save("after.md");

    expect({
      retired: [retired.revision, retired.retired],
      again: await outcome(
        admin.api.admission.retireTopic({ id: saved.id, ifRevision: 2 })
      ),
      revived: await outcome(
        admin.api.admission.saveTopic({
          ...topicWith(term),
          id: saved.id,
          ifRevision: 2,
        })
      ),
      beforeEffect,
      afterEffect,
    }).toStrictEqual({
      retired: [2, true],
      again: "admission.retired",
      revived: "admission.retired",
      beforeEffect: "knowledge.excluded",
      afterEffect: "ok",
    });
  });

  it("refuse to change Grasp's topics, and a revision from one that moved on", async () => {
    const admin = await signedInApi(idp, "admin");
    const term = codeName();
    const saved = await admin.api.admission.saveTopic(topicWith(term));
    const revise = async () =>
      await outcome(
        admin.api.admission.saveTopic({
          ...topicWith(term),
          id: saved.id,
          ifRevision: 1,
          name: "Project Falcon (renamed)",
        })
      );
    const [first, second] = await Promise.all([revise(), revise()]);
    const platform = await outcome(
      admin.api.admission.retireTopic({
        // Not a company topic's ID.
        id: "health",
        ifRevision: 1,
      })
    );
    const missing = await outcome(
      admin.api.admission.retireTopic({
        id: `company-${crypto.randomUUID()}`,
        ifRevision: 1,
      })
    );
    const noTerms = await outcome(
      admin.api.admission.saveTopic({ ...topicWith(term), terms: [] })
    );

    expect({
      revisions: [first, second].toSorted(),
      platform,
      missing,
      noTerms,
      message: admissionErrors.create("admission.conflict").message.length > 0,
    }).toStrictEqual({
      revisions: ["admission.conflict", "ok"],
      platform: "admission.invalid",
      missing: "admission.not_found",
      noTerms: "admission.invalid",
      message: true,
    });
  });

  it("check a write again when a topic may have taken effect between its check and its commit", async () => {
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const asAgent = actingFor(agent, user.userId);
    const work = await newChat(agent);
    const term = codeName();
    const remembered = await outcome(
      saveUserMemory(
        env,
        asAgent,
        work,
        { type: "own" },
        { text: `Works on the ${term} deal.`, ifVersion: 0 },
        // Between admission and the batch: an admin saves a topic, and
        // the write is held up until after it took effect.
        async () => {
          await saveTopic(
            env,
            {
              userId: admin.userId,
              email: "",
              name: "",
              role: "admin",
              teams: [],
              staff: false,
              expiresAt: "",
            },
            topicWith(term)
          );
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + topicLeadMs + 1000);
        }
      )
    );
    const { results } = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS stored FROM versions WHERE text LIKE ?"
    )
      .bind(`%${term}%`)
      .all<{ stored: number }>();

    expect({ remembered, stored: results[0]?.stored }).toStrictEqual({
      remembered: "knowledge.excluded",
      stored: 0,
    });
  });
});
