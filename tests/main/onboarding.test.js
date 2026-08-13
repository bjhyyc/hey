import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CURRENT_ONBOARDING_VERSION,
  getOnboardingVersion,
  shouldShowOnboarding
} = require("../../src/main/onboarding");

describe("first-run onboarding", () => {
  it("shows until the current onboarding version is completed", () => {
    expect(CURRENT_ONBOARDING_VERSION).toBe(1);
    expect(shouldShowOnboarding({ system: { onboardingVersion: 0 } })).toBe(true);
    expect(shouldShowOnboarding({ system: { onboardingVersion: 1 } })).toBe(false);
  });

  it("treats missing or invalid versions as not completed", () => {
    expect(getOnboardingVersion({})).toBe(0);
    expect(getOnboardingVersion({ system: { onboardingVersion: "bad" } })).toBe(0);
    expect(shouldShowOnboarding({})).toBe(true);
  });
});
