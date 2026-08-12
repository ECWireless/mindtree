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

async function expectHistoryScrollChaining(
  page: import("@playwright/test").Page,
  outerSelector: string | null,
) {
  const history = page.locator(".chat-history");
  await expect(history.evaluate((element) => getComputedStyle(element).overscrollBehaviorY))
    .resolves.toBe("auto");
  if (!outerSelector) return;

  async function positionAtTopBoundary() {
    return page.evaluate((outerSelector) => {
      const historyElement = document.querySelector<HTMLElement>(".chat-history");
      const outer: HTMLElement | null = outerSelector
        ? document.querySelector<HTMLElement>(outerSelector)
        : document.scrollingElement as HTMLElement | null;
      if (!historyElement || !outer) throw new Error("Scroll containers are unavailable.");
      const maxOuterScroll = outer.scrollHeight - outer.clientHeight;
      const scrollBehavior = outer.style.scrollBehavior;
      outer.style.scrollBehavior = "auto";
      outer.scrollTop = Math.min(maxOuterScroll, 200);
      outer.style.scrollBehavior = scrollBehavior;
      historyElement.scrollTop = 0;
      return outer.scrollTop;
    }, outerSelector);
  }

  async function positionAtBottomBoundary() {
    return page.evaluate((outerSelector) => {
      const historyElement = document.querySelector<HTMLElement>(".chat-history");
      const outer: HTMLElement | null = outerSelector
        ? document.querySelector<HTMLElement>(outerSelector)
        : document.scrollingElement as HTMLElement | null;
      if (!historyElement || !outer) throw new Error("Scroll containers are unavailable.");
      const maxOuterScroll = outer.scrollHeight - outer.clientHeight;
      const scrollBehavior = outer.style.scrollBehavior;
      outer.style.scrollBehavior = "auto";
      outer.scrollTop = Math.max(0, maxOuterScroll - 200);
      outer.style.scrollBehavior = scrollBehavior;
      historyElement.scrollTop = historyElement.scrollHeight;
      return { maxOuterScroll, outerScrollTop: outer.scrollTop };
    }, outerSelector);
  }

  async function hoverVisibleHistory() {
    const box = await history.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    const visibleTop = Math.max(0, box!.y);
    const visibleBottom = Math.min(viewport!.height, box!.y + box!.height);
    expect(visibleBottom - visibleTop).toBeGreaterThan(10);
    await page.mouse.move(box!.x + box!.width / 2, (visibleTop + visibleBottom) / 2);
  }

  const topOuterScroll = await positionAtTopBoundary();
  expect(topOuterScroll).toBeGreaterThan(0);
  await hoverVisibleHistory();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => page.evaluate((selector) => {
    const outer = selector
      ? document.querySelector<HTMLElement>(selector)
      : document.scrollingElement;
    return outer?.scrollTop ?? 0;
  }, outerSelector)).toBeLessThan(1);

  const bottom = await positionAtBottomBoundary();
  expect(bottom.maxOuterScroll - bottom.outerScrollTop).toBeGreaterThan(0);
  await hoverVisibleHistory();
  await page.mouse.wheel(0, 60);
  await expect.poll(() => page.evaluate((selector) => {
    const outer = selector
      ? document.querySelector<HTMLElement>(selector)
      : document.scrollingElement;
    return outer?.scrollTop ?? 0;
  }, outerSelector)).toBeGreaterThan(bottom.outerScrollTop);
  const bottomOuterScroll = await page.evaluate((selector) =>
    document.querySelector<HTMLElement>(selector!)?.scrollTop ?? 0, outerSelector);
  expect(bottomOuterScroll).toBeLessThanOrEqual(bottom.outerScrollTop + 65);
}

test.afterAll(async () => pool.end());

test("requires authentication before chat request validation", async ({ request }) => {
  const response = await request.post("/api/chat", { data: { nodeId: "not-a-node" } });
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toEqual({ message: "Authentication is required." });
});

test("authorizes web sources for one message and renders validated citations", async ({ context, page }) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Web research node')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    const useWebSources = page.getByRole("checkbox", { name: "Use web sources" });
    const composer = page.getByRole("textbox", { name: "Message" });
    await expectTouchTarget(page.locator(".chat-composer__web-toggle"));
    await expect(useWebSources).not.toBeChecked();
    await useWebSources.check();
    await composer.fill("Research a synthetic topic");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(useWebSources).not.toBeChecked();
    await expect(page.getByText("Web sources enabled for this message.")).toBeVisible();
    const liveStatus = page.locator(".chat-panel > .sr-only[role='status']");
    await expect(page.getByText("Researching web sources…")).toBeVisible();
    await expect(liveStatus).toHaveText("Researching web sources.");
    await expect(liveStatus)
      .toHaveText("Assistant response completed.");
    const citation = page.getByRole("link", {
      name: "Source 1: Synthetic research source. Opens in a new tab.",
    });
    await expect(citation).toHaveText("[1]");
    await expect(citation).toHaveAttribute("href", "https://example.test/research");
    await expect(citation).toHaveAttribute("target", "_blank");

    let disconnected = false;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() === "POST" && !disconnected) {
        disconnected = true;
        await route.abort();
        return;
      }
      await route.continue();
    });
    await useWebSources.check();
    await composer.fill("Retry web research before acknowledgement");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(useWebSources).not.toBeChecked();
    await expect(page.getByText("That response didn’t finish.")).toBeVisible();
    await page.unroute("**/api/chat");
    await page.getByRole("button", { name: "Retry" }).last().click();
    await expect(page.getByText("Researching web sources…")).toBeVisible();
    await expect(liveStatus).toHaveText("Assistant response completed.");
    const preAcknowledgementRetry = await pool.query<{
      id: string;
      role: "assistant" | "user";
      status: string;
      web_search_authorized: boolean;
    }>(
      `select id, role, status, web_search_authorized
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = (
         select client_message_id from chat_messages
         where user_id = $1 and node_id = $2 and role = 'user' and content = $3
       )
       order by sequence`,
      [seeded.userId, nodeId, "Retry web research before acknowledgement"],
    );
    expect(preAcknowledgementRetry.rows).toMatchObject([
      { role: "user", status: "completed", web_search_authorized: true },
      { role: "assistant", status: "completed" },
    ]);
    const preAcknowledgementAssistantId = preAcknowledgementRetry.rows
      .find(({ role }) => role === "assistant")?.id;
    const preAcknowledgementCitations = await pool.query<{ count: number }>(
      `select count(*)::int as count from citations where assistant_message_id = $1`,
      [preAcknowledgementAssistantId],
    );
    expect(preAcknowledgementCitations.rows).toEqual([{ count: 1 }]);

    const persistedRetryId = randomUUID();
    await pool.query(
      `insert into chat_messages
        (user_id, node_id, client_message_id, sequence, role, status, content,
         web_search_authorized, completed_at, failure_code)
       values
        ($1, $2, $3, 4, 'user', 'completed', 'Retry persisted web research', true, now(), null),
        ($1, $2, $3, 5, 'assistant', 'failed', '', false, null, 'generation-failed')`,
      [seeded.userId, nodeId, persistedRetryId],
    );
    const persistedAssistantBeforeRetry = await pool.query<{ id: string }>(
      `select id from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3 and role = 'assistant'`,
      [seeded.userId, nodeId, persistedRetryId],
    );
    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(useWebSources).not.toBeChecked();
    await page.getByRole("button", { name: "Retry" }).last().click();
    await expect(page.getByText("Researching web sources…")).toBeVisible();
    await expect(liveStatus).toHaveText("Assistant response completed.");
    await expect(citation).toHaveCount(3);
    const persistedAssistantAfterRetry = await pool.query<{
      id: string;
      status: string;
      citation_count: number;
    }>(
      `select m.id, m.status, count(c.id)::int as citation_count
       from chat_messages m
       left join citations c on c.assistant_message_id = m.id
       where m.user_id = $1 and m.node_id = $2 and m.client_message_id = $3
         and m.role = 'assistant'
       group by m.id`,
      [seeded.userId, nodeId, persistedRetryId],
    );
    expect(persistedAssistantAfterRetry.rows).toEqual([{
      id: persistedAssistantBeforeRetry.rows[0]?.id,
      status: "completed",
      citation_count: 1,
    }]);

    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByText("Web sources enabled for this message.")).toHaveCount(3);
    await expect(page.getByRole("link", {
      name: "Source 1: Synthetic research source. Opens in a new tab.",
    })).toHaveCount(3);
  } finally {
    await pool.query(`delete from "user" where id = $1`, [seeded.userId]);
  }
});

test("publishes cited web research with durable inline markers and References", async ({ context, page }) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Cited research synthesis')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    const chatDialog = page.getByRole("dialog", { name: "Chat about Cited research synthesis" });
    await chatDialog.getByRole("checkbox", { name: "Use web sources" }).check();
    await chatDialog.getByRole("textbox", { name: "Message" })
      .fill("Research and propose a synthesis");
    await chatDialog.getByRole("button", { name: "Send" }).click();

    const proposal = chatDialog.getByRole("region", { name: "Proposed synthesis" });
    await expect(proposal).toBeVisible({ timeout: 10_000 });
    const inlineCitation = proposal.getByRole("link", {
      name: "Source 1: Synthetic research source. Opens in a new tab.",
    });
    await expect(inlineCitation).toHaveText("[1]");
    await expect(inlineCitation).toHaveAttribute("href", "https://example.test/research");
    const proposalReferences = proposal.getByRole("region", { name: "External references" });
    await expect(proposalReferences.getByRole("heading", { name: "References" })).toBeVisible();
    await expect(proposalReferences.getByRole("link", { name: "Synthetic research source" }))
      .toHaveAttribute("href", "https://example.test/research");
    await expect(proposalReferences.getByText("External source · may change", { exact: true }))
      .toBeVisible();

    await proposal.getByRole("button", { name: "Approve and publish" }).click();
    await expect(chatDialog).not.toBeVisible();
    const published = page.getByRole("region", { name: "Summary" });
    await expect(published.getByRole("link", {
      name: "Source 1: Synthetic research source. Opens in a new tab.",
    })).toHaveText("[1]");
    const publishedReferences = page.getByRole("region", { name: "External references" });
    await expect(publishedReferences.getByRole("link", { name: "Synthetic research source" }))
      .toHaveAttribute("href", "https://example.test/research");
    await expect(publishedReferences.evaluate((references) => {
      const outline = document.querySelector(".branch-outline");
      return Boolean(
        outline &&
        (references.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
    })).resolves.toBe(true);

    await page.reload();
    await expect(page.getByRole("region", { name: "External references" })
      .getByRole("link", { name: "Synthetic research source" }))
      .toHaveAttribute("href", "https://example.test/research");
  } finally {
    await seeded.cleanup();
  }
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

    const chatButton = page.getByRole("button", { name: "Chat", exact: true });
    await expectTouchTarget(chatButton);
    await chatButton.click();
    const chatDialog = page.getByRole("dialog", { name: "Chat about Chat alpha" });
    await expect(chatDialog).toBeVisible();
    await expectTouchTarget(page.getByRole("button", { name: "Close chat" }));
    await page.keyboard.press("Escape");
    await expect(chatDialog).not.toBeVisible();
    await expect(chatButton).toBeFocused();
    await chatButton.click();
    await expect(chatDialog).toBeVisible();
    const conversation = chatDialog.getByRole("region", { name: "Conversation for Chat alpha" });
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
    await expectHistoryScrollChaining(
      page,
      null,
    );
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
    await composer.fill("Keyboard line one");
    await composer.press("Shift+Enter");
    await composer.type("Keyboard line two");
    await expect(composer).toHaveValue("Keyboard line one\nKeyboard line two");
    await composer.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    })));
    await expect(composer).toHaveValue("Keyboard line one\nKeyboard line two");
    await expect(page.locator(".chat-message--user").filter({ hasText: "Keyboard line one" })).toHaveCount(0);
    await composer.press("Enter");
    const liveStatus = conversation.getByRole("status");
    await expect(liveStatus).toHaveText("Assistant response started.");
    await expect(page.locator(".chat-message--user").filter({ hasText: "Keyboard line one" })).toBeVisible();
    await expect(liveStatus).toHaveText("Assistant response completed.");

    await composer.fill("Keep this fixture response open");
    await composer.focus();
    await page.keyboard.press("Tab");
    const webToggle = page.getByRole("checkbox", { name: "Use web sources" });
    await expect(webToggle).toBeFocused();
    await expect(webToggle).toHaveAccessibleDescription(
      "Applies to the next message only. External sources may change.",
    );
    await page.keyboard.press("Tab");
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeFocused();
    await expectTouchTarget(send);
    await send.click();
    await expect(page.getByText("Thinking…").last()).toBeVisible();
    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(chatDialog).not.toBeVisible();
    await expect(chatButton).toBeFocused();
    await chatButton.click();
    await expect(page.getByText("Thinking…").last()).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop" });
    await expectTouchTarget(stop);
    await stop.click();
    await expect(page.getByText("Response stopped.").last()).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
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
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator(".chat-message--user").getByText("A fresh angle", { exact: true })).toBeVisible();
    await expect(page.getByText(/What evidence would change your view/).last()).toBeVisible();
    await expect(history.locator(".chat-composer")).toHaveCount(0);
    await expect(chatDialog.locator(".chat-composer")).toHaveCount(1);
    const historyBox = await history.boundingBox();
    const composerBox = await chatDialog.locator(".chat-composer").boundingBox();
    expect(historyBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.y).toBeGreaterThanOrEqual(historyBox!.y + historyBox!.height - 1);
    const historyDimensions = await history.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(historyDimensions.scrollWidth).toBeLessThanOrEqual(historyDimensions.clientWidth);
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

    await page.getByRole("button", { name: "Close chat" }).click();
    if (testInfo.project.name === "mobile") {
      await page.getByRole("link", { name: "Back to thoughts" }).click();
    }
    await page.getByRole("link", { name: /Chat beta/ }).click();
    await expect(page.getByRole("heading", { name: "Chat beta", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const emptyChatDialog = page.getByRole("dialog", { name: "Chat about Chat beta" });
    await expect(emptyChatDialog).toBeVisible();
    await expect(page.getByText("No messages yet.", { exact: false })).toBeVisible();
    await expect(page.locator(".chat-message--user").getByText("A fresh angle", { exact: true })).toHaveCount(0);
    const emptyHistoryBox = await emptyChatDialog.locator(".chat-history").boundingBox();
    const emptyComposerBox = await emptyChatDialog.locator(".chat-composer").boundingBox();
    expect(emptyHistoryBox).not.toBeNull();
    expect(emptyComposerBox).not.toBeNull();
    expect(emptyComposerBox!.y).toBeGreaterThanOrEqual(
      emptyHistoryBox!.y + emptyHistoryBox!.height - 1,
    );
    expect(emptyComposerBox!.height).toBeLessThan(220);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  } finally {
    await seeded.cleanup();
  }
});
