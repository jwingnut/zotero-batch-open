import { describe, it, expect, vi } from "vitest";
import { registerWindowFluent } from "@/utils/locale";

function fakeAddon(ref = "batch-open") {
  (globalThis as unknown as { addon: unknown }).addon = {
    data: { config: { addonRef: ref } },
  };
}

describe("registerWindowFluent", () => {
  it("inserts each FTL stem via MozXULElement.insertFTLIfNeeded", () => {
    fakeAddon();
    const insertFTLIfNeeded = vi.fn();
    const win = {
      MozXULElement: { insertFTLIfNeeded },
    } as unknown as Window;

    registerWindowFluent(win);

    expect(insertFTLIfNeeded).toHaveBeenCalledWith("batch-open-mainWindow.ftl");
    expect(insertFTLIfNeeded).toHaveBeenCalledWith("batch-open-addon.ftl");
    expect(insertFTLIfNeeded).toHaveBeenCalledWith(
      "batch-open-preferences.ftl",
    );
    expect(insertFTLIfNeeded).toHaveBeenCalledTimes(3);
  });

  it("does nothing when MozXULElement.insertFTLIfNeeded is unavailable", () => {
    fakeAddon();
    const win = {} as unknown as Window;

    expect(() => registerWindowFluent(win)).not.toThrow();
  });

  it("does not propagate an error thrown by insertFTLIfNeeded", () => {
    fakeAddon();
    const win = {
      MozXULElement: {
        insertFTLIfNeeded: () => {
          throw new Error("bundle missing");
        },
      },
    } as unknown as Window;

    expect(() => registerWindowFluent(win)).not.toThrow();
  });
});
