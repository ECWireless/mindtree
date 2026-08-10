import {
  generateBranchOutlineInputSchema,
  loadBranchOutlineWorkspaceInputSchema,
  type BranchOutlineStreamEvent,
  type BranchOutlineVersion,
} from "@/lib/branch-outlines/contracts";
import { getServerEnvironment } from "@/lib/env/server";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import {
  BranchOutlineContextError,
  prepareBranchOutlineContextForUser,
} from "@/lib/server/branch-outline-context";
import {
  BranchOutlineOutputError,
  compileBranchOutlineModelOutput,
} from "@/lib/server/branch-outline-output";
import { getBranchOutlineGenerationMode, streamBranchOutlineResponse } from "@/lib/server/branch-outline-runtime";
import {
  BranchOutlineServiceError,
  claimBranchOutlineGenerationForUser,
  completeBranchOutlineGenerationForUser,
  failBranchOutlineGenerationForUser,
  getBranchOutlineGenerationForRequestForUser,
  getBranchOutlineWorkspaceForUser,
  isBranchOutlineGenerationExpired,
  recordBranchOutlineProviderResponseForUser,
  recoverAbandonedBranchOutlineGenerationForUser,
} from "@/lib/server/branch-outline-service";
import { createOpenAISafetyIdentifier } from "@/lib/server/chat-runtime";
import {
  OpenAIBranchOutlineAbortError,
  OpenAIBranchOutlineError,
} from "@/lib/server/openai-branch-outline";

export const runtime = "nodejs";
const MAX_BRANCH_OUTLINE_REQUEST_BYTES = 16_000;

class BranchOutlineRequestTooLargeError extends Error {}

function jsonError(status: number, message: string) {
  return Response.json({ message }, { status });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BRANCH_OUTLINE_REQUEST_BYTES
  ) {
    throw new BranchOutlineRequestTooLargeError();
  }
  if (!request.body) throw new Error("missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_BRANCH_OUTLINE_REQUEST_BYTES) {
      await reader.cancel();
      throw new BranchOutlineRequestTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function eventResponse(events: BranchOutlineStreamEvent[]) {
  return new Response(
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function terminalResponse(result: {
  generation: BranchOutlineVersion;
  installed: boolean;
}) {
  return eventResponse([
    { type: "generation", generation: result.generation },
    result.generation.status === "completed"
      ? {
          type: "completed",
          generation: result.generation,
          installed: result.installed,
        }
      : { type: "failed", generation: result.generation },
  ]);
}

export async function POST(request: Request) {
  let session;
  try {
    session = await requireAuthorizedSession(request.headers);
  } catch {
    return jsonError(401, "Authentication is required.");
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof BranchOutlineRequestTooLargeError) {
      return jsonError(413, "The Branch Outline request is too large.");
    }
    return jsonError(400, "The Branch Outline request could not be read.");
  }
  const parsed = generateBranchOutlineInputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "The Branch Outline request is invalid.");
  }
  const userId = session.user.id;

  try {
    const existing = await getBranchOutlineGenerationForRequestForUser(
      userId,
      parsed.data,
    );
    if (existing) {
      if (existing.generation.status === "pending") {
        return jsonError(409, "That Branch Outline is already being generated.");
      }
      return terminalResponse(existing);
    }
  } catch {
    return jsonError(409, "The Branch Outline could not be started.");
  }
  if (getBranchOutlineGenerationMode() === "unavailable") {
    return jsonError(503, "Branch Outline generation is not available yet.");
  }

  let prepared;
  try {
    prepared = await prepareBranchOutlineContextForUser(userId, parsed.data.nodeId);
  } catch (error) {
    if (
      error instanceof BranchOutlineContextError &&
      error.reason === "context-too-large"
    ) {
      return jsonError(409, "This branch is too large to outline in one request.");
    }
    return jsonError(409, "The Branch Outline context is no longer available.");
  }

  let claim;
  try {
    claim = await claimBranchOutlineGenerationForUser(userId, {
      ...prepared.claim,
      clientRequestId: parsed.data.clientRequestId,
    });
  } catch (error) {
    if (
      error instanceof BranchOutlineServiceError &&
      error.reason === "generation-in-progress"
    ) {
      return jsonError(409, "A Branch Outline is already being generated.");
    }
    return jsonError(409, "The branch changed before generation could start.");
  }
  if (claim.replayed) {
    if (claim.generation.status === "pending") {
      return jsonError(409, "That Branch Outline is already being generated.");
    }
    return terminalResponse({
      generation: claim.generation,
      installed: claim.installed,
    });
  }

  const authEnvironment = getServerEnvironment(["authentication"]);
  const safetyIdentifier = createOpenAISafetyIdentifier(
    userId,
    authEnvironment.BETTER_AUTH_SECRET,
  );
  const encoder = new TextEncoder();
  const encodeEvent = (event: BranchOutlineStreamEvent) =>
    encoder.encode(`${JSON.stringify(event)}\n`);
  const downstreamAbortController = new AbortController();
  const generationSignal = AbortSignal.any([
    request.signal,
    downstreamAbortController.signal,
  ]);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encodeEvent({ type: "generation", generation: claim.generation }));
      let completed = false;
      try {
        for await (const providerEvent of streamBranchOutlineResponse({
          messages: prepared.input,
          safetyIdentifier,
          signal: generationSignal,
        })) {
          if (generationSignal.aborted) throw new OpenAIBranchOutlineAbortError();
          if (providerEvent.type === "started") {
            await recordBranchOutlineProviderResponseForUser(userId, {
              nodeId: parsed.data.nodeId,
              generationId: claim.generation.id,
              providerResponseId: providerEvent.providerResponseId,
            });
          } else if (providerEvent.type === "completed") {
            let draft;
            try {
              draft = compileBranchOutlineModelOutput(
                providerEvent.content,
                prepared.snapshot.children.map(({ title }) => title),
              );
            } catch (error) {
              if (error instanceof BranchOutlineOutputError) {
                throw new OpenAIBranchOutlineError("response-invalid");
              }
              throw error;
            }
            if (generationSignal.aborted) {
              throw new OpenAIBranchOutlineAbortError();
            }
            const result = await completeBranchOutlineGenerationForUser(userId, {
              nodeId: parsed.data.nodeId,
              generationId: claim.generation.id,
              draft,
            });
            completed = true;
            controller.enqueue(encodeEvent({
              type: "delta",
              content: draft.content,
            }));
            controller.enqueue(encodeEvent(
              result.generation.status === "completed"
                ? {
                    type: "completed",
                    generation: result.generation,
                    installed: result.installed,
                  }
                : { type: "failed", generation: result.generation },
            ));
          }
        }
        if (!completed) throw new OpenAIBranchOutlineError("response-invalid");
      } catch (error) {
        const failureCode = error instanceof OpenAIBranchOutlineError
          ? error.failureCode
          : error instanceof OpenAIBranchOutlineAbortError
            ? "stream-disconnected"
            : "generation-failed";
        try {
          const failed = await failBranchOutlineGenerationForUser(userId, {
            nodeId: parsed.data.nodeId,
            generationId: claim.generation.id,
            failureCode,
          });
          if (!generationSignal.aborted) {
            controller.enqueue(encodeEvent({
              type: "failed",
              generation: failed.generation,
            }));
          }
        } catch {
          // The generation may already have reached a terminal state.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // The downstream reader may already be gone.
        }
      }
    },
    cancel() {
      downstreamAbortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  let session;
  try {
    session = await requireAuthorizedSession(request.headers);
  } catch {
    return jsonError(401, "Authentication is required.");
  }
  const parsed = loadBranchOutlineWorkspaceInputSchema.safeParse({
    nodeId: new URL(request.url).searchParams.get("nodeId"),
  });
  if (!parsed.success) {
    return jsonError(400, "The Branch Outline request is invalid.");
  }
  try {
    let workspace = await getBranchOutlineWorkspaceForUser(
      session.user.id,
      parsed.data.nodeId,
    );
    if (
      workspace.pending &&
      isBranchOutlineGenerationExpired(workspace.pending)
    ) {
      await recoverAbandonedBranchOutlineGenerationForUser(
        session.user.id,
        parsed.data.nodeId,
      );
      workspace = await getBranchOutlineWorkspaceForUser(
        session.user.id,
        parsed.data.nodeId,
      );
    }
    return Response.json(workspace, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return jsonError(404, "The Branch Outline is not available.");
  }
}
