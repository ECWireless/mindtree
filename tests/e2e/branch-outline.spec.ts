import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { installBrowserSessionCookie, seedBrowserSession } from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
const pool = new Pool({ connectionString });

test.afterAll(async () => pool.end());

test("generates and regenerates a Branch Outline below Summary", async ({ context, page }) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();
  const childId = randomUUID();
  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title) values
       ($1, $3, null, 0, 'Outline browser flow'),
       ($2, $3, $1, 0, 'Outline child')`,
      [nodeId, childId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);

    const summary = page.getByRole("region", { name: "Summary" });
    const outline = page.getByRole("region", { name: "Branch Outline" });
    await expect(summary).toContainText("No synthesis is published yet");
    await expect(outline).toContainText("No Branch Outline yet");
    const generate = outline.getByRole("button", { name: "Generate", exact: true });
    const generateBox = await generate.boundingBox();
    expect(generateBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(generateBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    await generate.click();

    await expect(outline).toContainText("Branch direction", { timeout: 10_000 });
    await expect(outline).toContainText("1 direct child thread");
    await expect(outline.getByRole("button", { name: "Regenerate", exact: true }))
      .toBeEnabled();
    await expect(summary).toContainText("No synthesis is published yet");
    const first = await pool.query<{ id: string }>(
      `select id from branch_outline_versions
       where user_id = $1 and node_id = $2 and status = 'completed'`,
      [seeded.userId, nodeId],
    );
    expect(first.rows).toHaveLength(1);

    await outline.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect.poll(async () => {
      const result = await pool.query<{ count: number }>(
        `select count(*)::int as count from branch_outline_versions
         where user_id = $1 and node_id = $2 and status = 'completed'`,
        [seeded.userId, nodeId],
      );
      return result.rows[0]?.count;
    }).toBe(2);
    const current = await pool.query<{ current_id: string; summary_id: string | null }>(
      `select current_branch_outline_version_id as current_id,
              published_synthesis_version_id as summary_id
       from nodes where id = $1`,
      [nodeId],
    );
    expect(current.rows[0]?.current_id).not.toBe(first.rows[0]?.id);
    expect(current.rows[0]?.summary_id).toBeNull();
  } finally {
    await pool.query(`delete from "user" where id = $1`, [seeded.userId]);
  }
});

test("shows pending, stale, and retryable failure states without losing current content", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const pendingNodeId = randomUUID();
  const staleNodeId = randomUUID();
  const failedNodeId = randomUUID();
  const firstFailureNodeId = randomUUID();
  const pendingId = randomUUID();
  const staleCurrentId = randomUUID();
  const failedCurrentId = randomUUID();
  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title) values
       ($1, $4, null, 0, 'Pending outline state'),
       ($2, $4, null, 1, 'Stale outline state'),
       ($3, $4, null, 2, 'Failed outline state')`,
      [pendingNodeId, staleNodeId, failedNodeId, seeded.userId],
    );
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 3, 'First outline failure')`,
      [firstFailureNodeId, seeded.userId],
    );
    await pool.query(
      `insert into branch_outline_versions
         (id, user_id, node_id, client_request_id, status, content, model,
          reasoning_mode, reasoning_effort, input_fingerprint, failure_code, completed_at) values
       ($1, $4, $5, $8, 'pending', '', 'gpt-5.6-sol', 'pro', 'high', $9, null, null),
       ($2, $4, $6, $10, 'completed', 'Persisted stale outline', 'gpt-5.6-sol',
        'pro', 'high', $9, null, now() - interval '2 seconds'),
       ($3, $4, $7, $11, 'completed', 'Preserved current outline', 'gpt-5.6-sol',
        'pro', 'high', $9, null, now() - interval '2 seconds'),
       ($12, $4, $7, $13, 'failed', '', 'gpt-5.6-sol', 'pro', 'high', $9,
        'provider-timeout', null)`,
      [
        pendingId,
        staleCurrentId,
        failedCurrentId,
        seeded.userId,
        pendingNodeId,
        staleNodeId,
        failedNodeId,
        randomUUID(),
        "a".repeat(64),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await pool.query(
      `update nodes set
         current_branch_outline_version_id = case
           when id = $1 then $3
           when id = $2 then $4
           else current_branch_outline_version_id
         end,
         branch_outline_stale_at = case when id = $1 then now() else null end,
         branch_outline_stale_reason = case
           when id = $1 then 'branch-content-changed'
           else null
         end
       where id = any($5::uuid[])`,
      [staleNodeId, failedNodeId, staleCurrentId, failedCurrentId, [staleNodeId, failedNodeId]],
    );
    await pool.query(
      `insert into branch_outline_versions
         (user_id, node_id, client_request_id, status, content, model,
          reasoning_mode, reasoning_effort, input_fingerprint, failure_code)
       values ($1, $2, $3, 'failed', '', 'gpt-5.6-sol', 'pro', 'high', $4,
         'stream-disconnected')`,
      [seeded.userId, firstFailureNodeId, randomUUID(), "b".repeat(64)],
    );
    await installBrowserSessionCookie(context, seeded.cookie);

    await page.goto(`/?node=${pendingNodeId}`);
    const pending = page.getByRole("region", { name: "Branch Outline" });
    await expect(pending.getByRole("button", { name: "Generating…" })).toBeDisabled();
    await expect(pending.getByRole("status")).toHaveText("Generating Branch Outline…");
    const reconciliation = await pool.connect();
    try {
      await reconciliation.query("begin");
      await reconciliation.query(
        `update branch_outline_versions
         set status = 'completed', content = 'Reconciled pending outline',
             completed_at = now(), updated_at = now()
         where id = $1`,
        [pendingId],
      );
      await reconciliation.query(
        `update nodes set current_branch_outline_version_id = $1 where id = $2`,
        [pendingId, pendingNodeId],
      );
      await reconciliation.query("commit");
    } finally {
      await reconciliation.query("rollback").catch(() => undefined);
      reconciliation.release();
    }
    await expect(pending).toContainText("Reconciled pending outline", { timeout: 6_000 });
    await expect(pending.getByRole("status")).toHaveCount(0);
    await expect(pending.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();

    await page.goto(`/?node=${staleNodeId}`);
    const stale = page.getByRole("region", { name: "Branch Outline" });
    await expect(stale).toContainText("Persisted stale outline");
    await expect(stale).toContainText("Stale · the branch has changed");
    await expect(stale.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();

    await page.goto(`/?node=${failedNodeId}`);
    const failed = page.getByRole("region", { name: "Branch Outline" });
    await expect(failed).toContainText("Preserved current outline");
    await expect(failed.getByRole("alert")).toHaveText(
      "Generation was interrupted. Your previous Branch Outline is unchanged.",
    );
    await expect(failed.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();

    await page.goto(`/?node=${firstFailureNodeId}`);
    const firstFailure = page.getByRole("region", { name: "Branch Outline" });
    await expect(firstFailure.getByRole("alert")).toHaveText(
      "Generation was interrupted. Please try again.",
    );
    await expect(firstFailure.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  } finally {
    await pool.query(`delete from "user" where id = $1`, [seeded.userId]);
  }
});
