import { AppError, resource, v } from "@grasp-os/sdk";

import { action } from "#grasp/server";

import { notesMax, shortTextMax, sourceFields } from "../schema.ts";
import { reviewer } from "./drafts.ts";

// Stakeholder chats: the intake invites someone on the team who isn't a
// member to a short chat about their work, through the platform's guest
// chats (the `guests` resource, which an admin binds to the `GUESTS`
// permission), guided by the Grasp skill `interview-a-stakeholder`. What
// they write comes back as notes (`notes`), which the `extract` workflow
// reads like any other, into a draft someone reviews. Their words are
// untrusted: the draft and the source it becomes are marked a guest's,
// which only `extract` proposing it from a chat sets (drafts.ts).
//
// The intake is its builders' (an admin is one on every App): each action
// here first reads whether the caller may review drafts (`reviewer`), which
// the store refuses anyone else, so no one else invites, lists, reads or
// revokes a chat. A workflow run reads a chat as the person who started
// it, under the same check.

export const guests = resource.guests("guests", {
  operations: ["invite", "list", "read", "revoke"],
});

/** The skill a stakeholder's chat follows. */
export const interviewSkill = "interview-a-stakeholder";

/** Most characters of one question a chat's notes keep: its question, mostly. */
const questionKept = 300;

/** Most days a chat's link works, and how many unless asked. */
const daysMax = 14;
const daysDefault = 7;

/** A guest chat, as the screen lists it. */
const chat = v.object({
  id: v.string(),
  name: v.string(),
  status: v.enum(["open", "finished", "revoked", "expired"]),
  turns: v.number().integer().min(0),
  createdAt: v.string(),
  expiresAt: v.string(),
  endedAt: v.string().nullable(),
});

/** A chat's line, as the model reads it: who said it, and what. */
const line = v.object({
  role: v.enum(["guest", "question"]),
  text: v.string(),
});

/** A guest chat, as the platform lists it. */
interface Chat {
  id: string;
  name: string;
  status: "open" | "finished" | "revoked" | "expired";
  turns: number;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
}

/** A guest chat with what was written in it: untrusted text. */
interface Transcript extends Chat {
  messages: { role: "guest" | "agent"; text: string; at: string }[];
}

/** A chat as the screen lists it: without who it spends the budget of. */
const listed = (found: Chat): Chat => ({
  id: found.id,
  name: found.name,
  status: found.status,
  turns: found.turns,
  createdAt: found.createdAt,
  expiresAt: found.expiresAt,
  endedAt: found.endedAt,
});

/** The code of a failure, when it has one. */
const codeOf = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : null;

/**
 * What the intake shows the caller: whether they may review drafts, and
 * the stakeholder chats, null while the App may not invite anyone (no
 * `GUESTS` binding yet) or the caller may not review.
 */
export const overview = action({
  args: {},
  returns: v.object({
    writable: v.boolean(),
    chats: v.array(chat).nullable(),
  }),
  uses: [reviewer, guests],
  handler: async (ctx) => {
    try {
      await ctx.runQuery(reviewer, {});
    } catch (error) {
      if (codeOf(error) === "data.access_denied") {
        return { writable: false, chats: null };
      }
      throw error;
    }
    try {
      const chats = await ctx.resources.guests.list();
      return { writable: true, chats: chats.map(listed) };
    } catch (error) {
      if (codeOf(error) === "resource.unavailable") {
        return { writable: true, chats: null };
      }
      throw error;
    }
  },
});

/** Invites someone to a chat: the answer holds its link, shown once. */
export const invite = action({
  args: {
    name: v.string().trim().min(1).max(100),
    days: v.number().integer().min(1).max(daysMax).default(daysDefault),
  },
  returns: v.object({ chat, link: v.string() }),
  uses: [reviewer, guests],
  handler: async (ctx, args) => {
    await ctx.runQuery(reviewer, {});
    const invited = await ctx.resources.guests.invite({
      name: args.name,
      skill: interviewSkill,
      days: args.days,
    });
    return { chat: listed(invited), link: invited.link };
  },
});

/** Stops a chat's link for good. */
export const revoke = action({
  args: { id: v.string().min(1).max(100) },
  returns: chat,
  uses: [reviewer, guests],
  handler: async (ctx, args) => {
    await ctx.runQuery(reviewer, {});
    return listed(await ctx.resources.guests.revoke(args.id));
  },
});

/**
 * A finished chat as notes, for `extract` to read: its source, its text as
 * people read it, and its lines as the model reads them, each said by
 * whom, as data, so nothing the guest writes can pass for a question. A
 * chat without an answer of the guest's has nothing to read
 * (`intake.empty_chat`).
 */
export const notes = action({
  args: { chat: v.string().min(1).max(100) },
  returns: v.object({
    source: v.object({
      title: sourceFields.title,
      medium: sourceFields.medium,
      date: sourceFields.date,
      from: sourceFields.from,
    }),
    notes: v.string().max(notesMax),
    lines: v.array(line),
  }),
  uses: [reviewer, guests],
  handler: async (ctx, args) => {
    await ctx.runQuery(reviewer, {});
    const read: Transcript = await ctx.resources.guests.read(args.chat);
    if (!read.messages.some(({ role }) => role === "guest")) {
      throw new AppError(
        "intake.empty_chat",
        "The stakeholder hasn't answered anything yet."
      );
    }
    const lines = read.messages.map(({ role, text }) =>
      role === "guest"
        ? { role: "guest" as const, text }
        : {
            role: "question" as const,
            text:
              text.length > questionKept
                ? `${text.slice(0, questionKept)}…`
                : text,
          }
    );
    const text = lines
      .map(({ role, text: said }) =>
        role === "guest" ? `${read.name}: ${said}` : `Question: ${said}`
      )
      .join("\n\n");
    return {
      source: {
        title: `Chat with ${read.name}`.slice(0, shortTextMax),
        medium: "chat" as const,
        date: (read.endedAt ?? read.createdAt).slice(0, 10),
        from: read.name.slice(0, shortTextMax),
      },
      notes: text.length > notesMax ? text.slice(0, notesMax) : text,
      lines,
    };
  },
});
