import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { installBrowserSessionCookie, seedBrowserSession } from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
const pool = new Pool({ connectionString });

async function expectTouchTarget(locator: import("@playwright/test").Locator) {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
}

test.afterAll(async () => pool.end());

test("proposes, refines, rejects, and explicitly publishes a synthesis", async ({ context, page }) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Synthesis flow')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);

    await expect(page.getByText(
      "No synthesis is published yet. Open Chat when this thought is ready to synthesize.",
      { exact: true },
    )).toBeVisible();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const chatDialog = page.getByRole("dialog", { name: "Chat about Synthesis flow" });
    await expect(chatDialog).toBeVisible();
    const composer = chatDialog.getByRole("textbox", { name: "Message" });
    await composer.fill("Propose a synthesis while Chat is closed");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Thinking…").last()).toBeVisible();
    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(chatDialog).not.toBeVisible();
    await expect.poll(async () => {
      const result = await pool.query<{ count: string }>(
        `select count(*)::text as count from synthesis_versions
         where user_id = $1 and node_id = $2 and status = 'pending'`,
        [seeded.userId, nodeId],
      );
      return result.rows[0]?.count;
    }, { timeout: 10_000 }).toBe("1");
    await expect(page.locator(".chat-panel > .sr-only[role='status']"))
      .toHaveText("Synthesis proposal request completed.", { timeout: 10_000 });
    await expect(page.getByRole("heading", {
      name: "Proposed synthesis",
      includeHidden: true,
    })).toBeAttached();
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    const firstReview = page.getByRole("region", { name: "Proposed synthesis" });
    await expect(firstReview).toBeVisible();
    await expect(firstReview.locator(
      "xpath=ancestor::article[contains(@class, 'chat-message--assistant')]",
    )).toBeVisible();
    await expect(firstReview.getByRole("heading", { name: "Proposed synthesis" })).toBeFocused();
    await expect(
      page.locator(".chat-panel > .sr-only[role='status']"),
    ).toHaveText("Synthesis proposal request completed.");
    await expect(firstReview.getByRole("heading", {
      name: "Proposed synthesis",
      exact: true,
    })).toBeVisible();
    await expect(firstReview.getByText(
      "A concise synthetic synthesis proposal.",
      { exact: true },
    )).toBeVisible();
    await expect(firstReview.locator(".synthesis-diff__part--added")).toContainText(
      "Propose a synthesis while Chat is closed",
    );
    await expect(firstReview.locator(".synthesis-diff__part--removed")).toHaveCount(0);
    await expect(firstReview.getByText("Added:", { exact: true })).toBeAttached();

    await expect(firstReview.getByText(
      "To refine this proposal, describe the changes in your next message.",
      { exact: true },
    )).toBeVisible();
    await composer.fill("Make the proposal shorter and more direct");
    await page.getByRole("button", { name: "Send" }).click();

    const refinedReview = page.getByRole("region", { name: "Proposed synthesis" });
    await expect(refinedReview.locator(".synthesis-diff__part--added")).toContainText(
      "Make the proposal shorter and more direct",
    );
    await expect(refinedReview.getByRole("heading", { name: "Proposed synthesis" })).toBeFocused();
    const supersededArtifact = page.locator("details.synthesis-proposal--decided", {
      hasText: "Proposal superseded",
    });
    await supersededArtifact.locator("summary").click();
    await expect(supersededArtifact.getByRole("heading", { name: "Proposed synthesis" }))
      .toBeVisible();
    await expect(supersededArtifact.locator(".synthesis-diff")).toBeVisible();
    await supersededArtifact.locator("summary").click();
    const afterRefinement = await pool.query<{ status: string; count: string }>(
      `select status, count(*)::text as count
       from synthesis_versions where user_id = $1 and node_id = $2
       group by status order by status`,
      [seeded.userId, nodeId],
    );
    expect(afterRefinement.rows).toEqual([
      { status: "pending", count: "1" },
      { status: "superseded", count: "1" },
    ]);

    const reject = refinedReview.getByRole("button", { name: "Reject proposal" });
    await expectTouchTarget(reject);
    await reject.click();
    await expect(composer).toBeFocused();
    await expect(page.getByText("Pending proposal", { exact: true })).toHaveCount(0);
    const rejectedArtifact = page.locator("details.synthesis-proposal--decided", {
      hasText: "Proposal rejected",
    });
    await rejectedArtifact.locator("summary").click();
    await expect(rejectedArtifact.getByRole("heading", { name: "Proposed synthesis" }))
      .toBeVisible();
    await expect(rejectedArtifact.locator(".synthesis-diff")).toBeVisible();
    await rejectedArtifact.locator("summary").click();

    await composer.fill("Propose an approved synthesis candidate");
    await page.getByRole("button", { name: "Send" }).click();
    const approvalReview = page.getByRole("region", { name: "Proposed synthesis" });
    await expect(approvalReview).toBeVisible();
    await composer.fill("Approve it");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.locator(".chat-panel > .sr-only[role='status']"),
    ).toHaveText("Assistant response completed.");
    const beforeExplicitApproval = await pool.query<{
      published_synthesis_version_id: string | null;
    }>(
      `select published_synthesis_version_id from nodes where id = $1 and user_id = $2`,
      [nodeId, seeded.userId],
    );
    expect(beforeExplicitApproval.rows).toEqual([{ published_synthesis_version_id: null }]);
    await expect(approvalReview).toBeVisible();
    const approve = approvalReview.getByRole("button", { name: "Approve and publish" });
    await expectTouchTarget(approve);
    await approve.click();

    await expect(chatDialog).not.toBeVisible();
    const published = page.getByRole("region", { name: "Summary" });
    await expect(published.getByRole("heading", { name: "Summary" })).toBeFocused();
    await expect(published.getByText("Propose an approved synthesis candidate", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator("details.synthesis-proposal--decided", {
      hasText: "Proposal approved",
    }).locator("summary")).toBeVisible();

    const persisted = await pool.query<{
      published_synthesis_version_id: string | null;
      pending_count: string;
    }>(
      `select n.published_synthesis_version_id,
              count(s.id) filter (where s.status = 'pending')::text as pending_count
       from nodes n
       left join synthesis_versions s on s.node_id = n.id and s.user_id = n.user_id
       where n.id = $1 and n.user_id = $2
       group by n.id`,
      [nodeId, seeded.userId],
    );
    expect(persisted.rows[0]?.published_synthesis_version_id).not.toBeNull();
    expect(persisted.rows[0]?.pending_count).toBe("0");

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  } finally {
    await seeded.cleanup();
  }
});

test("bounds adversarial diff work and recovers from a stale decision", async ({ context, page }) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();
  const publishedMessageId = randomUUID();
  const pendingMessageId = randomUUID();
  const publishedVersionId = randomUUID();
  const proposalId = randomUUID();
  const manyPublishedLines = Array.from({ length: 4_000 }, (_, index) => `o${index}`).join("\n");
  const manyChangedLines = Array.from({ length: 4_000 }, (_, index) => `n${index}`).join("\n");

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Long synthesis')`,
      [nodeId, seeded.userId],
    );
    await pool.query(
      `insert into chat_messages
         (id, user_id, node_id, client_message_id, sequence, role, status, content,
          model, context_fingerprint, completed_at)
       values
         ($1, $3, $4, $5, 0, 'assistant', 'completed', 'Published response',
          'gpt-5.6-sol', $7, now()),
         ($2, $3, $4, $6, 1, 'assistant', 'completed', 'Pending response',
          'gpt-5.6-sol', $7, now())`,
      [
        publishedMessageId,
        pendingMessageId,
        seeded.userId,
        nodeId,
        randomUUID(),
        randomUUID(),
        "a".repeat(64),
      ],
    );
    await pool.query(
      `insert into synthesis_versions
         (id, user_id, node_id, base_version_id, status, content, model,
          reasoning_mode, reasoning_effort, input_fingerprint, generating_message_id, decided_at)
       values
         ($1, $3, $4, null, 'approved', $5, 'gpt-5.6-sol', 'pro', 'high', $7, $8, now()),
         ($2, $3, $4, $1, 'pending', $6, 'gpt-5.6-sol', 'pro', 'high', $7, $9, null)`,
      [
        publishedVersionId,
        proposalId,
        seeded.userId,
        nodeId,
        `# Published\n\n${manyPublishedLines}`,
        `# Long proposal\n\n${manyChangedLines}`,
        "b".repeat(64),
        publishedMessageId,
        pendingMessageId,
      ],
    );
    await pool.query(
      `update nodes set published_synthesis_version_id = $1 where id = $2`,
      [publishedVersionId, nodeId],
    );

    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const diff = page.getByRole("region", { name: "Proposed synthesis" })
      .locator(".synthesis-diff");
    await expect(diff).toBeVisible();
    await expect(page.getByText("Detailed comparison was simplified", { exact: false })).toBeVisible();
    const dimensions = await diff.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    const documentDimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(documentDimensions.scrollWidth).toBeLessThanOrEqual(documentDimensions.clientWidth);

    await pool.query(
      `update synthesis_versions
       set status = 'rejected', decided_at = now(), updated_at = now()
       where id = $1 and status = 'pending'`,
      [proposalId],
    );
    await page.getByRole("button", { name: "Approve and publish" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
    await expect(page.getByRole("region", { name: "Proposed synthesis" })).toHaveCount(0);
    await page.getByRole("button", { name: "Close chat" }).click();
    const reconciled = page.getByRole("region", { name: "Summary" });
    await expect(reconciled).toBeVisible();
  } finally {
    await seeded.cleanup();
  }
});
