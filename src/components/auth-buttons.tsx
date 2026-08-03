"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth/client";

type SignInButtonProps = {
  canonicalOrigin?: string;
  clearExistingSession?: boolean;
};

export function SignInButton({
  canonicalOrigin,
  clearExistingSession = false,
}: SignInButtonProps) {
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  if (canonicalOrigin) {
    return (
      <div className="auth-action">
        <a className="button button--primary" href={canonicalOrigin}>
          Open canonical MindTree
        </a>
      </div>
    );
  }

  async function signIn() {
    setError(false);
    setPending(true);

    try {
      if (clearExistingSession) {
        const signOutResult = await authClient.signOut();

        if (signOutResult.error) {
          setError(true);
          return;
        }
      }

      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/",
      });

      if (result.error) {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-action">
      <button className="button button--primary" type="button" onClick={signIn} disabled={pending}>
        {pending
          ? "Opening Google…"
          : clearExistingSession
            ? "Use another Google account"
            : "Continue with Google"}
      </button>
      {error ? <p role="alert">Google sign-in could not be started. Please try again.</p> : null}
    </div>
  );
}

export function SignOutButton() {
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function signOut() {
    setError(false);
    setPending(true);

    try {
      const result = await authClient.signOut();

      if (result.error) {
        setError(true);
        return;
      }

      window.location.assign("/");
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-action auth-action--compact">
      <button className="button button--quiet" type="button" onClick={signOut} disabled={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error ? <p role="alert">Sign out failed. Please try again.</p> : null}
    </div>
  );
}
