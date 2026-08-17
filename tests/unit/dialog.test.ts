import type { MouseEvent } from "react";

import { describe, expect, it } from "vitest";

import { isDialogBackdropClick } from "@/lib/ui/dialog";

function dialogClick({
  clientX,
  clientY,
  child = false,
}: {
  clientX: number;
  clientY: number;
  child?: boolean;
}) {
  const dialog = {
    getBoundingClientRect: () => ({
      bottom: 300,
      left: 100,
      right: 500,
      top: 50,
    }),
  };
  return {
    clientX,
    clientY,
    currentTarget: dialog,
    target: child ? {} : dialog,
  } as unknown as MouseEvent<HTMLDialogElement>;
}

describe("dialog backdrop clicks", () => {
  it("recognizes only clicks outside the dialog surface", () => {
    expect(isDialogBackdropClick(dialogClick({ clientX: 50, clientY: 100 }))).toBe(true);
    expect(isDialogBackdropClick(dialogClick({ clientX: 250, clientY: 20 }))).toBe(true);
    expect(isDialogBackdropClick(dialogClick({ clientX: 250, clientY: 100 }))).toBe(false);
    expect(isDialogBackdropClick(dialogClick({
      clientX: 50,
      clientY: 100,
      child: true,
    }))).toBe(false);
  });
});
