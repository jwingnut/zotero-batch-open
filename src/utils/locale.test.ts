import { describe, it, expect, vi } from "vitest";
import { registerWindowFluent, getPreferredLocale } from "@/utils/locale";

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

describe("getPreferredLocale", () => {
  const testGlobal = globalThis as unknown as {
    Zotero: { locale?: string };
    Services: { locale?: { appLocaleAsBCP47?: string } };
  };

  it("prefers Zotero.locale when it is a non-empty string", () => {
    testGlobal.Zotero.locale = "en-AU";
    testGlobal.Services.locale = { appLocaleAsBCP47: "en-NZ" };

    expect(getPreferredLocale()).toBe("en-AU");

    delete testGlobal.Zotero.locale;
  });

  it("falls back to Services.locale.appLocaleAsBCP47 when Zotero.locale is absent", () => {
    delete testGlobal.Zotero.locale;
    testGlobal.Services.locale = { appLocaleAsBCP47: "en-CA" };

    expect(getPreferredLocale()).toBe("en-CA");
  });

  it("falls back to en-US when nothing else resolves", () => {
    delete testGlobal.Zotero.locale;
    testGlobal.Services.locale = undefined;

    expect(getPreferredLocale()).toBe("en-US");
  });

  it("ignores a non-string Zotero.locale (some Zotero versions expose an object)", () => {
    (testGlobal.Zotero as unknown as { locale?: unknown }).locale = {
      locale: "en-GB",
    };
    testGlobal.Services.locale = { appLocaleAsBCP47: "en-GB" };

    expect(getPreferredLocale()).toBe("en-GB");

    delete (testGlobal.Zotero as unknown as { locale?: unknown }).locale;
  });
});
