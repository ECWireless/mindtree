import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  installBrowserSessionCookie,
  seedBrowserSession,
} from "./support/auth";
import { browserAllowedEmail } from "../config/browser-auth.mjs";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for browser tests.");
}

const pool = new Pool({ connectionString });

test.use({ screenshot: "off", trace: "off", video: "off" });

function expectPayloadToExclude(payload: string, privateValues: readonly string[]) {
  expect(privateValues.every((value) => !payload.includes(value))).toBe(true);
}

async function navigateToPublicTrail(page: Page, url: string) {
  try {
    const response = await page.goto(url);
    if (!response) throw new Error("missing-response");
    return response;
  } catch {
    throw new Error("The synthetic public thought trail navigation failed.");
  }
}

async function reloadPublicTrail(page: Page) {
  try {
    const response = await page.reload();
    if (!response) throw new Error("missing-response");
    return response;
  } catch {
    throw new Error("The synthetic public thought trail reload failed.");
  }
}

async function insertApprovedSummary(input: {
  userId: string;
  nodeId: string;
  content: string;
  citations?: Array<
    | {
        kind: "internal";
        ordinal: number;
        startUtf16: number;
        endUtf16: number;
        targetNodeId: string;
        targetTitle: string;
        targetParentId: string | null;
        targetSynthesisVersionId: string;
      }
    | {
        kind: "external";
        ordinal: number;
        startUtf16: number;
        title: string;
        url: string;
      }
  >;
}) {
  const messageId = randomUUID();
  const summaryId = randomUUID();
  await pool.query(
    `insert into chat_messages
       (id, user_id, node_id, client_message_id, sequence, role, status,
        content, model, context_fingerprint, completed_at)
     values ($1, $2, $3, $4, 0, 'assistant', 'completed',
       'Synthetic public Summary', 'gpt-5.6-sol', $5, now())`,
    [messageId, input.userId, input.nodeId, randomUUID(), "a".repeat(64)],
  );
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, status, content, model, reasoning_mode,
        reasoning_effort, input_fingerprint, generating_message_id)
     values ($1, $2, $3, 'pending', $4, 'gpt-5.6-sol', 'pro', 'high', $5, $6)`,
    [
      summaryId,
      input.userId,
      input.nodeId,
      input.content,
      "b".repeat(64),
      messageId,
    ],
  );
  for (const citation of input.citations ?? []) {
    if (citation.kind === "internal") {
      await pool.query(
        `insert into citations
           (user_id, owner_node_id, synthesis_version_id, kind, ordinal,
            start_utf16, end_utf16, live_target_node_id,
            live_target_synthesis_version_id, target_node_id_snapshot,
            target_title_snapshot, target_parent_id_snapshot,
            target_synthesis_version_id_snapshot)
         values ($1, $2, $3, 'internal', $4, $5, $6, $7, $8, $7, $9, $10, $8)`,
        [
          input.userId,
          input.nodeId,
          summaryId,
          citation.ordinal,
          citation.startUtf16,
          citation.endUtf16,
          citation.targetNodeId,
          citation.targetSynthesisVersionId,
          citation.targetTitle,
          citation.targetParentId,
        ],
      );
    } else {
      await pool.query(
        `insert into citations
           (user_id, owner_node_id, synthesis_version_id, kind, ordinal,
            start_utf16, end_utf16, external_url, external_title)
         values ($1, $2, $3, 'external', $4, $5, $5, $6, $7)`,
        [
          input.userId,
          input.nodeId,
          summaryId,
          citation.ordinal,
          citation.startUtf16,
          citation.url,
          citation.title,
        ],
      );
    }
  }
  await pool.query(
    `update synthesis_versions
     set status = 'approved', decided_at = now(), updated_at = now()
     where id = $1`,
    [summaryId],
  );
  await pool.query(
    `update nodes set published_synthesis_version_id = $1 where id = $2`,
    [summaryId, input.nodeId],
  );
  return summaryId;
}

async function insertBranchOutline(input: {
  userId: string;
  nodeId: string;
  baseSynthesisVersionId: string | null;
  content: string;
}) {
  const outlineId = randomUUID();
  await pool.query(
    `insert into branch_outline_versions
       (id, user_id, node_id, client_request_id, base_synthesis_version_id,
        status, content, model, reasoning_mode, reasoning_effort,
        input_fingerprint, completed_at)
     values ($1, $2, $3, $4, $5, 'completed', $6, 'gpt-5.6-sol',
       'pro', 'high', $7, now())`,
    [
      outlineId,
      input.userId,
      input.nodeId,
      randomUUID(),
      input.baseSynthesisVersionId,
      input.content,
      "c".repeat(64),
    ],
  );
  await pool.query(
    `update nodes set current_branch_outline_version_id = $1 where id = $2`,
    [outlineId, input.nodeId],
  );
}

test("creates, recovers, dynamically scopes, and revokes a public thought trail", async ({
  browser,
  page,
}, testInfo) => {
  const seeded = await seedBrowserSession(pool);
  const privateAncestorId = randomUUID();
  const sharedRootId = randomUUID();
  const privateSiblingId = randomUUID();
  const sharedChildId = randomUUID();
  const archivedChildId = randomUUID();
  const outsideLeafId = randomUUID();
  const privateSummaryText = "OWNER-ONLY-SUMMARY-CONTENT";
  const privateChatText = `OWNER-ONLY-CHAT-${randomUUID()}`;
  const privateCurrentTitle = `Private current title ${randomUUID()}`;
  const rootSummary =
    "Shared child supports this trail. Private sibling remains private. External evidence.";
  const ownerContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    deviceScaleFactor: testInfo.project.use.deviceScaleFactor,
    hasTouch: testInfo.project.use.hasTouch,
    isMobile: testInfo.project.use.isMobile,
    userAgent: testInfo.project.use.userAgent,
    viewport: testInfo.project.use.viewport,
  });
  const ownerPage = await ownerContext.newPage();
  const publicPage = page;
  const forbiddenPublicRequests: string[] = [];

  publicPage.on("request", (request) => {
    const url = new URL(request.url());
    const isApiRequest = url.pathname.startsWith("/api/");
    const isMutation = !["GET", "HEAD"].includes(request.method());
    if (isApiRequest || isMutation) {
      const safePath = url.pathname.replace(/\/share\/[^/]+/u, "/share/[secret]");
      forbiddenPublicRequests.push(`${request.method()} ${safePath}`);
    }
  });

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title, archived_at)
       values
         ($1, $7, null, 0, 'Private ancestor', null),
         ($2, $7, $1, 0, 'Shared research', null),
         ($3, $7, $1, 1, 'Private sibling', null),
         ($4, $7, $2, 0, 'Shared child', null),
         ($5, $7, $2, 1, 'Archived child', now()),
         ($6, $7, $3, 0, 'Outside leaf', null)`,
      [
        privateAncestorId,
        sharedRootId,
        privateSiblingId,
        sharedChildId,
        archivedChildId,
        outsideLeafId,
        seeded.userId,
      ],
    );

    const childSummaryId = await insertApprovedSummary({
      userId: seeded.userId,
      nodeId: sharedChildId,
      content: "Child-only published summary.",
    });
    const privateSummaryId = await insertApprovedSummary({
      userId: seeded.userId,
      nodeId: privateSiblingId,
      content: privateSummaryText,
    });
    const rootSummaryId = await insertApprovedSummary({
      userId: seeded.userId,
      nodeId: sharedRootId,
      content: rootSummary,
      citations: [
        {
          kind: "internal",
          ordinal: 1,
          startUtf16: rootSummary.indexOf("Shared child"),
          endUtf16: rootSummary.indexOf("Shared child") + "Shared child".length,
          targetNodeId: sharedChildId,
          targetTitle: "Shared child",
          targetParentId: sharedRootId,
          targetSynthesisVersionId: childSummaryId,
        },
        {
          kind: "internal",
          ordinal: 2,
          startUtf16: rootSummary.indexOf("Private sibling"),
          endUtf16: rootSummary.indexOf("Private sibling") + "Private sibling".length,
          targetNodeId: privateSiblingId,
          targetTitle: "Private sibling",
          targetParentId: privateAncestorId,
          targetSynthesisVersionId: privateSummaryId,
        },
        {
          kind: "external",
          ordinal: 1,
          startUtf16: rootSummary.indexOf("External evidence"),
          title: "Synthetic public source",
          url: "https://example.test/public-source",
        },
      ],
    });
    await pool.query(`update nodes set title = $1 where id = $2`, [
      privateCurrentTitle,
      privateSiblingId,
    ]);
    await insertBranchOutline({
      userId: seeded.userId,
      nodeId: sharedRootId,
      baseSynthesisVersionId: rootSummaryId,
      content: "- **Shared child:** Current relationship",
    });
    await pool.query(
      `insert into chat_messages
         (user_id, node_id, client_message_id, sequence, role, status,
          content, completed_at)
       values ($1, $2, $3, 100, 'user', 'completed', $4, now())`,
      [seeded.userId, sharedRootId, randomUUID(), privateChatText],
    );

    await installBrowserSessionCookie(ownerContext, seeded.cookie);
    await ownerPage.goto(`/?node=${sharedRootId}`);
    await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(ownerPage.url()).origin,
    });
    const shareTrigger = ownerPage.getByRole("button", { name: "Share thought trail" });
    await shareTrigger.click();
    const shareDialog = ownerPage.getByRole("dialog", { name: "Share this thought trail" });
    await expect(shareDialog).toBeVisible();
    await expect(
      shareDialog.getByRole("button", { name: "Close sharing dialog" }),
    ).toBeFocused();
    await ownerPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();
    await expect(shareTrigger).toBeFocused();

    await shareTrigger.click();
    await shareDialog.getByRole("button", { name: "Create and copy link" }).click();
    const shareInput = shareDialog.getByLabel("Share link");
    await expect(shareInput).toBeVisible();
    const shareStatus = shareDialog.getByRole("status");
    await expect(shareStatus).toHaveText("Share link copied.");
    const shareUrl = await shareInput.inputValue();
    const clipboardMatches = await ownerPage.evaluate((expected) =>
      navigator.clipboard.readText().then((value) => value === expected), shareUrl
    );
    await ownerPage.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => {
          throw new DOMException("Synthetic clipboard denial", "NotAllowedError");
        },
      });
    });
    await shareDialog.getByRole("button", { name: "Copy link" }).click();
    await expect(shareStatus).toHaveText(
      "Copy was unavailable. Select and copy the link below.",
    );
    await ownerPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();
    await expect(shareTrigger).toBeFocused();
    expect(
      new RegExp(`/share/[A-Za-z0-9_-]{43}\\?node=${sharedRootId}$`).test(shareUrl),
    ).toBe(true);
    expect(clipboardMatches).toBe(true);

    const shareRecord = await pool.query<{ id: string; secret_digest: string }>(
      `select id, secret_digest from branch_share_links
       where user_id = $1 and root_node_id = $2`,
      [seeded.userId, sharedRootId],
    );
    const shareRecordRow = shareRecord.rows[0];
    if (!shareRecordRow) throw new Error("The synthetic share record was not created.");

    await ownerPage.reload();
    await shareTrigger.click();
    await expect(shareInput).toBeVisible();
    const recoveredLinkMatches = await shareInput.inputValue().then((value) => value === shareUrl);
    await expect(shareDialog.getByRole("button", { name: "Revoke link" })).toBeVisible();
    await ownerPage.keyboard.press("Escape");
    expect(recoveredLinkMatches).toBe(true);

    const response = await navigateToPublicTrail(publicPage, shareUrl);
    const initialPayload = await response.text();
    expect(response.headers()).toMatchObject({
      // The production no-store policy is asserted in public-share-config.test.ts;
      // Next.js replaces that cache header while running its development server.
      "cache-control": "no-cache, must-revalidate",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    });
    expectPayloadToExclude(initialPayload, [
      privateAncestorId,
      privateSiblingId,
      archivedChildId,
      outsideLeafId,
      privateSummaryId,
      privateSummaryText,
      privateChatText,
      privateCurrentTitle,
      seeded.userId,
      "Synthetic Browser User",
      browserAllowedEmail,
      shareRecordRow.id,
      shareRecordRow.secret_digest,
    ]);
    expect(
      initialPayload.includes(sharedRootId) && initialPayload.includes(sharedChildId),
    ).toBe(true);
    await expect(publicPage.getByTestId("public-thought-trail")).toBeVisible();
    await expect(publicPage.locator(".public-trail-tree__link")).toHaveCount(2);
    await expect(
      publicPage.getByRole("heading", { level: 2, name: "Shared research" }).last(),
    ).toBeVisible();
    await expect(publicPage.getByText("Private ancestor")).toHaveCount(0);
    await expect(publicPage.getByRole("link", { name: /Private sibling/u })).toHaveCount(0);
    await expect(publicPage.getByText(privateCurrentTitle)).toHaveCount(0);
    await expect(publicPage.getByText("Archived child")).toHaveCount(0);
    await expect(publicPage.getByText("Outside leaf")).toHaveCount(0);
    await expect(publicPage.getByText(privateSummaryText)).toHaveCount(0);
    await expect(publicPage.getByText("Synthetic Browser User")).toHaveCount(0);
    await expect(publicPage.getByText("Chat", { exact: true })).toHaveCount(0);
    await expect(publicPage.getByRole("button", { name: /Add child|Archive|Move To|Share|Delete/u }))
      .toHaveCount(0);

    const publicSummary = publicPage.locator(".public-trail-summary");
    const sharedChildCitation = publicSummary.getByRole("link", { name: "Shared child" });
    await expect(sharedChildCitation).toHaveAttribute("href", `?node=${sharedChildId}`);
    await expect(publicSummary.getByText("Private sibling", { exact: false })).toBeVisible();
    await expect(publicSummary.getByRole("link", { name: "Private sibling" })).toHaveCount(0);
    const references = publicPage.getByRole("region", { name: "External references" });
    const referenceLink = references.getByRole("link", {
        name: "Source 1: Synthetic public source. Opens in a new tab.",
      });
    await expect(referenceLink).toHaveAttribute("href", "https://example.test/public-source");
    await expect(referenceLink).toHaveAttribute("target", "_blank");
    await expect(referenceLink).toHaveAttribute("rel", "noreferrer noopener");
    await expect(references.getByRole("heading", { level: 3, name: "References" })).toBeVisible();
    await expect(publicPage.getByRole("heading", { level: 3, name: "Branch Outline" }))
      .toBeVisible();
    await expect(publicPage.getByText("Current relationship")).toBeVisible();

    await sharedChildCitation.click();
    await expect.poll(() => publicPage.evaluate(() => window.location.search))
      .toBe(`?node=${sharedChildId}`);
    await expect(
      publicPage.getByRole("heading", { level: 2, name: "Shared child" }).last(),
    ).toBeVisible();
    await expect(publicPage.getByText("Child-only published summary.")).toBeVisible();

    await pool.query(
      `update nodes set title = 'Renamed shared child' where id = $1`,
      [sharedChildId],
    );
    await pool.query(
      `update nodes set parent_id = $1, position = 2 where id = $2`,
      [sharedRootId, outsideLeafId],
    );
    const movedInResponse = await navigateToPublicTrail(publicPage, shareUrl);
    const movedInPayload = await movedInResponse.text();
    expectPayloadToExclude(movedInPayload, [
      privateAncestorId,
      privateSiblingId,
      archivedChildId,
      privateSummaryId,
      privateSummaryText,
      privateChatText,
      privateCurrentTitle,
      seeded.userId,
      "Synthetic Browser User",
      browserAllowedEmail,
    ]);
    expect(movedInPayload.includes(outsideLeafId)).toBe(true);
    await expect(publicPage.locator(".public-trail-tree__link")).toHaveCount(3);
    await expect(publicPage.getByRole("link", { name: /Renamed shared child/u })).toBeVisible();
    await expect(publicPage.getByRole("link", { name: /Outside leaf/u })).toBeVisible();
    await expect(publicPage.getByRole("link", { name: /Private sibling/u })).toHaveCount(0);
    await expect(publicPage.getByText("Archived child")).toHaveCount(0);

    await pool.query(
      `update nodes
       set parent_id = case when id = $1 then $2 else parent_id end,
           position = case
             when id = $1 then 0
             when id = $3 then 0
             when id = $4 then 1
             else position
           end
       where id = any($5::uuid[])`,
      [
        sharedChildId,
        privateSiblingId,
        archivedChildId,
        outsideLeafId,
        [sharedChildId, archivedChildId, outsideLeafId],
      ],
    );
    const movedOutResponse = await reloadPublicTrail(publicPage);
    const movedOutPayload = await movedOutResponse.text();
    expectPayloadToExclude(movedOutPayload, [
      privateAncestorId,
      privateSiblingId,
      archivedChildId,
      privateSummaryId,
      privateSummaryText,
      privateChatText,
      privateCurrentTitle,
      seeded.userId,
      "Synthetic Browser User",
      browserAllowedEmail,
      sharedChildId,
      childSummaryId,
      "Renamed shared child",
    ]);
    await expect(publicPage.locator(".public-trail-tree__link")).toHaveCount(2);
    await expect(publicPage.getByText("Renamed shared child")).toHaveCount(0);
    await expect(publicPage.locator(".public-trail-summary").getByText("Shared child"))
      .toBeVisible();
    await expect(
      publicPage.locator(".public-trail-summary").getByRole("link", { name: "Shared child" }),
    ).toHaveCount(0);

    await shareTrigger.click();
    await expect(shareInput).toBeVisible();
    const revokeLinkMatches = await shareInput.inputValue().then((value) => value === shareUrl);
    await shareDialog.getByRole("button", { name: "Revoke link" }).click();
    await expect(shareDialog.getByRole("status")).toHaveText("Share link revoked.");
    await expect(shareDialog.getByRole("button", { name: "Create and copy link" }))
      .toBeVisible();
    expect(revokeLinkMatches).toBe(true);

    const revokedUrl = new URL(shareUrl);
    revokedUrl.search = "";
    const revokedResponse = await navigateToPublicTrail(publicPage, revokedUrl.toString());
    const revokedPayload = await revokedResponse.text();
    expect(revokedResponse.status()).toBe(404);
    expect(revokedResponse.headers()).toMatchObject({
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    });
    expectPayloadToExclude(revokedPayload, [
      sharedRootId,
      "Shared research",
      sharedChildId,
      outsideLeafId,
      seeded.userId,
      "Synthetic Browser User",
      browserAllowedEmail,
      shareRecordRow.id,
      shareRecordRow.secret_digest,
      privateAncestorId,
      privateSiblingId,
      archivedChildId,
      privateSummaryId,
      privateSummaryText,
      privateChatText,
      privateCurrentTitle,
    ]);
    await expect(
      publicPage.getByRole("heading", { name: "This thought trail is unavailable." }),
    ).toBeVisible();
    await expect(publicPage.getByText("Shared research")).toHaveCount(0);
    expect(forbiddenPublicRequests).toEqual([]);
  } finally {
    try {
      await ownerContext.close();
    } finally {
      try {
        await pool.query(`delete from branch_share_links where user_id = $1`, [seeded.userId]);
      } finally {
        await seeded.cleanup();
      }
    }
  }
});

test.afterAll(async () => {
  await pool.end();
});
