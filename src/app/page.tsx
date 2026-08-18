import { SignInButton } from "@/components/auth-buttons";
import { BrandMark } from "@/components/brand-mark";
import { DashboardShell } from "@/components/dashboard-shell";
import { PublicSurfaceAnalytics } from "@/components/public-surface-analytics";
import { resolveAuthenticationAvailability } from "@/lib/auth/deployment";
import { AuthorizationError, type AuthSession } from "@/lib/auth/policy";
import { getServerEnvironment } from "@/lib/env/server";
import type { BranchShareLinkState } from "@/lib/sharing/contracts";

type HomeProps = {
  searchParams: Promise<{
    error?: string | string[];
    node?: string | string[];
  }>;
};

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;
  const selectedNodeId = typeof params.node === "string" ? params.node : undefined;
  const environment = getServerEnvironment(["authentication-origin"]);
  const authenticationAvailability = resolveAuthenticationAvailability({
    canonicalUrl: environment.BETTER_AUTH_URL,
    vercelEnvironment: process.env.VERCEL_ENV,
  });
  let session: AuthSession | null = null;
  let authorizationFailure: AuthorizationError | null = null;

  if (authenticationAvailability.available) {
    const { requireAuthorizedSession } = await import("@/lib/server/authorization");

    try {
      session = await requireAuthorizedSession();
    } catch (caught) {
      if (!(caught instanceof AuthorizationError)) {
        throw caught;
      }

      authorizationFailure = caught;
    }
  }

  if (session) {
    const { getNodeTreeForUser } = await import("@/lib/server/node-service");
    const tree = await getNodeTreeForUser(session.user.id);
    const selectedNodeExists = selectedNodeId
      ? tree.nodes.some((node) => node.id === selectedNodeId)
      : false;
    let initialChatPage;
    let initialSynthesisWorkspace;
    let initialBranchOutlineWorkspace;
    let initialShareLink: BranchShareLinkState | null | undefined;
    let chatGenerationEnabled = false;
    let branchOutlineGenerationEnabled = false;
    if (selectedNodeId && selectedNodeExists) {
      const [
        { getChatMessagesForUser },
        { isChatGenerationEnabled },
        { getSynthesisWorkspaceForUser },
        { getBranchOutlineWorkspaceForUser },
        { isBranchOutlineGenerationEnabled },
        { getBranchShareLinkStateForUser },
      ] = await Promise.all([
        import("@/lib/server/chat-service"),
        import("@/lib/server/chat-runtime"),
        import("@/lib/server/synthesis-service"),
        import("@/lib/server/branch-outline-service"),
        import("@/lib/server/branch-outline-runtime"),
        import("@/lib/server/share-service"),
      ]);
      [
        initialChatPage,
        initialBranchOutlineWorkspace,
        initialShareLink,
      ] = await Promise.all([
        getChatMessagesForUser(session.user.id, { nodeId: selectedNodeId }),
        getBranchOutlineWorkspaceForUser(session.user.id, selectedNodeId),
        getBranchShareLinkStateForUser(session.user.id, selectedNodeId),
      ]);
      initialSynthesisWorkspace = await getSynthesisWorkspaceForUser(
        session.user.id,
        selectedNodeId,
        {
          generatingMessageIds: initialChatPage.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.id),
        },
      );
      chatGenerationEnabled = isChatGenerationEnabled();
      branchOutlineGenerationEnabled = isBranchOutlineGenerationEnabled();
    }

    return (
      <DashboardShell
        email={session.user.email}
        nodes={tree.nodes}
        selectedNodeId={selectedNodeId}
        initialChatPage={initialChatPage}
        initialSynthesisWorkspace={initialSynthesisWorkspace}
        initialBranchOutlineWorkspace={initialBranchOutlineWorkspace}
        initialShareLink={initialShareLink}
        shareLinkEncryptionEnabled={Boolean(environment.SHARE_LINK_ENCRYPTION_KEY)}
        chatGenerationEnabled={chatGenerationEnabled}
        branchOutlineGenerationEnabled={branchOutlineGenerationEnabled}
      />
    );
  }

  const accessDenied =
    Boolean(authorizationFailure && authorizationFailure.reason !== "missing-session") ||
    error === "ACCOUNT_NOT_ALLOWED" ||
    error === "account_not_allowed";
  const signInFailed = Boolean(error) && !accessDenied;

  return (
    <>
      <main className="landing" aria-labelledby="page-title" data-testid="sign-in-page">
        <div className="landing__content">
          <div className="wordmark" aria-label="MindTree">
            <BrandMark />
            <span>MindTree</span>
          </div>

          <p className="eyebrow">Hierarchical thinking</p>
          <h1 id="page-title">See how your thoughts grow.</h1>
          <p>
            {accessDenied
              ? "That Google account can’t access this MindTree."
              : signInFailed
                ? "Google sign-in wasn’t completed. Please try again."
                : authenticationAvailability.available
                  ? "Organize your ideas your way, then develop and synthesize them at any level."
                  : "Google sign-in is available only on the canonical MindTree deployment."}
          </p>
          <SignInButton
            canonicalOrigin={
              authenticationAvailability.available
                ? undefined
                : authenticationAvailability.canonicalOrigin
            }
            clearExistingSession={accessDenied}
          />
        </div>
      </main>
      <PublicSurfaceAnalytics />
    </>
  );
}
