import { sso } from "@better-auth/sso";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import { staffWindowOpen } from "@grasp-os/shared/deployment-config";
import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import { fromBase64Url } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { appTokenMs, portableFunctionPath } from "@grasp-os/shared/portable";
import { roleSchema } from "@grasp-os/shared/roles";
import { routerClientIpHeader } from "@grasp-os/shared/router";
import type { SignInRefusal } from "@grasp-os/shared/sign-in";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins/jwt";
import type { Jwk } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { defaultAc } from "better-auth/plugins/organization/access";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import {
  auditedBatch,
  keepAuditEvent,
  outboxedIfChanged,
} from "../audit-outbox.ts";
import {
  accounts,
  invitations,
  jwks,
  memberRemovals,
  members,
  organizations,
  sessions,
  ssoProviders,
  teamMembers,
  teams,
  users,
  verifications,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { mayComeIn, staffMayStay } from "../onboarding/gate.ts";
import { checkClaims } from "./claims.ts";
import { devIdpOrigin, oidcProviders, providerIds } from "./config.ts";
import type { OidcProvider } from "./config.ts";
import { keyIdOf, keyRing } from "./token-keys.ts";
import type { KeyRing, KeyUse } from "./token-keys.ts";

/** Better Auth's routes, under core's API. */
export const authBasePath = "/api/auth";

/** The deployment's one organization, created on the first sign-in. */
export const organizationId = "organization";

const hour = 60 * 60 * 1000;
/**
 * Sessions end after this and are never extended: people sign in with their
 * IdP again, which re-checks them there (an offboarded person keeps access
 * for at most this long without a revocation).
 */
const sessionMs = 12 * hour;
/** Staff sessions end sooner, and never after the staff window closes. */
const staffSessionMs = hour;

/** How long one key signs App tokens before the next replaces it: 30 days. */
const keyRotationSeconds = 30 * 24 * 60 * 60;

/**
 * Who App tokens are for: a portable host's calls of this deployment's
 * App functions, and nothing else that reads a token of core's.
 */
export const appTokenAudience = (origin: string): string =>
  `${origin}${portableFunctionPath}`;

/**
 * Roles as the organization plugin checks them. Admins manage teams (the
 * plugin asks for `member: update` and `member: delete` to put someone on
 * a team or take them off); builders and users manage nothing here.
 * Memberships and roles aren't the plugin's: core changes them
 * (`members.ts`), each in one statement that keeps the organization an
 * admin, which the plugin's read-then-write routes can't, so those routes
 * are off. Admin is also the plugin's creator role, which the plugin
 * allows everything it offers; the route allowlist (`routes.ts`) decides
 * what that is.
 */
const roles = {
  admin: defaultAc.newRole({
    member: ["update", "delete"],
    team: ["create", "update", "delete"],
  }),
  builder: defaultAc.newRole({}),
  user: defaultAc.newRole({}),
};

const schema = {
  users,
  sessions,
  accounts,
  verifications,
  organizations,
  members,
  invitations,
  teams,
  teamMembers,
  ssoProviders,
  jwks,
};

/** Better Auth's log lines, message only: arguments can hold tokens or claims. */
const authLogger = {
  level: "warn" as const,
  log: (level: "debug" | "info" | "warn" | "error", message: string) => {
    log[level === "error" ? "error" : "warn"]("auth", { message });
  },
};

/**
 * That an admin hasn't removed `userId` (an ID, or the column holding one)
 * from the organization, as a SQL condition. A removal is kept after the
 * membership goes, so every read and write of a membership checks it:
 * nothing brings a removed person back.
 */
export const notRemoved = (
  userId: string | SQLiteColumn
): SQL => sql`NOT EXISTS (
  SELECT 1 FROM ${memberRemovals}
  WHERE ${memberRemovals.organizationId} = ${organizationId}
    AND ${memberRemovals.userId} = ${userId}
)`;

/**
 * `userId`'s current membership of the organization, as a SQL condition on
 * `members`: none once an admin removed them.
 */
export const currentMembership = (userId: string): SQL | undefined =>
  and(
    eq(members.organizationId, organizationId),
    eq(members.userId, userId),
    notRemoved(userId)
  );

/** Whether an admin removed `userId` from the organization. */
export const isRemoved = async (env: Env, userId: string): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ member: number }>(
    sql`SELECT ${notRemoved(userId)} AS member`
  );
  return row.member === 0;
};

/**
 * That the organization has an admin now, other than `except` when given,
 * as a SQL condition.
 */
export const activeAdminExists = (except?: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${members}
  WHERE ${members.organizationId} = ${organizationId}
    AND ${members.role} = 'admin'
    AND ${notRemoved(members.userId)}
    ${except === undefined ? sql`` : sql`AND ${members.userId} <> ${except}`}
)`;

/**
 * That `userId` (an ID, or a column holding one) is an active member of
 * the organization now, with one of `roles` if given, as a SQL condition.
 */
export const activeMember = (
  userId: string | SQLiteColumn,
  withRoles?: readonly string[]
): SQL => sql`EXISTS (
  SELECT 1 FROM ${members}
  WHERE ${members.organizationId} = ${organizationId}
    AND ${members.userId} = ${userId}
    ${withRoles === undefined ? sql`` : sql`AND ${inList(members.role, withRoles)}`}
    AND ${notRemoved(userId)}
)`;

/**
 * Records a change Better Auth has made. Better Auth commits the change
 * itself, so its event can't join the change's batch; a failed request
 * wouldn't undo the change, so recording it never fails the request.
 */
const record = async (env: Env, entry: AuditEntry): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), entry);
};

/**
 * Makes a configured admin (deployment config, from the console) an admin
 * again when the organization has none left, so a deployment can always
 * be recovered by signing in. Never someone removed. The change and its
 * audit event are one batch: both are kept, or neither.
 */
const restoreAdmin = async (env: Env, userId: string): Promise<void> => {
  const db = drizzle(env.DB);
  const [membership] = await db
    .select({ id: members.id })
    .from(members)
    .where(currentMembership(userId));
  if (!membership) {
    return;
  }
  await auditedBatch(env, db, [
    db
      .update(members)
      .set({ role: "admin" })
      .where(
        and(
          eq(members.id, membership.id),
          notRemoved(userId),
          sql`NOT ${activeAdminExists()}`
        )
      ),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "member.role.updated",
      target: { type: "member", id: membership.id },
      detail: { userId, role: "admin", reason: "no_admin_left" },
    }),
  ]);
};

/**
 * That an invitation (a row of `invitations`) is open at `now`, as SQL: in
 * the organization, nobody has taken it up or withdrawn it, it hasn't
 * lapsed, and whoever made it is still an admin, so an admin's demotion or
 * removal also ends what they invited. Listing, inviting and joining all
 * read it (`members.ts`), and joining checks it again in the statements
 * that act on it.
 */
export const openInvitationAt = (now: number): SQL =>
  and(
    eq(invitations.organizationId, organizationId),
    eq(invitations.status, "pending"),
    sql`${invitations.expiresAt} > ${now}`,
    activeMember(invitations.inviterId, ["admin"])
  ) ?? sql`0`;

/** That invitation `id` is open at `now`, as SQL on its own. */
const isOpenInvitation = (id: string, now: number): SQL => sql`EXISTS (
  SELECT 1 FROM ${invitations}
  WHERE ${invitations.id} = ${id} AND ${openInvitationAt(now)}
)`;

/** The open invitation of `email`, if any: the newest. */
const openInvitation = async (
  env: Env,
  email: string,
  now: number
): Promise<{ id: string; role: string } | undefined> => {
  const [invitation] = await drizzle(env.DB)
    .select({ id: invitations.id, role: invitations.role })
    .from(invitations)
    .where(and(eq(invitations.email, email), openInvitationAt(now)))
    .orderBy(desc(invitations.createdAt))
    .limit(1);
  const role = roleSchema.safeParse(invitation?.role);
  return invitation && role.success
    ? { id: invitation.id, role: role.data }
    : undefined;
};

/**
 * Makes someone signing in from the client's IdP a member of the deployment's
 * organization, creating it on the first sign-in, unless an admin removed
 * them. Runs on every sign-in, so a membership whose creation failed is
 * created next time; an existing one, and its role, is kept, except that a
 * configured admin is made admin again when nobody else is one.
 *
 * Someone joining takes up their open invitation (`members.ts`), in one
 * batch with the membership: the membership gets the invited role only if
 * the invitation is still open as the insert runs, so one withdrawn, lapsed
 * or orphaned since it was read gives nothing; and it is taken up, audited,
 * only by the insert that made them a member, this one. A configured admin
 * joins as admin, and takes up an invitation too.
 *
 * The removal check is part of the insert itself, one statement: a removal
 * records its marker before it deletes the membership (`members.ts`), so
 * an insert racing it either lands first and is deleted, or sees the
 * marker and inserts nothing.
 */
const ensureMember = async (
  env: Env,
  config: SignInConfig,
  userId: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  // Config emails are lowercased when parsed; Better Auth lowercases the IdP's.
  const email = user?.email.toLowerCase();
  const configuredAdmin = email !== undefined && config.admins.includes(email);
  const now = new Date();
  const invitation =
    email === undefined
      ? undefined
      : await openInvitation(env, email, now.getTime());
  const invited =
    invitation === undefined
      ? sql`0`
      : isOpenInvitation(invitation.id, now.getTime());
  const role = configuredAdmin
    ? sql`'admin'`
    : sql`CASE WHEN ${invited} THEN ${invitation?.role ?? "user"} ELSE 'user' END`;
  await db
    .insert(organizations)
    .values({
      id: organizationId,
      name: "Organization",
      slug: organizationId,
      createdAt: now,
    })
    .onConflictDoNothing();
  const memberId = crypto.randomUUID();
  const join = db
    .insert(members)
    .select(
      sql`SELECT ${memberId}, ${organizationId}, ${userId}, ${role}, ${now.getTime()}
        WHERE ${notRemoved(userId)}`
    )
    .onConflictDoNothing();
  await (invitation === undefined
    ? join
    : auditedBatch(env, db, [
        join,
        db
          .update(invitations)
          .set({ status: "accepted" })
          .where(
            and(
              eq(invitations.id, invitation.id),
              openInvitationAt(now.getTime()),
              sql`EXISTS (SELECT 1 FROM ${members} WHERE ${members.id} = ${memberId})`
            )
          ),
        outboxedIfChanged(db, {
          actor: actorOf({ userId, staff: false }),
          action: "member.invitation.accepted",
          target: { type: "invitation", id: invitation.id },
          detail: { userId, role: configuredAdmin ? "admin" : invitation.role },
        }),
      ]));
  if (configuredAdmin) {
    await restoreAdmin(env, userId);
  }
  return !(await isRemoved(env, userId));
};

/**
 * Whether the gate lets `userId` in: checked again as their session is
 * made, beside the check of their claims (`validateUserInfo`).
 */
const gateLetsIn = async (
  env: Env,
  config: SignInConfig,
  userId: string
): Promise<boolean> => {
  const [user] = await drizzle(env.DB)
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return await mayComeIn(env, config, user?.email);
};

/**
 * The session a sign-in through `providerId` gets, or `false` for none.
 * Staff sessions are marked and cut short; everyone else's opens in the
 * deployment's organization, as a member.
 */
const startSession = async <T extends { expiresAt: Date; userId: string }>(
  env: Env,
  config: SignInConfig,
  session: T,
  providerId: string | undefined
) => {
  const now = Date.now();
  if (providerId === providerIds.staff && config.staff) {
    // A window the company's admin ended, or onboarding access past its
    // week after Grasp's go, lets nobody sign in (onboarding/gate.ts).
    if (
      !(
        staffWindowOpen(config, now) &&
        (await staffMayStay(env, config.staff.opened, config.staff.scope, now))
      )
    ) {
      return false;
    }
    const expiresAt = Math.min(
      now + staffSessionMs,
      Date.parse(config.staff.until)
    );
    return {
      data: { ...session, staff: true, expiresAt: new Date(expiresAt) },
    };
  }
  const fromClient =
    providerId === providerIds.entra || providerId === providerIds.google;
  if (
    !(
      fromClient &&
      (await gateLetsIn(env, config, session.userId)) &&
      (await ensureMember(env, config, session.userId))
    )
  ) {
    // Sessions come only from an SSO callback, for members.
    return false;
  }
  return {
    data: { ...session, staff: false, activeOrganizationId: organizationId },
  };
};

const idTokenClaimsSchema = z.looseObject({ oid: z.string().optional() });

/** The `oid` claim of an ID token the SSO plugin verified in this request. */
const oidOf = (idToken: unknown): string | null => {
  const payload = typeof idToken === "string" ? idToken.split(".")[1] : "";
  if (payload === undefined || payload === "") {
    return null;
  }
  try {
    const json = new TextDecoder().decode(fromBase64Url(payload));
    return idTokenClaimsSchema.parse(JSON.parse(json)).oid ?? null;
  } catch {
    return null;
  }
};

/**
 * What is kept of an account from a sign-in: no IdP tokens (core never
 * holds provider tokens, R1), only the Entra object id taken from the ID
 * token before it is dropped.
 */
const withoutTokens = <T extends Record<string, unknown>>(account: T) => ({
  data: {
    ...account,
    ...(account.idToken === undefined ? {} : { oid: oidOf(account.idToken) }),
    accessToken: null,
    refreshToken: null,
    idToken: null,
  },
});

/** The ids a member or team change names; nothing else is recorded. */
const changeSchema = z.looseObject({
  teamId: z.string().optional(),
  userId: z.string().optional(),
});
const returnedSchema = z.looseObject({ id: z.string().optional() });

type Change = z.infer<typeof changeSchema>;
type Returned = z.infer<typeof returnedSchema>;

/**
 * The team changes that are audited (R16): what each records, from the
 * request and what the route returned. Identifiers only.
 */
const auditedChanges: Record<
  string,
  (
    change: Change,
    returned: Returned
  ) => Pick<AuditEntry, "action" | "target" | "detail">
> = {
  "/organization/create-team": (_change, returned) => ({
    action: "team.created",
    target: { type: "team", id: returned.id ?? "unknown" },
  }),
  "/organization/update-team": (change) => ({
    action: "team.updated",
    target: { type: "team", id: change.teamId ?? "unknown" },
  }),
  "/organization/remove-team": (change) => ({
    action: "team.deleted",
    target: { type: "team", id: change.teamId ?? "unknown" },
  }),
  "/organization/add-team-member": (change) => ({
    action: "team.member.added",
    target: { type: "team", id: change.teamId ?? "unknown" },
    detail: { userId: change.userId ?? null },
  }),
  "/organization/remove-team-member": (change) => ({
    action: "team.member.removed",
    target: { type: "team", id: change.teamId ?? "unknown" },
    detail: { userId: change.userId ?? null },
  }),
};

/** Each env's token keys, as its isolate holds them, whatever its providers. */
const tokenRings = new WeakMap<Env, KeyRing<Jwk>>();

/** The token keys `env`'s isolate holds (token-keys.ts). */
export const tokenKeysOf = (env: Env): KeyRing<Jwk> => {
  const ring = tokenRings.get(env) ?? keyRing<Jwk>();
  tokenRings.set(env, ring);
  return ring;
};

/**
 * What the JWT plugin asks its keys for, by the call that asks: only
 * `signJWT` sends a `payload`; every other call checks a token, naming
 * the key its header does, if that can be read at all.
 */
const keyUseOf = (body: unknown): KeyUse => {
  if (typeof body === "object" && body !== null && "payload" in body) {
    return { sign: true };
  }
  const token: unknown =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "token")
      : undefined;
  return typeof token === "string"
    ? { kid: keyIdOf(token), token }
    : { kid: undefined };
};

const createAuth = (
  env: Env,
  config: SignInConfig,
  providers: OidcProvider[]
) => {
  const db = drizzle(env.DB);
  const tokenKeys = tokenKeysOf(env);
  return betterAuth({
    appName: "Grasp",
    // The deployment's own address from its config, never the request's:
    // core is reached on its workers.dev address through the router.
    baseURL: config.origin,
    basePath: authBasePath,
    // The SSO plugin calls no IdP on a private address unless it is
    // trusted: only a local stack's stand-in for Entra (config.ts) is.
    trustedOrigins: [devIdpOrigin(env, config)].filter(
      (origin) => origin !== undefined
    ),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
      schema,
    }),
    // One door out (R13): nothing leaves core but the sign-in itself.
    telemetry: { enabled: false },
    logger: authLogger,
    // Better Auth keeps its counts per isolate, so its limits would limit
    // nothing across a deployment. Rate limits on sign-in belong at the
    // router, in front of every core.
    rateLimit: { enabled: false },
    session: {
      expiresIn: sessionMs / 1000,
      disableSessionRefresh: true,
      additionalFields: {
        staff: { type: "boolean", defaultValue: false, input: false },
      },
    },
    // Never link an IdP account to an existing user by email.
    account: {
      accountLinking: { enabled: false },
      additionalFields: {
        oid: { type: "string", required: false, input: false },
      },
    },
    advanced: {
      // The client's IP, kept on its session, comes from the router's header
      // alone, never `x-forwarded-for`. Trusted because nothing reaches
      // Better Auth without the router secret (entry.ts) and the router
      // replaces any copy the client sent. A local stack has no router, so
      // nothing sets it there and its sessions carry no client IP.
      ipAddress: { ipAddressHeaders: [routerClientIpHeader] },
      // Host-only cookies (`__Host-`): no Domain, so no other client's
      // hostname under the product domain can read or plant them.
      useSecureCookies: false,
      cookiePrefix: "__Host-grasp",
      defaultCookieAttributes: {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
    },
    // Failed sign-ins land on the frontend with `?error=<code>`.
    onAPIError: { errorURL: "/" },
    user: {
      // Runs with the verified ID token's claims before a user or account
      // is created or linked, and again on every sign-in.
      validateUserInfo: async ({ user, source }) => {
        const provider = source.sso?.providerId;
        let refusal: SignInRefusal | undefined =
          source.method === "sso-oidc" && provider !== undefined
            ? checkClaims(
                config,
                provider,
                source.sso?.profile ?? {},
                Date.now()
              )
            : "method_not_allowed";
        // While the company is onboarding, only its admins come in through
        // its IdP, before any user or membership is made (onboarding/gate.ts).
        if (
          refusal === undefined &&
          provider !== providerIds.staff &&
          !(await mayComeIn(env, config, user.email))
        ) {
          refusal = "not_open_yet";
        }
        if (refusal !== undefined) {
          log.warn("auth.refused", { provider, refusal });
        }
        return refusal === undefined ? undefined : { error: refusal };
      },
    },
    databaseHooks: {
      // Sign-in needs no IdP tokens after the claims are checked, so none
      // are kept: core never holds provider tokens (R1).
      // Better Auth's hooks must return promises, even with nothing to await.
      account: {
        create: {
          // oxlint-disable-next-line require-await
          before: async (account) => withoutTokens(account),
        },
        update: {
          // oxlint-disable-next-line require-await
          before: async (account) => withoutTokens(account),
        },
      },
      session: {
        create: {
          before: async (session, context) =>
            await startSession(
              env,
              config,
              session,
              context?.params?.providerId
            ),
          after: async (session) => {
            if (session.staff === true) {
              await record(env, {
                actor: actorOf({ userId: session.userId, staff: true }),
                action: "staff.session.started",
                target: { type: "session", id: session.id },
                detail: { expiresAt: session.expiresAt.toISOString() },
              });
              return;
            }
            // The gate again, now the session is stored: one the gate
            // closed on after `startSession` looked is gone either way, by
            // this or by the close, which ends every stored session.
            if (!(await gateLetsIn(env, config, session.userId))) {
              await drizzle(env.DB)
                .delete(sessions)
                .where(eq(sessions.id, session.id));
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (!context.path.startsWith("/organization/")) {
          return;
        }
        // A removed person's membership row may outlive the removal if
        // deleting it failed; the organization plugin would still trust it.
        const caller = await getSessionFromCtx(context);
        if (caller && (await isRemoved(env, caller.user.id))) {
          throw new APIError("FORBIDDEN", { message: "Not a member." });
        }
      }),
      after: createAuthMiddleware(async (context) => {
        const describe = auditedChanges[context.path];
        const { returned } = context.context;
        if (describe === undefined || returned instanceof Error) {
          return;
        }
        const actor = await getSessionFromCtx(context);
        if (!actor) {
          return;
        }
        await record(env, {
          actor: actorOf({
            userId: actor.user.id,
            staff: actor.session.staff === true,
          }),
          ...describe(
            changeSchema.parse(context.body ?? {}),
            returnedSchema.safeParse(returned).data ?? {}
          ),
        });
      }),
    },
    plugins: [
      organization({
        roles,
        creatorRole: "admin",
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        teams: { enabled: true },
      }),
      sso({
        // Providers come only from deployment config, never from the
        // database: registering one in-product is off.
        defaultSSO: providers.map((provider) => ({
          providerId: provider.providerId,
          domain: config.domains[0] ?? "",
          oidcConfig: {
            issuer: provider.issuer,
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            pkce: true,
            // The plugin's type requires it, but with every endpoint below
            // set it never fetches it.
            discoveryEndpoint: `${provider.issuer}/.well-known/openid-configuration`,
            authorizationEndpoint: provider.authorizationEndpoint,
            tokenEndpoint: provider.tokenEndpoint,
            jwksEndpoint: provider.jwksEndpoint,
            tokenEndpointAuthentication: "client_secret_post",
            scopes: ["openid", "email", "profile"],
          },
        })),
        providersLimit: 0,
      }),
      // Signs App tokens (app-tokens.ts) with its own keys, and nothing
      // else: its `/token` and `/jwks` routes are off (routes.ts), and it
      // adds no token to `/get-session`'s answers. Core signs and checks
      // every token itself, so no key is published.
      jwt({
        jwks: {
          keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
          rotationInterval: keyRotationSeconds,
        },
        jwt: {
          issuer: config.origin,
          audience: appTokenAudience(config.origin),
          expirationTime: `${appTokenMs / 1000}s`,
        },
        disableSettingJwtHeader: true,
        // Its own key rows, read through Better Auth's adapter, less the
        // keys that can't verify a current token any more: without this
        // it verifies with every key it ever made. Held a minute per
        // isolate to check tokens, so a token costs no D1 read before it
        // is checked (token-keys.ts); a key it makes is read at once.
        adapter: {
          getJwks: async (context) =>
            await tokenKeys.keys(
              async () =>
                await context.context.adapter.findMany<Jwk>({ model: "jwks" }),
              keyUseOf(context.body),
              Date.now()
            ),
          createJwk: async (key, context) => {
            const made = await context.context.adapter.create<
              Omit<Jwk, "id">,
              Jwk
            >({ model: "jwks", data: { ...key, createdAt: new Date() } });
            tokenKeys.forget();
            return made;
          },
        },
        // Its model is `jwks` already; plural table names would make it
        // `jwkss`.
        schema: { jwks: { modelName: "jwk" } },
      }),
    ],
  });
};

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth instances by env, one per set of providers on offer: the
 * staff provider comes and goes with its window, everything else stays the
 * same for as long as the env does.
 */
const auths = new WeakMap<Env, Map<string, Auth>>();

/**
 * Better Auth for this deployment, or `undefined` while sign-in isn't
 * configured. Fails closed: without the secret or the config nobody is
 * signed in.
 */
export const authFor = (
  env: Env,
  config: SignInConfig | undefined
): Auth | undefined => {
  if (!(config && env.BETTER_AUTH_SECRET)) {
    return undefined;
  }
  const providers = oidcProviders(env, config, Date.now());
  const key = providers.map(({ providerId }) => providerId).join(" ");
  const byProviders = auths.get(env) ?? new Map<string, Auth>();
  auths.set(env, byProviders);
  const auth = byProviders.get(key) ?? createAuth(env, config, providers);
  byProviders.set(key, auth);
  return auth;
};
