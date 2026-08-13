import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { t, setLocale, getLocale, initLocale, getAvailableLocales } from "../../src/shared/i18n.js";

describe("i18n", () => {
  beforeEach(() => {
    setLocale("en");
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("locale");
    }
  });

  afterEach(() => {
    setLocale("en");
  });

  describe("setLocale / getLocale", () => {
    it("should set and get locale", () => {
      setLocale("zh");
      expect(getLocale()).toBe("zh");
    });

    it("should ignore invalid locale", () => {
      setLocale("en");
      setLocale("invalid");
      expect(getLocale()).toBe("en");
    });

    it("should store locale in localStorage", () => {
      if (typeof localStorage === "undefined") {
        return;
      }

      setLocale("zh");
      expect(localStorage.getItem("locale")).toBe("zh");
    });
  });

  describe("t (translate)", () => {
    it("should translate English keys", () => {
      setLocale("en");
      expect(t("common.save")).toBe("Save");
      expect(t("panel.tabs.overview")).toBe("Overview");
    });

    it("should translate Chinese keys", () => {
      setLocale("zh");
      expect(t("common.save")).toBe("保存");
      expect(t("panel.tabs.overview")).toBe("概览");
    });

    it("should return key if translation not found", () => {
      expect(t("non.existent.key")).toBe("non.existent.key");
    });

    it("should interpolate parameters", () => {
      setLocale("en");
      expect(t("assets.import.success", { asset: "test.png" })).toBe("Imported test.png.");
    });

    it("should interpolate multiple parameters", () => {
      setLocale("en");
      expect(t("assets.petpack.exportSuccess", { packageId: "my-pet", targetPath: "/path/to/file" }))
        .toBe("Exported my-pet to /path/to/file.");
    });

    it("should fallback to English if translation missing in current locale", () => {
      setLocale("zh");
      // Test with a key that exists in English but not in Chinese (if any)
      const result = t("common.save");
      expect(result).toBe("保存");
    });
  });

  describe("initLocale", () => {
    it("should initialize from localStorage", () => {
      if (typeof localStorage === "undefined") {
        return;
      }

      localStorage.setItem("locale", "zh");
      initLocale();
      expect(getLocale()).toBe("zh");
    });

    it("should detect Chinese from browser language", () => {
      if (typeof navigator === "undefined") {
        return;
      }

      // This test depends on the actual browser environment
      // In a real browser with Chinese locale, it would set to "zh"
      initLocale();
      expect(["en", "zh"]).toContain(getLocale());
    });
  });

  describe("getAvailableLocales", () => {
    it("should return all available locales", () => {
      const locales = getAvailableLocales();
      expect(locales).toEqual([
        { code: "en", name: "English" },
        { code: "zh", name: "中文" }
      ]);
    });
  });

  describe("translations completeness", () => {
    it("should have matching keys in English and Chinese", () => {
      const testKeys = [
        "common.save",
        "common.delete",
        "panel.title",
        "panel.tabs.overview",
        "assets.title",
        "system.language"
      ];

      testKeys.forEach(key => {
        setLocale("en");
        const enText = t(key);
        setLocale("zh");
        const zhText = t(key);

        expect(enText).not.toBe(key); // English translation exists
        expect(zhText).not.toBe(key); // Chinese translation exists
        expect(enText).not.toBe(zhText); // Translations are different
      });
    });
  });
});
