import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { installBrowserSessionCookie, seedBrowserSession } from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
const pool = new Pool({ connectionString });

function fingerprintRelatedInput(input: {
  nodeId: string;
  synthesisVersionId: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...input }), "utf8")
    .digest("hex");
}

test.afterAll(async () => pool.end());

test("navigates internal links and presents changed or unavailable evidence", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const firstParentId = randomUUID();
  const secondParentId = randomUUID();
  const sourceNodeId = randomUUID();
  const targetNodeId = randomUUID();
  const sourceMessageId = randomUUID();
  const targetMessageId = randomUUID();
  const sourceVersionId = randomUUID();
  const targetVersionId = randomUUID();
  const content = "# Cited result\n\nApproved evidence supports this conclusion.";
  const citedText = "Approved evidence supports this conclusion";
  const startUtf16 = content.indexOf(citedText);

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values
         ($1, $5, null, 0, 'Evidence branch'),
         ($2, $5, null, 1, 'Moved branch'),
         ($3, $5, $1, 0, 'Source thought'),
         ($4, $5, null, 2, 'Target thought')`,
      [firstParentId, secondParentId, sourceNodeId, targetNodeId, seeded.userId],
    );
    await pool.query(
      `insert into chat_messages
         (id, user_id, node_id, client_message_id, sequence, role, status, content,
          model, context_fingerprint, completed_at)
       values
         ($1, $3, $4, $5, 0, 'assistant', 'completed', 'Synthetic source response',
          'gpt-5.6-sol', $7, now()),
         ($2, $3, $6, $8, 0, 'assistant', 'completed', 'Synthetic target response',
          'gpt-5.6-sol', $7, now())`,
      [
        sourceMessageId,
        targetMessageId,
        seeded.userId,
        sourceNodeId,
        randomUUID(),
        targetNodeId,
        "a".repeat(64),
        randomUUID(),
      ],
    );
    await pool.query(
      `insert into synthesis_versions
         (id, user_id, node_id, status, content, model, reasoning_mode,
          reasoning_effort, input_fingerprint, generating_message_id, decided_at)
       values
         ($1, $3, $4, 'approved', 'Exact approved source evidence.',
          'gpt-5.6-sol', 'pro', 'high', $7, $5, now()),
         ($2, $3, $6, 'pending', $8,
          'gpt-5.6-sol', 'pro', 'high', $9, $10, null)`,
      [
        sourceVersionId,
        targetVersionId,
        seeded.userId,
        sourceNodeId,
        sourceMessageId,
        targetNodeId,
        "b".repeat(64),
        content,
        "c".repeat(64),
        targetMessageId,
      ],
    );
    await pool.query(
      `update nodes set published_synthesis_version_id = $1
       where user_id = $2 and id = $3`,
      [sourceVersionId, seeded.userId, sourceNodeId],
    );
    await pool.query(
      `insert into synthesis_inputs
         (synthesis_version_id, user_id, node_id, relation, source_node_id,
          source_synthesis_version_id, source_state_fingerprint, position)
       values ($1, $2, $3, 'related', $4, $5, $6, 0)`,
      [
        targetVersionId,
        seeded.userId,
        targetNodeId,
        sourceNodeId,
        sourceVersionId,
        fingerprintRelatedInput({
          nodeId: sourceNodeId,
          synthesisVersionId: sourceVersionId,
        }),
      ],
    );
    await pool.query(
      `insert into citations
         (user_id, owner_node_id, synthesis_version_id, kind, ordinal,
          start_utf16, end_utf16, live_target_node_id,
          live_target_synthesis_version_id, target_node_id_snapshot,
          target_title_snapshot, target_parent_id_snapshot,
          target_synthesis_version_id_snapshot)
       values ($1, $2, $3, 'internal', 1, $4, $5, $6, $7, $6,
         'Source thought', $8, $7)`,
      [
        seeded.userId,
        targetNodeId,
        targetVersionId,
        startUtf16,
        startUtf16 + citedText.length,
        sourceNodeId,
        sourceVersionId,
        firstParentId,
      ],
    );
    await pool.query(
      `update synthesis_versions
       set status = 'approved', decided_at = now(), updated_at = now()
       where user_id = $1 and node_id = $2 and id = $3`,
      [seeded.userId, targetNodeId, targetVersionId],
    );
    await pool.query(
      `update nodes set published_synthesis_version_id = $1
       where user_id = $2 and id = $3`,
      [targetVersionId, seeded.userId, targetNodeId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${targetNodeId}`);

    const summary = page.getByRole("region", { name: "Summary" });
    const internalLink = summary.getByRole("link", {
      name: citedText,
    });
    await expect(internalLink).toBeVisible();
    await expect(internalLink).toHaveText(citedText);
    await expect(internalLink).toHaveAccessibleName(citedText);
    await expect(internalLink).toHaveClass("internal-node-link");
    await internalLink.hover();
    const tooltip = page.locator(".internal-node-tooltip:popover-open");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(
      `Linked thought: Source thought. Exact linked revision. Linked revision ${sourceVersionId.slice(0, 8)}`,
    );
    const tooltipBounds = await tooltip.boundingBox();
    expect(tooltipBounds).not.toBeNull();
    expect(tooltipBounds!.x).toBeGreaterThanOrEqual(15);
    expect(tooltipBounds!.x + tooltipBounds!.width)
      .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) - 15);
    expect(tooltipBounds!.y).toBeGreaterThanOrEqual(15);
    expect(tooltipBounds!.y + tooltipBounds!.height)
      .toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) - 15);
    await expect(summary.locator(".sr-only").filter({
      hasText: `Linked thought: Source thought. Exact linked revision. Linked revision ${sourceVersionId.slice(0, 8)}`,
    })).toHaveCount(1);
    await expect(summary.getByText("Cited thoughts", { exact: false })).toHaveCount(0);
    await expect(summary.getByText("[1]", { exact: true })).toHaveCount(0);

    await internalLink.click();
    await expect(page).toHaveURL(new RegExp(`\\?node=${sourceNodeId}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Source thought" })).toBeVisible();

    const replacementMessageId = randomUUID();
    const replacementVersionId = randomUUID();
    await pool.query(
      `insert into chat_messages
         (id, user_id, node_id, client_message_id, sequence, role, status, content,
          model, context_fingerprint, completed_at)
       values ($1, $2, $3, $4, 1, 'assistant', 'completed',
         'Synthetic replacement response', 'gpt-5.6-sol', $5, now())`,
      [
        replacementMessageId,
        seeded.userId,
        sourceNodeId,
        randomUUID(),
        "d".repeat(64),
      ],
    );
    await pool.query(
      `insert into synthesis_versions
         (id, user_id, node_id, base_version_id, status, content, model,
          reasoning_mode, reasoning_effort, input_fingerprint,
          generating_message_id, decided_at)
       values ($1, $2, $3, $4, 'approved', 'Replacement approved source evidence.',
         'gpt-5.6-sol', 'pro', 'high', $5, $6, now())`,
      [
        replacementVersionId,
        seeded.userId,
        sourceNodeId,
        sourceVersionId,
        "e".repeat(64),
        replacementMessageId,
      ],
    );
    await pool.query(
      `update nodes
       set title = 'Renamed source',
           parent_id = $1,
           position = 0,
           archived_at = now(),
           published_synthesis_version_id = $2,
           updated_at = now()
       where user_id = $3 and id = $4`,
      [secondParentId, replacementVersionId, seeded.userId, sourceNodeId],
    );
    await pool.query(
      `update nodes set synthesis_stale_at = now()
       where user_id = $1 and id = $2`,
      [seeded.userId, targetNodeId],
    );
    await page.goto(`/?node=${targetNodeId}`);
    const changedLink = summary.getByRole("link", {
      name: citedText,
    });
    await expect(changedLink).toBeVisible();
    await expect(changedLink).toHaveText(citedText);
    await expect(changedLink).toHaveClass(
      "internal-node-link internal-node-link--changed",
    );
    await expect(page.getByText("Update available", { exact: true })).toBeVisible();

    await pool.query(
      `delete from nodes where user_id = $1 and id = $2`,
      [seeded.userId, sourceNodeId],
    );
    await page.reload();

    const unavailableLink = summary.locator(".internal-node-link--unavailable");
    await expect(unavailableLink).toBeVisible();
    await expect(unavailableLink).toHaveText(`${citedText} (unavailable). Unavailable linked thought, formerly Source thought`);
    await expect(unavailableLink).toHaveAccessibleName(`${citedText} (unavailable)`);
    await unavailableLink.focus();
    const unavailableTooltip = page.locator(".internal-node-tooltip:popover-open");
    await expect(unavailableTooltip).toBeVisible();
    await expect(unavailableTooltip).toHaveText(
      "Unavailable linked thought, formerly Source thought",
    );
    await page.keyboard.press("Escape");
    await expect(unavailableLink).toBeFocused();
    await expect(page.locator(".internal-node-tooltip:popover-open")).toHaveCount(0);
    await expect(unavailableLink).toHaveClass(
      "internal-node-link internal-node-link--unavailable",
    );
    await expect(summary.getByRole("link", { name: citedText })).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  } finally {
    await seeded.cleanup();
  }
});
