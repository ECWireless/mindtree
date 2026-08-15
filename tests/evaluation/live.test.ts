import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { expect, test } from "vitest";

import {
  OPENAI_CHAT_MODEL,
  OPENAI_SYNTHESIS_MODEL,
} from "@/lib/ai/openai-profiles";
import { compileBranchOutlineModelOutput } from "@/lib/server/branch-outline-output";
import {
  createOpenAIBranchOutlineRequest,
  normalizeOpenAIBranchOutlineEvents,
} from "@/lib/server/openai-branch-outline";
import {
  createOpenAIChatRequest,
  normalizeOpenAIChatEvents,
} from "@/lib/server/openai-chat";
import {
  assertLiveEvaluationEnvironment,
  evaluateStructuralCase,
  LIVE_EVALUATION_MAX_CALLS,
  LIVE_EVALUATION_MAX_OUTPUT_TOKENS,
  LIVE_EVALUATION_MAX_WEB_CALLS,
  LIVE_EVALUATION_REPORT_PATH,
  MODEL_EVALUATION_CASES,
  QUALITY_DIMENSIONS,
  QUALITY_RUBRIC,
  sanitizeEvaluationReviewText,
  type EvaluationObservation,
  type ModelStep,
} from "./model-evaluation";

const SAFETY_IDENTIFIER = "mt_synthetic_live_evaluation";
const REQUEST_TIMEOUT_MS = 180_000;

async function* observeWebSearchCalls(
  events: AsyncIterable<ResponseStreamEvent>,
  onCompleted: (itemId: string) => void,
) {
  for await (const event of events) {
    if (event.type === "response.web_search_call.completed") onCompleted(event.item_id);
    yield event;
  }
}

function precedingClaim(content: string, endUtf16: number) {
  const bounded = content.slice(Math.max(0, endUtf16 - 320), endUtf16).trim();
  const sentenceStart = Math.max(
    bounded.lastIndexOf(". "),
    bounded.lastIndexOf("! "),
    bounded.lastIndexOf("? "),
    bounded.lastIndexOf("\n"),
  );
  return bounded.slice(sentenceStart < 0 ? 0 : sentenceStart + 2).trim();
}

test("runs the separately approved bounded synthetic model evaluation", async () => {
  assertLiveEvaluationEnvironment(process.env);
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  let callCount = 0;
  let webAuthorizedResponseCount = 0;
  let completedWebSearchCallCount = 0;
  const completedWebSearchCallIds = new Set<string>();
  const caseReports: Array<{
    caseId: string;
    structural: ReturnType<typeof evaluateStructuralCase>;
    reviewOutput: Array<{
      stepId: string;
      visibleText: string;
      proposalContent: string | null;
      internalCitations: Array<{ evidenceAlias: string; citedText: string }>;
      externalCitations: Array<{ sourceAlias: string; citedText: string }>;
      researchCitations: Array<{
        ordinal: number;
        title: string;
        insertionUtf16: number;
        precedingClaim: string;
      }>;
      branchOutlineContent: string | null;
    }>;
    deterministicEvidence: string[];
  }> = [];

  const countRequest = (step: ModelStep) => {
    callCount += 1;
    if (step.webSearchAuthorized) webAuthorizedResponseCount += 1;
    if (callCount > LIVE_EVALUATION_MAX_CALLS) throw new Error("Live evaluation call cap exceeded.");
    if (webAuthorizedResponseCount > LIVE_EVALUATION_MAX_WEB_CALLS) {
      throw new Error("Live evaluation web-authorized response cap exceeded.");
    }
  };

  for (const evaluationCase of MODEL_EVALUATION_CASES) {
    const observations: EvaluationObservation[] = [];
    for (const step of evaluationCase.steps) {
      countRequest(step);
      try {
        if (step.kind === "branch-outline") {
          if (!step.messages.every((message) => message.role === "user")) {
            throw new Error("Invalid Branch Outline messages.");
          }
          const request = createOpenAIBranchOutlineRequest({
            messages: step.messages as Array<{ role: "user"; content: string }>,
            safetyIdentifier: SAFETY_IDENTIFIER,
          });
          const stream = await client.responses.create({
            ...request,
            max_output_tokens: LIVE_EVALUATION_MAX_OUTPUT_TOKENS,
          }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
          const events = await Array.fromAsync(normalizeOpenAIBranchOutlineEvents(stream));
          const completed = events.findLast((event) => event.type === "completed");
          if (!completed) throw new Error("Branch Outline did not complete.");
          const compiled = compileBranchOutlineModelOutput(
            completed.content,
            step.expectedChildTitles ?? [],
          );
          observations.push({
            stepId: step.id,
            kind: step.kind,
            visibleText: "",
            synthesisRequested: false,
            proposal: null,
            branchOutlineContent: compiled.content,
            webSearchUsed: false,
            providerToolNames: [],
            researchCitations: [],
          });
          continue;
        }

        const request = createOpenAIChatRequest({
          messages: step.messages,
          phase: step.kind,
          safetyIdentifier: SAFETY_IDENTIFIER,
          webSearchAuthorized: step.webSearchAuthorized,
        });
        const stream = await client.responses.create({
          ...request,
          max_output_tokens: LIVE_EVALUATION_MAX_OUTPUT_TOKENS,
          ...(step.webSearchAuthorized ? { max_tool_calls: 1 } : {}),
        }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const events = await Array.fromAsync(normalizeOpenAIChatEvents(observeWebSearchCalls(
          stream,
          (itemId) => {
            const scopedItemId = `${evaluationCase.id}/${step.id}/${itemId}`;
            if (completedWebSearchCallIds.has(scopedItemId)) return;
            completedWebSearchCallIds.add(scopedItemId);
            completedWebSearchCallCount += 1;
            if (completedWebSearchCallCount > LIVE_EVALUATION_MAX_WEB_CALLS) {
              throw new Error("Live evaluation completed web-search call cap exceeded.");
            }
          },
        ), {
          phase: step.kind,
          webSearchAuthorized: step.webSearchAuthorized,
        }));
        const completed = events.findLast((event) => event.type === "completed");
        if (!completed) throw new Error("Chat did not complete.");
        observations.push({
          stepId: step.id,
          kind: step.kind,
          visibleText: events
            .filter((event) => event.type === "text-delta")
            .map(({ content }) => content)
            .join(""),
          synthesisRequested: completed.synthesisRequested,
          proposal: completed.proposal,
          branchOutlineContent: null,
          webSearchUsed: events.some((event) => event.type === "research-status"),
          providerToolNames: (request.tools ?? []).flatMap((tool) =>
            tool.type === "function" ? [tool.name] : []
          ),
          researchCitations: (completed.externalCitations ?? []).map((citation) => ({
            ordinal: citation.ordinal,
            startUtf16: citation.startUtf16,
            endUtf16: citation.endUtf16,
            title: citation.title,
          })),
        });
      } catch {
        throw new Error(`Live evaluation failed in bounded step ${evaluationCase.id}/${step.id}.`);
      }
    }

    const structural = evaluateStructuralCase(evaluationCase, observations);
    caseReports.push({
      caseId: evaluationCase.id,
      structural,
      reviewOutput: observations.map((observation) => ({
        stepId: observation.stepId,
        visibleText: sanitizeEvaluationReviewText(observation.visibleText) ?? "",
        proposalContent: sanitizeEvaluationReviewText(observation.proposal?.content ?? null),
        internalCitations: observation.proposal?.citations ?? [],
        externalCitations: observation.proposal?.externalCitations ?? [],
        researchCitations: observation.researchCitations.map((citation) => ({
          ordinal: citation.ordinal,
          title: sanitizeEvaluationReviewText(citation.title) ?? "",
          insertionUtf16: citation.endUtf16,
          precedingClaim: sanitizeEvaluationReviewText(
            precedingClaim(observation.visibleText, citation.endUtf16),
          ) ?? "",
        })),
        branchOutlineContent: sanitizeEvaluationReviewText(observation.branchOutlineContent),
      })),
      deterministicEvidence: evaluationCase.deterministicEvidence,
    });
  }

  const report = {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    syntheticOnly: true,
    models: [...new Set([OPENAI_CHAT_MODEL, OPENAI_SYNTHESIS_MODEL])],
    bounds: {
      callsUsed: callCount,
      maximumCalls: LIVE_EVALUATION_MAX_CALLS,
      webAuthorizedResponsesUsed: webAuthorizedResponseCount,
      completedWebSearchCalls: completedWebSearchCallCount,
      maximumWebAuthorizedResponsesAndSearchCalls: LIVE_EVALUATION_MAX_WEB_CALLS,
      maximumOutputTokensPerCall: LIVE_EVALUATION_MAX_OUTPUT_TOKENS,
      providerStorage: false,
    },
    structuralThreshold: "100% of checks in every case",
    structuralPassed: caseReports.every(({ structural }) => structural.passed),
    qualityRubric: {
      status: "manual-review-required",
      dimensions: QUALITY_RUBRIC,
      scale: { 0: "fails", 1: "acceptable", 2: "strong" },
      threshold: "No zero scores and an overall average of at least 1.5.",
    },
    manualScorecard: Object.fromEntries(MODEL_EVALUATION_CASES.map(({ id }) => [
      id,
      Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [dimension, null])),
    ])),
    cases: caseReports,
  };
  await mkdir(dirname(LIVE_EVALUATION_REPORT_PATH), { recursive: true });
  await writeFile(LIVE_EVALUATION_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(LIVE_EVALUATION_REPORT_PATH, 0o600);
  console.info(`Synthetic live-model review report: ${LIVE_EVALUATION_REPORT_PATH}`);

  expect(callCount).toBe(LIVE_EVALUATION_MAX_CALLS);
  expect(webAuthorizedResponseCount).toBeLessThanOrEqual(LIVE_EVALUATION_MAX_WEB_CALLS);
  expect(completedWebSearchCallCount).toBeLessThanOrEqual(LIVE_EVALUATION_MAX_WEB_CALLS);
  expect(report.structuralPassed).toBe(true);
});
