import { chmod, readFile, writeFile } from "node:fs/promises";

import { expect, test } from "vitest";

import {
  evaluateQualityScorecard,
  LIVE_EVALUATION_MAX_CALLS,
  LIVE_EVALUATION_REPORT_PATH,
  MODEL_EVALUATION_CASES,
  type QualityScores,
} from "./model-evaluation";

test("validates and records the completed manual quality scorecard", async () => {
  let serialized: string;
  try {
    serialized = await readFile(LIVE_EVALUATION_REPORT_PATH, "utf8");
  } catch {
    throw new Error("Run the separately approved live evaluation before validating its scorecard.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw new Error("Live evaluation report is invalid.");
  }
  if (typeof decoded !== "object" || decoded === null) throw new Error("Live evaluation report is invalid.");
  const report = decoded as Record<string, unknown>;
  if (report.syntheticOnly !== true || report.structuralPassed !== true) {
    throw new Error("A passing synthetic structural report is required before quality scoring.");
  }
  const bounds = report.bounds;
  if (
    typeof bounds !== "object" || bounds === null ||
    (bounds as Record<string, unknown>).maximumCalls !== LIVE_EVALUATION_MAX_CALLS
  ) {
    throw new Error("Live evaluation report bounds do not match the reviewed catalog.");
  }
  const cases = report.cases;
  if (
    !Array.isArray(cases) ||
    cases.map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>).caseId
        : null
    ).join("|") !== MODEL_EVALUATION_CASES.map(({ id }) => id).join("|")
  ) {
    throw new Error("Live evaluation report cases do not match the reviewed catalog.");
  }
  if (typeof report.manualScorecard !== "object" || report.manualScorecard === null) {
    throw new Error("Complete the report's manualScorecard before validation.");
  }

  const quality = evaluateQualityScorecard(
    report.manualScorecard as Record<string, QualityScores>,
  );
  expect(quality.passed, `Manual quality gate failed: ${quality.reason}.`).toBe(true);

  report.qualityRubric = {
    ...(typeof report.qualityRubric === "object" && report.qualityRubric !== null
      ? report.qualityRubric
      : {}),
    status: "passed",
  };
  report.qualityResult = quality;
  await writeFile(LIVE_EVALUATION_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await chmod(LIVE_EVALUATION_REPORT_PATH, 0o600);
});
