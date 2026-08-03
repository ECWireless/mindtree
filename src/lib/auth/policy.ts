export type AuthSession = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
  };
};

export type AuthorizationFailure = "missing-session" | "unverified-email" | "disallowed-email";

export class AuthorizationError extends Error {
  constructor(public readonly reason: AuthorizationFailure) {
    super(reason);
    this.name = "AuthorizationError";
  }
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isAllowedIdentity(
  identity: { email: string; emailVerified: boolean },
  allowedEmail: string,
) {
  return identity.emailVerified && normalizeEmail(identity.email) === normalizeEmail(allowedEmail);
}

export function assertAuthorizedSession<T extends AuthSession>(
  session: T | null,
  allowedEmail: string,
): T {
  if (!session) {
    throw new AuthorizationError("missing-session");
  }

  if (!session.user.emailVerified) {
    throw new AuthorizationError("unverified-email");
  }

  if (normalizeEmail(session.user.email) !== normalizeEmail(allowedEmail)) {
    throw new AuthorizationError("disallowed-email");
  }

  return session;
}
