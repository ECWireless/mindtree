import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  PublicThoughtTrailUnavailable,
  PublicThoughtTrailView,
} from "@/components/public-thought-trail";
import { PublicSurfaceAnalytics } from "@/components/public-surface-analytics";
import {
  BranchShareServiceError,
  getPublicThoughtTrail,
} from "@/lib/server/share-service";

type PublicTrailPageProps = {
  params: Promise<{ secret: string }>;
  searchParams: Promise<{
    node?: string | string[];
    view?: string | string[];
  }>;
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Shared thought trail · MindTree",
  description: "A read-only thought trail shared from MindTree.",
  referrer: "no-referrer",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    noarchive: true,
    noimageindex: true,
  },
};

async function loadPublicTrail(secret: string, requestedNodeId?: string) {
  try {
    return await getPublicThoughtTrail(secret, requestedNodeId);
  } catch (error) {
    if (error instanceof BranchShareServiceError) {
      if (error.reason === "invalid-link" || error.reason === "not-found") {
        notFound();
      }
      if (error.reason === "oversized") return null;
    }
    throw error;
  }
}

export default async function PublicTrailPage({
  params,
  searchParams,
}: PublicTrailPageProps) {
  const [{ secret }, query] = await Promise.all([params, searchParams]);
  if (Array.isArray(query.node) || Array.isArray(query.view)) notFound();
  const requestedNodeId = typeof query.node === "string" ? query.node : undefined;
  const view = query.view === "constellation" ? "constellation" : "trail";
  const trail = await loadPublicTrail(secret, requestedNodeId);
  if (!trail) return <PublicThoughtTrailUnavailable oversized />;

  return (
    <>
      <PublicThoughtTrailView trail={trail} view={view} />
      <PublicSurfaceAnalytics />
    </>
  );
}
