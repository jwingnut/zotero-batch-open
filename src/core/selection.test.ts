import { describe, it, expect } from "vitest";
import { splitSelection } from "./selection";

function regular() {
  return { isRegularItem: () => true };
}
function nonRegular() {
  return { isRegularItem: () => false };
}

describe("splitSelection", () => {
  it("keeps only regular items and counts the rest", () => {
    const items = [
      regular(),
      nonRegular(),
      regular(),
      nonRegular(),
      nonRegular(),
    ];
    const { regularItems, skippedCount } = splitSelection(items);
    expect(regularItems).toHaveLength(2);
    expect(skippedCount).toBe(3);
  });

  it("handles an all-regular selection", () => {
    const items = [regular(), regular()];
    const result = splitSelection(items);
    expect(result.regularItems).toHaveLength(2);
    expect(result.skippedCount).toBe(0);
  });

  it("handles an empty selection", () => {
    const result = splitSelection([]);
    expect(result.regularItems).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
  });

  it("counts notes, attachments, and annotations (all non-regular) as skipped", () => {
    const note = nonRegular();
    const attachment = nonRegular();
    const annotation = nonRegular();
    const result = splitSelection([note, attachment, annotation]);
    expect(result.regularItems).toHaveLength(0);
    expect(result.skippedCount).toBe(3);
  });
});
