import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  installBrowserSessionCookie,
  seedBrowserSession,
} from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for browser tests.");
}

const pool = new Pool({ connectionString });

const activeTitles = [
  "Root canvas",
  "Layer one",
  "Layer two",
  "Layer three",
  "Layer four",
  "Layer five",
  "Layer six",
  "Layer seven",
] as const;

type ViewTransform = {
  x: number;
  y: number;
  scale: number;
};

function constellationNode(page: Page, title: string) {
  return page.getByRole("button", {
    name: new RegExp(`${title}: Active;`),
  });
}

async function readViewTransform(canvas: Locator): Promise<ViewTransform> {
  const value = await canvas.locator(":scope > g").getAttribute("transform");
  const match = value?.match(
    /translate\(([-+0-9.eE]+) ([-+0-9.eE]+)\) scale\(([-+0-9.eE]+)\)/,
  );
  if (!match) {
    throw new Error(`Unexpected constellation transform: ${value ?? "missing"}`);
  }
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    scale: Number(match[3]),
  };
}

async function centerOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected a measurable constellation element.");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dispatchPointer(
  target: Locator,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  point: { x: number; y: number },
  pointerType: "mouse" | "touch" = "touch",
) {
  await target.evaluate(
    (element, event) => {
      element.dispatchEvent(new PointerEvent(event.type, {
        bubbles: true,
        cancelable: true,
        clientX: event.x,
        clientY: event.y,
        isPrimary: event.pointerId === 1,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
      }));
    },
    { type, pointerId, pointerType, ...point },
  );
}

test("explores a responsive thought constellation as a design canvas", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);
  const activeIds = activeTitles.map(() => randomUUID());
  const archivedId = randomUUID();

  try {
    for (let index = 0; index < activeIds.length; index += 1) {
      await pool.query(
        `insert into nodes (id, user_id, parent_id, position, title)
         values ($1, $2, $3, $4, $5)`,
        [
          activeIds[index],
          seeded.userId,
          index === 0 ? null : activeIds[index - 1],
          0,
          activeTitles[index],
        ],
      );
    }
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title, archived_at)
       values ($1, $2, $3, 1, 'Archived orbit', now())`,
      [archivedId, seeded.userId, activeIds[0]],
    );

    await page.emulateMedia({ reducedMotion: "reduce" });
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto("/");

    const constellationToggle = page.getByRole("button", { name: "Node constellation" });
    await expect(constellationToggle).toHaveAttribute("aria-pressed", "false");
    await constellationToggle.click();
    await expect(constellationToggle).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("region", { name: "Thought Constellation" }),
    ).toBeVisible();
    const constellationHeading = page.getByRole("heading", {
      level: 1,
      name: "Thought Constellation",
    });
    const viewport = page.viewportSize();
    const hidesHeader = Boolean(
      viewport && viewport.width <= 760 && viewport.height <= 576,
    );
    if (hidesHeader) {
      await expect(page.locator(".constellation__header")).toHaveCSS(
        "clip-path",
        "inset(50%)",
      );
      await expect(constellationHeading).toBeAttached();
    } else {
      await expect(constellationHeading).toBeVisible();
    }
    await expect(page.getByText("Pull a thought and watch its branches respond.")).toHaveCount(0);

    const canvas = page.getByRole("group", { name: "8 thought node constellation" });
    await expect(canvas).toBeVisible();
    const nodes = activeTitles.map((title) => constellationNode(page, title));
    await expect(page.locator(".constellation-node")).toHaveCount(activeTitles.length);

    const radii = await Promise.all(nodes.map(async (node) =>
      Number(await node.locator(".constellation-node__bubble").getAttribute("r"))
    ));
    expect(radii).toEqual([40, 30, 23, 17, 13, 9, 7, 6]);

    const deepestBubble = nodes.at(-1)!.locator(".constellation-node__bubble");
    const deepestLabel = nodes.at(-1)!.locator(".constellation-node__title");
    const deepestTarget = nodes.at(-1)!.locator(".constellation-node__hit-target");
    await expect(deepestLabel).toHaveText("Layer sev…");
    await expect(deepestLabel).toHaveCSS("font-size", "1.08px");
    await expect(deepestBubble).toHaveCSS("stroke-width", "0.24px");
    const initialBubbleBox = await deepestBubble.boundingBox();
    const initialTargetBox = await deepestTarget.boundingBox();
    if (!initialBubbleBox || !initialTargetBox) {
      throw new Error("Deep constellation geometry must be measurable.");
    }
    expect(initialTargetBox.width).toBeCloseTo(44, 0);

    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) {
      throw new Error("Constellation canvas must be measurable.");
    }
    const wheelAnchor = {
      x: canvasBox.width * 0.64,
      y: canvasBox.height * 0.36,
    };
    await page.mouse.move(canvasBox.x + wheelAnchor.x, canvasBox.y + wheelAnchor.y);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => (await readViewTransform(canvas)).scale).toBeGreaterThan(1.05);
    const zoomed = await readViewTransform(canvas);
    expect(zoomed.scale).toBeLessThan(1.4);
    expect(zoomed.x).toBeCloseTo(wheelAnchor.x * (1 - zoomed.scale), 0);
    expect(zoomed.y).toBeCloseTo(wheelAnchor.y * (1 - zoomed.scale), 0);
    await expect(deepestLabel).toHaveCSS("font-size", "1.08px");
    await expect(deepestBubble).toHaveCSS("stroke-width", "0.24px");
    const zoomedBubbleBox = await deepestBubble.boundingBox();
    const zoomedTargetBox = await deepestTarget.boundingBox();
    if (!zoomedBubbleBox || !zoomedTargetBox) {
      throw new Error("Zoomed constellation geometry must be measurable.");
    }
    expect(zoomedBubbleBox.width / initialBubbleBox.width).toBeCloseTo(zoomed.scale, 1);
    expect(zoomedTargetBox.width).toBeCloseTo(44, 0);

    await page.getByRole("button", { name: "Reset constellation" }).click();
    await expect.poll(async () => readViewTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });

    const zoomOut = page.getByRole("button", { name: "Zoom out" });
    for (let step = 0; step < 20 && await zoomOut.isEnabled(); step += 1) {
      await zoomOut.click();
    }
    await expect(zoomOut).toBeDisabled();
    expect((await readViewTransform(canvas)).scale).toBeCloseTo(0.15, 5);
    await expect(deepestTarget).toHaveCSS("pointer-events", "none");

    await nodes.at(-1)!.focus();
    const focusRing = nodes.at(-1)!.locator(".constellation-node__focus-ring");
    await expect(focusRing).toHaveCSS("opacity", "0.72");
    await expect(focusRing).toHaveCSS("stroke-width", "2px");
    const focusRingBox = await focusRing.boundingBox();
    if (!focusRingBox) {
      throw new Error("Focused constellation locator must be measurable.");
    }
    expect(focusRingBox.width).toBeCloseTo(26, 0);

    const layerOneBubble = nodes[1].locator(".constellation-node__bubble");
    const layerOneCenter = await centerOf(layerOneBubble);
    await page.mouse.click(layerOneCenter.x + 6, layerOneCenter.y);
    await expect(
      page.getByRole("complementary", { name: "Layer one constellation details" }),
    ).toBeVisible();

    await nodes[0].focus();
    await expect(
      page.getByRole("complementary", { name: "Root canvas constellation details" }),
    ).toBeVisible();
    const rootCenter = await centerOf(nodes[0].locator(".constellation-node__bubble"));
    const pinchLayerCenter = await centerOf(layerOneBubble);
    const beforePinch = await readViewTransform(canvas);
    await dispatchPointer(canvas, "pointerdown", 1, rootCenter);
    await dispatchPointer(canvas, "pointerdown", 2, pinchLayerCenter);
    await dispatchPointer(canvas, "pointermove", 2, {
      x: pinchLayerCenter.x + 90,
      y: pinchLayerCenter.y + 45,
    });
    await dispatchPointer(canvas, "pointerup", 2, {
      x: pinchLayerCenter.x + 90,
      y: pinchLayerCenter.y + 45,
    });
    await dispatchPointer(canvas, "pointerup", 1, rootCenter);
    await expect.poll(async () => (await readViewTransform(canvas)).scale).not.toBe(
      beforePinch.scale,
    );
    await expect(
      page.getByRole("complementary", { name: "Root canvas constellation details" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Reset constellation" }).click();
    const beforeDrag = await nodes.at(-1)!.getAttribute("transform");
    const deepCenter = await centerOf(deepestBubble);
    await dispatchPointer(nodes.at(-1)!, "pointerdown", 11, deepCenter, "mouse");
    await dispatchPointer(
      canvas,
      "pointermove",
      11,
      { x: deepCenter.x + 36, y: deepCenter.y + 20 },
      "mouse",
    );
    await dispatchPointer(
      canvas,
      "pointerup",
      11,
      { x: deepCenter.x + 36, y: deepCenter.y + 20 },
      "mouse",
    );
    await expect.poll(() => nodes.at(-1)!.getAttribute("transform")).not.toBe(beforeDrag);

    const beforePan = await readViewTransform(canvas);
    await page.mouse.move(canvasBox.x + 24, canvasBox.y + canvasBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 64, canvasBox.y + canvasBox.height / 2 + 18);
    await page.mouse.up();
    const afterPan = await readViewTransform(canvas);
    expect(afterPan.x).toBeCloseTo(beforePan.x + 40, 0);
    expect(afterPan.y).toBeCloseTo(beforePan.y + 18, 0);
    await page.getByRole("button", { name: "Reset constellation" }).click();
    await expect.poll(async () => readViewTransform(canvas)).toEqual({ x: 0, y: 0, scale: 1 });

    const showArchived = page.getByRole("button", { name: "Show archived" });
    await showArchived.click();
    await expect(page.getByRole("group", { name: "9 thought node constellation" })).toBeVisible();
    const constellationLegend = page.getByLabel("Constellation legend");
    await expect(constellationLegend).toContainText("Archived");
    if (!hidesHeader) {
      await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    }
    await expect(page.locator(".constellation-node--archived")).toHaveCount(1);
    await showArchived.click();
    await expect(page.getByRole("group", { name: "8 thought node constellation" })).toBeVisible();

    await nodes[0].focus();
    await nodes[0].press("ArrowDown");
    await expect(nodes[1]).toBeFocused();
    await expect(nodes[1]).toHaveAttribute("aria-pressed", "true");
    await nodes[1].press("Enter");
    const openInTree = page.getByRole("button", { name: "Open in tree" });
    await expect(openInTree).toBeFocused();
    await openInTree.click();
    await expect(page).toHaveURL(new RegExp(`\\?node=${activeIds[1]}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Layer one" })).toBeVisible();
  } finally {
    await seeded.cleanup();
  }
});

test.afterAll(async () => {
  await pool.end();
});
