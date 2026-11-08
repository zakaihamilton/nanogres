import "server-only";

import { cookies } from "next/headers";
import { noStoreErrorResponse } from "@/lib/api-response";

export const SESSION_COOKIE = "nanogres_session";
export const LEGACY_WORKSPACE_COOKIE = "nanogres_workspace_id";
export const ORGANIZATION_COOKIE = "nanogres_organization_id";
export const LEGACY_WORKSPACE_NAMES_COOKIE = "nanogres_workspace_names";
export const OAUTH_STATE_COOKIE = "nanogres_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "nanogres_oauth_verifier";
export const OAUTH_COOKIE_MAX_AGE = 10 * 60;

export type PerministerConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  appOrigin: string;
};

export type PerministerSessionGrant = {
  authenticated: true;
  sessionToken: string;
  session: { expiresAt: string };
};

export type PerministerLoginResult =
  | { success: true; sessionToken: string; expiresAt: string }
  | { success: false; error: "invalid" | "rate_limited" | "unavailable" };

type PerministerAccount = {
  subjectId: string;
  email: string | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

type PerministerResourceScope =
  | { kind: "product"; organizationId: string; productId: string }
  | { kind: "project"; organizationId: string; productId: string; projectId: string }
  | { kind: "workspace"; organizationId: string; productId: string; workspaceId: string };

type PerministerPermissionGrant = {
  scope: PerministerResourceScope;
  actions: string[];
};

type PerministerOrganization = {
  organizationId: string;
  organizationName: string;
  organizationRole?: string;
  productId: string;
  permissions?: Array<string | PerministerPermissionGrant>;
  resourceRoles?: Array<{
    scope: PerministerResourceScope;
    role: string | null;
    actions: string[];
  }>;
  platformAdmin?: boolean;
};

export type PerministerSessionPayload = {
  authenticated: true;
  account: PerministerAccount;
  session: {
    createdAt?: string;
    expiresAt: string;
  };
  organizations: PerministerOrganization[];
};

export type CurrentSession = PerministerSessionPayload & { token: string };

function readUrlOrigin(value: string | undefined, allowLocalHttp: boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const localHttp =
      allowLocalHttp &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (!localHttp && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function getAppOrigin(): string | null {
  const localDefault = process.env.NODE_ENV === "development" ? "http://localhost:3000" : undefined;
  return readUrlOrigin(
    process.env.NANOGRES_APP_ORIGIN ?? localDefault,
    process.env.NODE_ENV !== "production",
  );
}

function getPerministerBaseUrl(): string | null {
  return readUrlOrigin(
    process.env.PERMINISTER_URL ?? "https://www.perminister.com",
    process.env.NODE_ENV !== "production",
  );
}

export function getPerministerRecoveryUrl(): string | null {
  const baseUrl = getPerministerBaseUrl();
  return baseUrl ? new URL("/forgot-password", baseUrl).toString() : null;
}

export function getPerministerConfig(): PerministerConfig | null {
  const baseUrl = getPerministerBaseUrl();
  const appOrigin = getAppOrigin();
  const clientId = (
    process.env.PERMINISTER_APP_CLIENT_ID ?? process.env.PERMINISTER_CLIENT_ID
  )?.trim();
  const clientSecret =
    process.env.PERMINISTER_APP_CLIENT_SECRET ?? process.env.PERMINISTER_CLIENT_SECRET;

  if (!baseUrl || !appOrigin || !clientId || !clientSecret?.trim()) return null;
  return { baseUrl, clientId, clientSecret, appOrigin };
}

export function isPerministerConfigured(): boolean {
  return getPerministerConfig() !== null;
}

export function isPerministerSessionGrant(value: unknown): value is PerministerSessionGrant {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.session !== "object" || body.session === null) return false;
  const session = body.session as Record<string, unknown>;
  return (
    body.authenticated === true &&
    typeof body.sessionToken === "string" &&
    body.sessionToken.length > 0 &&
    body.sessionToken.length <= 4096 &&
    typeof session.expiresAt === "string" &&
    Number.isFinite(Date.parse(session.expiresAt))
  );
}

function isAccount(value: unknown): value is PerministerAccount {
  if (typeof value !== "object" || value === null) return false;
  const account = value as Record<string, unknown>;
  return (
    typeof account.subjectId === "string" &&
    (typeof account.email === "string" || account.email === null)
  );
}

function isResourceScope(value: unknown): value is PerministerResourceScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  if (typeof scope.organizationId !== "string" || typeof scope.productId !== "string") {
    return false;
  }

  if (scope.kind === "product") return true;
  if (scope.kind === "project") return typeof scope.projectId === "string";
  if (scope.kind === "workspace") return typeof scope.workspaceId === "string";
  return false;
}

function isPermissionGrant(value: unknown): value is PerministerPermissionGrant {
  if (typeof value !== "object" || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    isResourceScope(grant.scope) &&
    Array.isArray(grant.actions) &&
    grant.actions.every((action) => typeof action === "string")
  );
}

function isOrganization(value: unknown): value is PerministerOrganization {
  if (typeof value !== "object" || value === null) return false;
  const organization = value as Record<string, unknown>;
  return (
    typeof organization.organizationId === "string" &&
    typeof organization.organizationName === "string" &&
    typeof organization.productId === "string" &&
    (organization.permissions === undefined ||
      (Array.isArray(organization.permissions) &&
        organization.permissions.every(
          (permission) => typeof permission === "string" || isPermissionGrant(permission),
        ))) &&
    (organization.resourceRoles === undefined ||
      (Array.isArray(organization.resourceRoles) &&
        organization.resourceRoles.every((role) => {
          if (typeof role !== "object" || role === null) return false;
          const resourceRole = role as Record<string, unknown>;
          return (
            isResourceScope(resourceRole.scope) &&
            (resourceRole.role === null || typeof resourceRole.role === "string") &&
            Array.isArray(resourceRole.actions) &&
            resourceRole.actions.every((action) => typeof action === "string")
          );
        })))
  );
}

function isSessionPayload(value: unknown): value is PerministerSessionPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (payload.authenticated !== true || !isAccount(payload.account)) return false;
  if (typeof payload.session !== "object" || payload.session === null) return false;
  const session = payload.session as Record<string, unknown>;
  return (
    typeof session.expiresAt === "string" &&
    Number.isFinite(Date.parse(session.expiresAt)) &&
    Array.isArray(payload.organizations) &&
    payload.organizations.every(isOrganization)
  );
}

function clientHeaders(config: PerministerConfig, token?: string): HeadersInit {
  return {
    "X-Perminister-Client-Id": config.clientId,
    "X-Perminister-Client-Secret": config.clientSecret,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function loginWithPerminister(
  config: PerministerConfig,
  identifier: string,
  password: string,
): Promise<PerministerLoginResult> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/api/auth/consumer/login`, {
      method: "POST",
      headers: {
        ...clientHeaders(config),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identifier, password }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { success: false, error: "unavailable" };
  }

  if (response.status === 429) return { success: false, error: "rate_limited" };
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return { success: false, error: "invalid" };
  }
  if (!response.ok) return { success: false, error: "unavailable" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { success: false, error: "unavailable" };
  }
  if (!isPerministerSessionGrant(body)) return { success: false, error: "unavailable" };

  const expiresAt = Date.parse(body.session.expiresAt);
  if (expiresAt <= Date.now()) return { success: false, error: "unavailable" };
  return {
    success: true,
    sessionToken: body.sessionToken,
    expiresAt: body.session.expiresAt,
  };
}

export async function validatePerministerSession(
  token: string,
  config = getPerministerConfig(),
): Promise<PerministerSessionPayload | null> {
  if (!config) return null;
  try {
    const response = await fetch(`${config.baseUrl}/api/auth/consumer/session`, {
      headers: clientHeaders(config, token),
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return isSessionPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

export async function getCurrentPerministerSession(): Promise<CurrentSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await validatePerministerSession(token);
  return payload ? { ...payload, token } : null;
}

export async function revokePerministerSession(
  token: string,
  config = getPerministerConfig(),
): Promise<void> {
  if (!config) return;
  try {
    await fetch(`${config.baseUrl}/api/auth/consumer/session`, {
      method: "DELETE",
      headers: clientHeaders(config, token),
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    // The local cookie is still cleared even if Perminister is temporarily unavailable.
  }
}

type NanogresRole = "admin" | "viewer" | "manager";

export type NanogresOrganizationChoice = {
  organizationId: string;
  organizationName: string;
  role: NanogresRole;
  /** Old workspace grant IDs remain readable while accounts move to product-scope grants. */
  legacyWorkspaceIds: string[];
};

export type NanogresOrganizationContext = {
  config: PerministerConfig;
  organizationId: string;
  organizationName: string;
  productId: string;
  availableOrganizations: NanogresOrganizationChoice[];
  legacyWorkspaceIds: string[];
  role: NanogresRole;
};

const DATABASE_READ_ACTION = "database:read";
const DATABASE_MANAGE_ACTION = "database:manage";

function getAccessibleOrganizations(session: CurrentSession): NanogresOrganizationChoice[] {
  const targetProductId = (process.env.PERMINISTER_PRODUCT_ID ?? "nanogres").trim().toLowerCase();
  const choices: NanogresOrganizationChoice[] = [];
  for (const org of session.organizations) {
    if (org.productId.toLowerCase() !== targetProductId) continue;
    const organizationId = org.organizationId.toLowerCase();
    const roles = org.resourceRoles ?? [];
    const productRoles = roles.filter(
      (grant) =>
        grant.scope.kind === "product" &&
        grant.scope.organizationId.toLowerCase() === organizationId &&
        grant.scope.productId.toLowerCase() === targetProductId,
    );
    const hasDatabaseRead = productRoles.some((grant) =>
      grant.actions.includes(`${targetProductId}:${DATABASE_READ_ACTION}`),
    );
    const hasDatabaseManage = productRoles.some((grant) =>
      grant.actions.includes(`${targetProductId}:${DATABASE_MANAGE_ACTION}`),
    );
    const legacyWorkspaceIds = [
      ...new Set(
        roles
          .filter(
            (grant) =>
              grant.scope.kind === "workspace" &&
              grant.scope.organizationId.toLowerCase() === organizationId &&
              grant.scope.productId.toLowerCase() === targetProductId &&
              grant.actions.includes(`${targetProductId}:workspace:read`),
          )
          .map((grant) => (grant.scope.kind === "workspace" ? grant.scope.workspaceId.trim() : ""))
          .filter(Boolean),
      ),
    ];
    const hasLegacyRead = legacyWorkspaceIds.length > 0;
    if (!hasDatabaseRead && !hasLegacyRead) continue;

    choices.push({
      organizationId,
      organizationName: org.organizationName,
      role: hasDatabaseManage
        ? "manager"
        : roles.some(
              (grant) =>
                grant.scope.kind === "workspace" &&
                grant.scope.organizationId.toLowerCase() === organizationId &&
                grant.scope.productId.toLowerCase() === targetProductId &&
                grant.actions.includes(`${targetProductId}:members:manage`),
            )
          ? "manager"
          : "viewer",
      legacyWorkspaceIds,
    });
  }

  return choices.sort((left, right) => left.organizationName.localeCompare(right.organizationName));
}

export function nanogresOrganizations(session: CurrentSession): NanogresOrganizationChoice[] {
  return getAccessibleOrganizations(session);
}

export async function getNanogresOrganizationContext(
  session: CurrentSession,
): Promise<NanogresOrganizationContext | Response> {
  const config = getPerministerConfig();
  const productId = (process.env.PERMINISTER_PRODUCT_ID ?? "nanogres").trim().toLowerCase();
  if (!config) {
    return Response.json(
      { error: "Nanogres access is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const accessibleOrganizations = getAccessibleOrganizations(session);
  if (accessibleOrganizations.length === 0) {
    return Response.json(
      { error: "Your Perminister account has no Nanogres database access." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const cookieJar = await cookies();
  const cookieOrgId = cookieJar.get(ORGANIZATION_COOKIE)?.value?.trim().toLowerCase();
  const selectedOrganization =
    accessibleOrganizations.find((organization) => organization.organizationId === cookieOrgId) ??
    accessibleOrganizations[0];
  if (!selectedOrganization) {
    return Response.json(
      { error: "Your Perminister account has no Nanogres database access." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  return {
    config,
    organizationId: selectedOrganization.organizationId,
    organizationName: selectedOrganization.organizationName,
    productId,
    availableOrganizations: accessibleOrganizations,
    legacyWorkspaceIds: selectedOrganization.legacyWorkspaceIds,
    role: selectedOrganization.role,
  };
}

export async function authorizeNanogresAction(action: string): Promise<
  | {
      session: CurrentSession;
      organization: { organizationId: string };
    }
  | Response
> {
  const session = await getCurrentPerministerSession();
  if (!session) {
    return Response.json(
      { error: "Sign in to continue." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const context = await getNanogresOrganizationContext(session);
  if (context instanceof Response) return context;
  const { config, organizationId, productId, legacyWorkspaceIds } = context;

  try {
    const authorize = (
      resourceKind: "product" | "workspace",
      resourceId?: string,
      requestAction = action,
    ) =>
      fetch(`${config.baseUrl}/api/authorize`, {
        method: "POST",
        headers: {
          ...clientHeaders(config, session.token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId,
          productId,
          resourceKind,
          ...(resourceId ? { resourceId } : {}),
          action: requestAction,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(6_000),
      });

    const isAuthorized = async (response: Response) => {
      if (!response.ok) return false;
      const decision: unknown = await response.json();
      return (
        typeof decision === "object" &&
        decision !== null &&
        (decision as Record<string, unknown>).authorized === true
      );
    };

    const productResponse = await authorize("product");
    if (productResponse.status >= 500) {
      return noStoreErrorResponse("Perminister is temporarily unavailable.", 503);
    }
    if (await isAuthorized(productResponse)) {
      return { session, organization: { organizationId } };
    }

    // Existing accounts may still hold workspace grants. Keep them usable during migration;
    // new Nanogres grants are checked at the organization/product scope above.
    const legacyAction = action.endsWith(`:${DATABASE_MANAGE_ACTION}`)
      ? `${productId}:members:manage`
      : `${productId}:workspace:read`;
    for (const legacyWorkspaceId of legacyWorkspaceIds) {
      const response = await authorize("workspace", legacyWorkspaceId, legacyAction);
      if (await isAuthorized(response)) {
        return { session, organization: { organizationId } };
      }
      if (response.status >= 500) {
        return noStoreErrorResponse("Perminister is temporarily unavailable.", 503);
      }
    }

    return noStoreErrorResponse("Perminister denied this action.", 403);
  } catch {
    return noStoreErrorResponse("Perminister is temporarily unavailable.", 503);
  }
}
