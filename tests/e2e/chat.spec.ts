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

async function expectIconCentered(locator: import("@playwright/test").Locator) {
  const offset = await locator.evaluate((button) => {
    const icon = button.querySelector("svg");
    if (!icon) throw new Error("Icon is unavailable.");
    const buttonRect = button.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    return {
      x: (iconRect.left + iconRect.width / 2) - (buttonRect.left + buttonRect.width / 2),
      y: (iconRect.top + iconRect.height / 2) - (buttonRect.top + buttonRect.height / 2),
    };
  });
  expect(Math.abs(offset.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(offset.y)).toBeLessThanOrEqual(0.5);
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

    const useWebSources = page.getByRole("checkbox", { name: "Use external sources" });
    const composer = page.getByRole("textbox", { name: "Message" });
    await expectTouchTarget(page.locator(".chat-composer__web-toggle"));
    await expect(useWebSources).not.toBeChecked();
    await useWebSources.check();
    await composer.fill("Research a synthetic topic");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(useWebSources).not.toBeChecked();
    await expect(page.getByText("External sources enabled for this message.")).toBeVisible();
    const liveStatus = page.locator(".chat-panel > .sr-only[role='status']");
    await expect(page.locator(".chat-message__state").getByText(
      "Reading external sources… This can take up to 2 minutes.",
      { exact: true },
    )).toBeVisible();
    await expect(liveStatus).toHaveText(
      "Reading external sources… This can take up to 2 minutes.",
    );
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
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(useWebSources).not.toBeChecked();
    await expect(page.locator(".chat-message__failure").getByText(
      "External research was interrupted. Try again.",
      { exact: true },
    )).toBeVisible();
    await page.unroute("**/api/chat");
    await page.getByRole("button", { name: "Retry" }).last().click();
    await expect(page.locator(".chat-message__state").getByText(
      "Reading external sources… This can take up to 2 minutes.",
      { exact: true },
    )).toBeVisible();
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
    await expect(page.locator(".chat-message__state").getByText(
      "Reading external sources… This can take up to 2 minutes.",
      { exact: true },
    )).toBeVisible();
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
    await expect(page.getByText("External sources enabled for this message.")).toHaveCount(3);
    await expect(page.getByRole("link", {
      name: "Source 1: Synthetic research source. Opens in a new tab.",
    })).toHaveCount(3);
  } finally {
    await pool.query(`delete from "user" where id = $1`, [seeded.userId]);
  }
});

test("attaches one explicitly supplied PDF and renders its validated destination", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();
  const pdfUrl =
    "https://bpb-us-e2.wpmucdn.com/websites.umass.edu/dist/a/27637/files/2016/03/rosenblatt-1957.pdf";

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Direct PDF research')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    await page.getByRole("checkbox", { name: "Use external sources" }).check();
    await page.getByRole("textbox", { name: "Message" }).fill(
      `Give me one short supported claim from ${pdfUrl}`,
    );
    await page.getByRole("button", { name: "Send message" }).click();

    const citation = page.getByRole("link", {
      name: "Source 1: rosenblatt-1957.pdf. Opens in a new tab.",
    });
    await expect(citation).toHaveAttribute("href", pdfUrl);
    await expect(page.getByText("External sources enabled for this message."))
      .toBeVisible();
  } finally {
    await seeded.cleanup();
  }
});

test("shows a concise durable error when web research cannot verify a source", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Unverifiable web source')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    const useWebSources = page.getByRole("checkbox", { name: "Use external sources" });
    const composer = page.getByRole("textbox", { name: "Message" });
    const liveStatus = page.locator(".chat-panel > .sr-only[role='status']");
    const failure = "Couldn’t verify that source. Try one webpage or HTTPS PDF.";
    const progress = "Reading external sources… This can take up to 2 minutes.";

    await useWebSources.check();
    await composer.fill("Research an unverifiable synthetic source");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-message__state").getByText(progress, { exact: true }))
      .toBeVisible();
    await expect(liveStatus).toHaveText(progress);
    await expect(page.locator(".chat-message__failure").getByText(
      failure,
      { exact: true },
    )).toBeVisible();
    await expect(liveStatus).toHaveText(failure);
    await expect(page.getByText("That response didn’t finish.", { exact: true }))
      .toHaveCount(0);

    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator(".chat-message__failure").getByText(
      failure,
      { exact: true },
    )).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".chat-message__state").getByText(progress, { exact: true }))
      .toBeVisible();
    await expect(page.locator(".chat-message__failure").getByText(
      failure,
      { exact: true },
    )).toBeVisible();
    await expect(liveStatus).toHaveText(failure);
  } finally {
    await seeded.cleanup();
  }
});

test("presents durable refusal and incomplete research recovery", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();
  const cases = [
    {
      content: "Research a synthetic refusal",
      failureCode: "provider-refusal",
      message: "External research couldn’t answer that request. Try rephrasing it.",
    },
    {
      content: "Research a synthetic incomplete result",
      failureCode: "generation-failed",
      message: "External research returned no verified result. Try again.",
    },
  ] as const;

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Research recovery states')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    const chatDialog = page.getByRole("dialog", {
      name: "Chat about Research recovery states",
    });
    const liveStatus = chatDialog.locator(".chat-panel > .sr-only[role='status']");
    for (const testCase of cases) {
      await chatDialog.getByRole("checkbox", { name: "Use external sources" }).check();
      await chatDialog.getByRole("textbox", { name: "Message" }).fill(testCase.content);
      await chatDialog.getByRole("button", { name: "Send message" }).click();
      await expect(chatDialog.locator(".chat-message__failure").getByText(
        testCase.message,
        { exact: true },
      )).toBeVisible();
      await expect(liveStatus).toHaveText(testCase.message);
    }
    await expect(chatDialog.getByText("That response didn’t finish.", { exact: true }))
      .toHaveCount(0);

    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    for (const testCase of cases) {
      await expect(chatDialog.locator(".chat-message__failure").getByText(
        testCase.message,
        { exact: true },
      )).toBeVisible();
    }
    await chatDialog.getByRole("button", { name: "Retry" }).last().click();
    await expect(liveStatus).toHaveText(cases[1].message);
    await expect(chatDialog.locator(".chat-message__failure").getByText(
      cases[1].message,
      { exact: true },
    )).toBeVisible();

    const failures = await pool.query<{ content: string; failure_code: string | null }>(
      `select u.content, a.failure_code
       from chat_messages u
       join chat_messages a on a.user_id = u.user_id
         and a.node_id = u.node_id
         and a.client_message_id = u.client_message_id
         and a.role = 'assistant'
       where u.user_id = $1 and u.node_id = $2 and u.role = 'user'
       order by u.sequence`,
      [seeded.userId, nodeId],
    );
    expect(failures.rows).toEqual(cases.map(({ content, failureCode }) => ({
      content,
      failure_code: failureCode,
    })));
  } finally {
    await seeded.cleanup();
  }
});

test("contains long external reference hosts without horizontal overflow", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();
  const hostname = `${"a".repeat(63)}.example.test`;

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Long reference host')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    const chatDialog = page.getByRole("dialog", { name: "Chat about Long reference host" });
    await chatDialog.getByRole("checkbox", { name: "Use external sources" }).check();
    await chatDialog.getByRole("textbox", { name: "Message" })
      .fill("Research and propose a synthesis for a synthetic long hostname");
    await chatDialog.getByRole("button", { name: "Send message" }).click();

    const proposal = chatDialog.getByRole("region", { name: "Proposed synthesis" });
    await expect(proposal).toBeVisible();
    const references = proposal.getByRole("region", { name: "External references" });
    await expect(references.getByText(hostname, { exact: true })).toBeVisible();
    await expect(references.evaluate((element) => ({
      referenceOverflow: element.scrollWidth - element.clientWidth,
      viewportOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))).resolves.toEqual({ referenceOverflow: 0, viewportOverflow: 0 });
  } finally {
    await seeded.cleanup();
  }
});

test("recovers acknowledged web research after the downstream stream disconnects", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Interrupted web research')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = input instanceof Request ? input : null;
        const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : request?.url ?? "";
        const response = await originalFetch(input, init);
        let alreadyDisconnected = false;
        try {
          alreadyDisconnected = sessionStorage.getItem("synthetic-chat-disconnected") === "1";
        } catch {
          // Initial document setup may not have an origin yet.
        }
        if (
          method !== "POST" ||
          !url.includes("/api/chat") ||
          !response.body ||
          alreadyDisconnected
        ) {
          return response;
        }
        sessionStorage.setItem("synthetic-chat-disconnected", "1");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let disconnectOnNextPull = false;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (disconnectOnNextPull) {
              await reader.cancel();
              controller.error(new TypeError("Synthetic downstream disconnect"));
              return;
            }
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            if (decoder.decode(value, { stream: true }).includes('"type":"research-status"')) {
              disconnectOnNextPull = true;
            }
            controller.enqueue(value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return new Response(body, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      };
    });
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    const failure = "External research was interrupted. Try again.";
    const liveStatus = page.locator(".chat-panel > .sr-only[role='status']");
    await page.getByRole("checkbox", { name: "Use external sources" }).check();
    await page.getByRole("textbox", { name: "Message" })
      .fill("Research a synthetic topic");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".chat-message__failure").getByText(
      failure,
      { exact: true },
    )).toBeVisible();
    await expect(liveStatus).toHaveText(failure);

    await expect.poll(async () => {
      const result = await pool.query<{ failure_code: string | null; id: string; status: string }>(
        `select id, status, failure_code from chat_messages
         where user_id = $1 and node_id = $2 and role = 'assistant'`,
        [seeded.userId, nodeId],
      );
      return result.rows[0] ?? null;
    }).toMatchObject({ status: "failed", failure_code: "stream-disconnected" });
    const assistantBeforeRetry = await pool.query<{ id: string }>(
      `select id from chat_messages
       where user_id = $1 and node_id = $2 and role = 'assistant'`,
      [seeded.userId, nodeId],
    );

    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator(".chat-message__failure").getByText(
      failure,
      { exact: true },
    )).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(liveStatus).toHaveText("Assistant response completed.");
    const assistantAfterRetry = await pool.query<{ id: string; status: string }>(
      `select id, status from chat_messages
       where user_id = $1 and node_id = $2 and role = 'assistant'`,
      [seeded.userId, nodeId],
    );
    expect(assistantAfterRetry.rows).toEqual([{
      id: assistantBeforeRetry.rows[0]?.id,
      status: "completed",
    }]);
  } finally {
    await seeded.cleanup();
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
    await chatDialog.getByRole("checkbox", { name: "Use external sources" }).check();
    await chatDialog.getByRole("textbox", { name: "Message" })
      .fill("Research and propose a synthesis");
    const sendButton = chatDialog.getByRole("button", { name: "Send message" });
    await expectIconCentered(sendButton);
    await sendButton.click();

    const proposal = chatDialog.getByRole("region", { name: "Proposed synthesis" });
    await expect(proposal).toBeVisible({ timeout: 10_000 });
    const inlineCitation = proposal.getByRole("link", {
      name: "Source 1: Synthetic research source. Opens in a new tab.",
    });
    await expect(inlineCitation).toHaveText("[1]");
    await expect(inlineCitation).toHaveAttribute("href", "https://example.test/research");
    const proposalReferences = proposal.getByRole("region", { name: "External references" });
    await expect(proposalReferences.getByRole("heading", { name: "References" })).toBeVisible();
    const firstReference = proposalReferences.locator("li").first();
    await expect(firstReference).toHaveJSProperty("value", 1);
    await expect(firstReference.evaluate((element) => getComputedStyle(element).listStyleType))
      .resolves.toBe("decimal");
    await expect(proposalReferences.getByRole("link", { name: "Synthetic research source" }))
      .toHaveAttribute("href", "https://example.test/research");
    await expect(proposalReferences.getByText("External source · may change", { exact: true }))
      .toHaveCount(0);

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

test("publishes a cited PDF-backed proposal with durable References", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const nodeId = randomUUID();
  const pdfUrl =
    "https://bpb-us-e2.wpmucdn.com/websites.umass.edu/dist/a/27637/files/2016/03/rosenblatt-1957.pdf";

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'PDF-backed synthesis')`,
      [nodeId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${nodeId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    const chatDialog = page.getByRole("dialog", { name: "Chat about PDF-backed synthesis" });
    await chatDialog.getByRole("checkbox", { name: "Use external sources" }).check();
    await chatDialog.getByRole("textbox", { name: "Message" }).fill(
      `Propose a short synthesis grounded in ${pdfUrl}`,
    );
    await chatDialog.getByRole("button", { name: "Send message" }).click();

    const proposal = chatDialog.getByRole("region", { name: "Proposed synthesis" });
    await expect(proposal).toBeVisible({ timeout: 10_000 });
    await expect(proposal.getByRole("link", {
      name: "Source 1: rosenblatt-1957.pdf. Opens in a new tab.",
    })).toHaveAttribute("href", pdfUrl);
    await expect(proposal.getByRole("region", { name: "External references" })
      .getByRole("link", { name: "rosenblatt-1957.pdf" }))
      .toHaveAttribute("href", pdfUrl);

    await proposal.getByRole("button", { name: "Approve and publish" }).click();
    await expect(chatDialog).not.toBeVisible();
    const published = page.getByRole("region", { name: "Summary" });
    await expect(published.getByRole("link", {
      name: "Source 1: rosenblatt-1957.pdf. Opens in a new tab.",
    })).toHaveAttribute("href", pdfUrl);
    const references = page.getByRole("region", { name: "External references" });
    await expect(references.getByRole("link", { name: "rosenblatt-1957.pdf" }))
      .toHaveAttribute("href", pdfUrl);
    await expect(references.evaluate((element) => {
      const outline = document.querySelector(".branch-outline");
      return Boolean(
        outline &&
        (element.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
    })).resolves.toBe(true);

    await page.reload();
    await expect(page.getByRole("region", { name: "External references" })
      .getByRole("link", { name: "rosenblatt-1957.pdf" }))
      .toHaveAttribute("href", pdfUrl);
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
    const webToggle = page.getByRole("checkbox", { name: "Use external sources" });
    await expect(webToggle).toBeFocused();
    await expect(webToggle).toHaveAccessibleDescription(
      "Next message only. Supports web research or one HTTPS PDF; sources may change.",
    );
    await page.keyboard.press("Tab");
    const send = page.getByRole("button", { name: "Send message" });
    await expect(send).toBeFocused();
    await expectTouchTarget(send);
    await send.click();
    await expect(page.getByText("Thinking…").last()).toBeVisible();
    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(chatDialog).not.toBeVisible();
    await expect(chatButton).toBeFocused();
    await chatButton.click();
    await expect(page.getByText("Thinking…").last()).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop response", exact: true });
    await expectTouchTarget(stop);
    await stop.click();
    await expect(page.getByText("Response stopped.").last()).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByText("Response stopped.").last()).toBeVisible();

    await page.getByRole("textbox", { name: "Message" }).fill("A fresh angle");
    await page.getByRole("button", { name: "Send message" }).click();
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
