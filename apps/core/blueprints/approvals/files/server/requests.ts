import {
  AppError,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";
import type { Id, MutationCtx } from "@server/_generated/server";

// Whoever asks owns their request. The table's row rules let each person
// read and write only their own requests, and the App's builders all of
// them: builders are the approvers here.

const currency = "EUR";

const revision = v.number().integer().min(1);

const pendingRequest = async (ctx: MutationCtx, id: Id<"requests">) => {
  const request = await ctx.db.get("requests", id);
  if (request === null) {
    throw new AppError("requests.not_found", "This request is gone.");
  }
  if (request.status !== "pending") {
    throw new AppError("requests.decided", "This request is decided.");
  }
  return request;
};

export const list = query({
  args: {
    status: v.enum(["pending", "approved", "rejected"]),
    pagination: paginationOptionsValidator,
  },
  returns: paginationResultValidator(doc("requests")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("requests")
      .withIndex("by_status", (range) => range.eq("status", args.status))
      .order("desc")
      .paginate(args.pagination),
});

export const submit = mutation({
  args: {
    title: v.string().trim().min(1).max(200),
    details: v.string().trim().max(2000),
    amount: v.number().min(0).max(1_000_000_000),
  },
  returns: v.id("requests"),
  handler: async (ctx, args) =>
    await ctx.db.insert("requests", {
      title: args.title,
      details: args.details,
      amount: { currency, minorUnits: Math.round(args.amount * 100) },
      status: "pending",
      decision: null,
    }),
});

export const decide = mutation({
  args: {
    id: v.id("requests"),
    expectedRevision: revision,
    outcome: v.enum(["approved", "rejected"]),
    note: v.string().trim().max(1000),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUser();
    if (!user.roles.includes("builder")) {
      throw new AppError(
        "requests.not_approver",
        "Only the App's builders decide requests."
      );
    }
    const request = await pendingRequest(ctx, args.id);
    if (request._ownerId === user.id) {
      throw new AppError(
        "requests.own",
        "Someone else decides a request of your own."
      );
    }
    await ctx.db.patch(
      "requests",
      request._id,
      {
        status: args.outcome,
        decision: { by: user.name, note: args.note, at: Date.now() },
      },
      { expectedRevision: args.expectedRevision }
    );
    await ctx.notifyPeople(request._ownerId, {
      title: `Your request was ${args.outcome}`,
      body: request.title,
    });
    return null;
  },
});

export const withdraw = mutation({
  args: { id: v.id("requests"), expectedRevision: revision },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUser();
    const request = await pendingRequest(ctx, args.id);
    if (request._ownerId !== user.id) {
      throw new AppError(
        "requests.not_yours",
        "Only whoever asked withdraws a request."
      );
    }
    await ctx.db.delete("requests", request._id, {
      expectedRevision: args.expectedRevision,
    });
    return null;
  },
});
