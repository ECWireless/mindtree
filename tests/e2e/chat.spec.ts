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

test("requires authentication before chat request validation", async ({ request }) => {
  const response = await request.post("/api/chat", { data: { nodeId: "not-a-node" } });
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toEqual({ message: "Authentication is required." });
});

test("loads, retries, streams, persists, and isolates per-node conversation history", async ({ context, page }, testInfo) => {
  const seeded = await seedBrowserSession(pool);
  const firstNodeId = randomUUID();
  const secondNodeId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $3, null, 0, 'Chat alpha'), ($2, $3, null, 1, 'Chat beta')`,
      [firstNodeId, secondNodeId, seeded.userId],
    );
    for (let index = 0; index < 26; index += 1) {
      const clientMessageId = randomUUID();
      await pool.query(
        `insert into chat_messages
          (user_id, node_id, client_message_id, sequence, role, status, content, completed_at)
         values
          ($1, $2, $3, $4, 'user', 'completed', $6, now()),
          ($1, $2, $3, $5, 'assistant', 'completed', $7, now())`,
        [seeded.userId, firstNodeId, clientMessageId, index * 2, index * 2 + 1, `Question ${index}`, `Answer ${index}`],
      );
    }
    await pool.query(
      `update chat_messages
       set status = 'failed', content = '', completed_at = null, failure_code = 'generation-failed'
       where user_id = $1 and node_id = $2 and sequence = 1`,
      [seeded.userId, firstNodeId],
    );
    const failedClientMessageId = randomUUID();
    await pool.query(
      `insert into chat_messages
        (user_id, node_id, client_message_id, sequence, role, status, content, completed_at, failure_code)
       values
        ($1, $2, $3, 52, 'user', 'completed', 'Retry question', now(), null),
        ($1, $2, $3, 53, 'assistant', 'failed', '', null, 'generation-failed')`,
      [seeded.userId, firstNodeId, failedClientMessageId],
    );

    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${firstNodeId}`);

    const conversation = page.getByRole("region", { name: "Develop this thought" });
    await expect(conversation).toBeVisible();
    const history = page.locator(".chat-history");
    await expect.poll(() => history.evaluate((element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
    )).toBeLessThan(4);
    await expect(page.getByText("Question 0", { exact: true })).toHaveCount(0);
    await history.evaluate((element) => { element.scrollTop = 0; });
    const loadOlder = page.getByRole("button", { name: "Load older" });
    await expectTouchTarget(loadOlder);
    await loadOlder.click();
    await expect(page.getByText("Question 0", { exact: true })).toBeVisible();
    await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await history.evaluate((element) => { element.scrollTop = element.scrollHeight; });

    let truncated = false;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST" || truncated) {
        await route.continue();
        return;
      }
      truncated = true;
      const response = await route.fetch();
      const firstEvent = (await response.text()).split("\n")[0] ?? "";
      await route.fulfill({
        status: response.status(),
        headers: { ...response.headers(), "content-length": String(firstEvent.length + 1) },
        body: `${firstEvent}\n`,
      });
    });
    const olderRetry = page.getByRole("button", { name: "Retry" }).first();
    await olderRetry.click();
    await expect(page.locator(".chat-message--assistant").filter({ hasText: "Question 0" })).toBeVisible();
    expect(truncated).toBe(true);
    const userMessageOrder = await page.locator(".chat-message--user > .chat-message__content").allTextContents();
    expect(userMessageOrder.indexOf("Question 0")).toBeLessThan(userMessageOrder.indexOf("Question 1"));

    const retry = page.getByRole("button", { name: "Retry" });
    await expectTouchTarget(retry);
    await retry.click();
    await expect(page.locator(".chat-message--assistant").filter({ hasText: "Retry question" })).toBeVisible();

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Stop early");
    await composer.focus();
    await page.keyboard.press("Tab");
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeFocused();
    await expectTouchTarget(send);
    await send.click();
    await expect(page.getByText("Thinking…").last()).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop" });
    await expectTouchTarget(stop);
    await stop.click();
    await expect(page.getByText("Response stopped.").last()).toBeVisible();
    await page.reload();
    await expect(page.getByText("Response stopped.").last()).toBeVisible();

    await page.getByRole("textbox", { name: "Message" }).fill("A fresh angle");
    await page.getByRole("button", { name: "Send" }).click();
    const freshUserMessage = page.locator(".chat-message--user").getByText("A fresh angle", { exact: true });
    await expect(freshUserMessage).toBeVisible();
    await expect(page.getByText("Assistant response completed.")).toBeAttached();
    await expect.poll(() => history.evaluate((element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
    )).toBeLessThan(4);
    await page.reload();
    await expect(page.locator(".chat-message--user").getByText("A fresh angle", { exact: true })).toBeVisible();
    await expect(page.getByText(/What evidence would change your view/).last()).toBeVisible();
    const generated = await pool.query<{
      context_fingerprint: string;
      model: string;
      provider_response_id: string;
      status: string;
    }>(
      `select assistant.context_fingerprint, assistant.model,
              assistant.provider_response_id, assistant.status
       from chat_messages as owner_message
       join chat_messages as assistant
         on assistant.user_id = owner_message.user_id
        and assistant.node_id = owner_message.node_id
        and assistant.client_message_id = owner_message.client_message_id
        and assistant.role = 'assistant'
       where owner_message.user_id = $1
         and owner_message.node_id = $2
         and owner_message.role = 'user'
         and owner_message.content = 'A fresh angle'`,
      [seeded.userId, firstNodeId],
    );
    expect(generated.rows).toEqual([{
      context_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      model: "gpt-5.6-sol",
      provider_response_id: "fixture-response",
      status: "completed",
    }]);

    if (testInfo.project.name === "mobile") {
      await page.getByRole("link", { name: "Back to thoughts" }).click();
    }
    await page.getByRole("link", { name: /Chat beta/ }).click();
    await expect(page.getByText("No messages yet.", { exact: false })).toBeVisible();
    await expect(page.locator(".chat-message--user").getByText("A fresh angle", { exact: true })).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  } finally {
    await seeded.cleanup();
  }
});
