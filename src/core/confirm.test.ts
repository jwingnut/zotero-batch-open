import { describe, it, expect } from "vitest";
import { shouldConfirm, confirmPromptMessage } from "./confirm";

describe("shouldConfirm", () => {
  it("does not confirm at or below the threshold", () => {
    expect(shouldConfirm(25, 25)).toBe(false);
    expect(shouldConfirm(1, 25)).toBe(false);
  });

  it("confirms above the threshold", () => {
    expect(shouldConfirm(26, 25)).toBe(true);
    expect(shouldConfirm(118, 25)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(shouldConfirm(5, 4)).toBe(true);
    expect(shouldConfirm(4, 4)).toBe(false);
  });
});

describe("confirmPromptMessage", () => {
  it("names the exact count and the action", () => {
    expect(confirmPromptMessage(118)).toBe("Open 118 tabs in your browser?");
  });
});
