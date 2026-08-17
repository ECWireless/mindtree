import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { installBrowserSessionCookie, seedBrowserSession } from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
const pool = new Pool({ connectionString });

test.afterAll(async () => pool.end());

test("recovers a stale Summary through Branch Outline regeneration and approval", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const rootId = randomUUID();
  const childId = randomUUID();
  const rootMessageId = randomUUID();
  const childMessageId = randomUUID();
  const rootSummaryId = randomUUID();
  const childSummaryId = randomUUID();
  const rootOutlineId = randomUUID();
  const childOutlineId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title) values
       ($1, $3, null, 0, 'Recursive QA root'),
       ($2, $3, $1, 0, 'Recursive QA child')`,
      [rootId, childId, seeded.userId],
    );
    await pool.query(
      `insert into chat_messages
         (id, user_id, node_id, client_message_id, sequence, role, status, content,
          model, context_fingerprint, completed_at) values
       ($1, $3, $4, $5, 0, 'assistant', 'completed', 'Published root response',
        'gpt-5.6-sol', $7, now()),
       ($2, $3, $6, $8, 0, 'assistant', 'completed', 'Published child response',
        'gpt-5.6-sol', $7, now())`,
      [
        rootMessageId,
        childMessageId,
        seeded.userId,
        rootId,
        randomUUID(),
        childId,
        "a".repeat(64),
        randomUUID(),
      ],
    );
    await pool.query(
      `insert into synthesis_versions
         (id, user_id, node_id, base_version_id, status, content, model,
          reasoning_mode, reasoning_effort, input_fingerprint, generating_message_id, decided_at)
       values
       ($1, $3, $4, null, 'approved', '# Root Summary\n\nCurrent root summary',
        'gpt-5.6-sol', 'pro', 'high', $6, $7, now()),
       ($2, $3, $5, null, 'approved', '# Child Summary\n\nReadable stale child summary',
        'gpt-5.6-sol', 'pro', 'high', $6, $8, now())`,
      [
        rootSummaryId,
        childSummaryId,
        seeded.userId,
        rootId,
        childId,
        "b".repeat(64),
        rootMessageId,
        childMessageId,
      ],
    );
    await pool.query(
      `insert into branch_outline_versions
         (id, user_id, node_id, client_request_id, status, content, model,
          reasoning_mode, reasoning_effort, input_fingerprint, completed_at) values
       ($1, $3, $4, $6, 'completed', 'Current root Branch Outline',
        'gpt-5.6-sol', 'pro', 'high', $8, now()),
       ($2, $3, $5, $7, 'completed', 'Readable stale child Branch Outline',
        'gpt-5.6-sol', 'pro', 'high', $8, now())`,
      [
        rootOutlineId,
        childOutlineId,
        seeded.userId,
        rootId,
        childId,
        randomUUID(),
        randomUUID(),
        "c".repeat(64),
      ],
    );
    await pool.query(
      `update nodes set
         published_synthesis_version_id = case id
           when $1 then $3::uuid else $4::uuid end,
         current_branch_outline_version_id = case id
           when $1 then $5::uuid else $6::uuid end,
         synthesis_stale_at = case when id = $2 then now() else null end,
         branch_outline_stale_at = case when id = $2 then now() else null end,
         branch_outline_stale_reason = case
           when id = $2 then 'branch-content-changed' else null end
       where id = any($7::uuid[])`,
      [
        rootId,
        childId,
        rootSummaryId,
        childSummaryId,
        rootOutlineId,
        childOutlineId,
        [rootId, childId],
      ],
    );

    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${childId}`);

    const summary = page.getByRole("region", { name: "Summary" });
    const outline = page.getByRole("region", { name: "Branch Outline" });
    await expect(summary).toContainText("Readable stale child summary");
    const staleWarning = summary.getByRole("button", { name: "Update available" });
    const staleTooltip = summary.getByRole("tooltip");
    await expect(staleWarning).toHaveAttribute("aria-expanded", "false");
    await expect(staleTooltip).toHaveText(
      "This Summary may no longer reflect the current branch. Open Chat to request a refreshed Summary.",
    );
    await staleWarning.click();
    await expect(staleWarning).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => staleTooltip.evaluate(
      (tooltip) => getComputedStyle(tooltip).opacity,
    )).toBe("1");
    const warningBox = await staleWarning.boundingBox();
    const tooltipBox = await staleTooltip.boundingBox();
    const viewportWidth = page.viewportSize()?.width;
    expect(warningBox).not.toBeNull();
    expect(tooltipBox).not.toBeNull();
    expect(viewportWidth).toBeDefined();
    if (warningBox && tooltipBox && viewportWidth) {
      const warningCenter = warningBox.x + warningBox.width / 2;
      const tooltipAnchor = tooltipBox.x + tooltipBox.width * 0.33;
      expect(Math.abs(warningCenter - tooltipAnchor)).toBeLessThan(2);
      expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
      expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(viewportWidth);
    }
    await staleWarning.press("Escape");
    await expect(staleWarning).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => staleTooltip.evaluate(
      (tooltip) => getComputedStyle(tooltip).opacity,
    )).toBe("0");
    await expect(outline).toContainText("Readable stale child Branch Outline");
    await expect(outline).toContainText("Stale · the branch has changed");
    expect((await summary.boundingBox())?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan((await outline.boundingBox())?.y ?? 0);

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const chat = page.getByRole("dialog", { name: "Chat about Recursive QA child" });
    const composer = chat.getByRole("textbox", { name: "Message" });
    await composer.fill("Create a synthesis Summary from this stale branch");
    await chat.getByRole("button", { name: "Send message" }).click();
    await expect(chat.getByText(
      "Regenerate the stale Branch Outline before requesting a new Summary. You can still discuss the existing outline here.",
      { exact: true },
    )).toBeVisible();
    await expect(page.locator(".chat-panel > .sr-only[role='status']"))
      .toHaveText("Assistant response completed.");
    const blockedProposalCount = await pool.query<{ count: number }>(
      `select count(*)::int as count from synthesis_versions
       where user_id = $1 and node_id = $2 and status = 'pending'`,
      [seeded.userId, childId],
    );
    expect(blockedProposalCount.rows).toEqual([{ count: 0 }]);

    await page.getByRole("button", { name: "Close chat" }).click();
    await outline.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(outline).toContainText("No direct child nodes.", { timeout: 10_000 });
    await expect(outline).not.toContainText("Stale · the branch has changed");
    await expect(summary.getByRole("button", { name: "Update available" })).toBeVisible();

    await page.goto(`/?node=${rootId}`);
    const rootSummaryAfterOutline = page.getByRole("region", { name: "Summary" });
    const rootOutlineAfterOutline = page.getByRole("region", { name: "Branch Outline" });
    await expect(rootSummaryAfterOutline.getByRole("button", { name: "Update available" }))
      .toBeVisible();
    await expect(rootOutlineAfterOutline).toContainText("Stale · the branch has changed");

    await page.goto(`/?node=${childId}`);
    await expect(summary.getByRole("button", { name: "Update available" })).toBeVisible();
    await expect(outline).toContainText("No direct child nodes.");
    await expect(outline).not.toContainText("Stale · the branch has changed");

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await composer.fill("Create a synthesis Summary after Branch Outline regeneration");
    await chat.getByRole("button", { name: "Send message" }).click();
    const proposal = page.getByRole("region", { name: "Proposed Summary" });
    await expect(proposal).toBeVisible();
    await expect(page.locator(".chat-panel > .sr-only[role='status']"))
      .toHaveText("Summary proposal request completed.");
    await proposal.getByRole("button", { name: "Approve and publish Summary" }).click();

    await expect(chat).not.toBeVisible();
    await expect(summary.getByRole("heading", { name: "Summary", exact: true }))
      .toBeFocused();
    await expect(summary).toContainText(
      "Create a synthesis Summary after Branch Outline regeneration",
    );
    await expect(summary.getByRole("button", { name: "Update available" })).toHaveCount(0);
    await expect(outline).toContainText("Stale · the branch has changed");

    await page.goto(`/?node=${rootId}`);
    const rootSummary = page.getByRole("region", { name: "Summary" });
    const rootOutline = page.getByRole("region", { name: "Branch Outline" });
    await expect(rootSummary.getByRole("button", { name: "Update available" })).toBeVisible();
    await expect(rootOutline).toContainText("Stale · the branch has changed");
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )).toBe(true);
  } finally {
    await seeded.cleanup();
  }
});
