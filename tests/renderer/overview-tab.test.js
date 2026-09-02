import { describe, expect, it } from "vitest";
import { renderOverview } from "../../src/renderer/panel/tabs/overview";

describe("overview tab", () => {
  it("always shows the primary asset-pack import action", () => {
    const html = renderOverview({
      currentPackageId: "pet",
      system: { onboardingVersion: 1 },
      animations: { default: { id: "idle", asset: "assets/idle.webm" }, clips: [] },
      triggerRules: []
    });

    expect(html).toContain("Import asset pack");
    expect(html).toContain('data-action="import-petpack"');
    expect(html).toContain("Choose asset pack");
  });

  it("teaches the five studio interactions only while a studio pack is active", () => {
    const config = {
      currentPackageId: "hey-dog",
      system: { onboardingVersion: 1 },
      animations: { default: { id: "idle", asset: "assets/idle.webm" }, clips: [] },
      triggerRules: []
    };

    const withGuide = renderOverview(config, null, { studioPackage: true });
    expect(withGuide).toContain('data-testid="play-guide"');
    expect(withGuide).toContain("Five things your pet does");
    for (const key of ["click", "doubleClick", "rightClick", "hover", "idle"]) {
      expect(withGuide).toContain(`data-guide="${key}"`);
    }
    // The timings are the studio profile's, not typed by hand.
    expect(withGuide).toContain("Rest the cursor on it for 2s");
    expect(withGuide).toContain("once every 20s");
    expect(withGuide).toContain("Leave it alone for 22s");
    // A sleeping pet ignores everything but a right click, so the guide says
    // so twice: on the right-click line and as its own note.
    expect(withGuide).toContain("it is the only way to wake it");
    expect(withGuide).toContain('data-guide-note="sleep"');
    expect(withGuide).toContain("right-click is the only thing that wakes it");
    expect(withGuide).toContain("licks a paw");
    expect(withGuide).not.toContain("a click wakes it");

    expect(renderOverview(config, null, {})).not.toContain('data-testid="play-guide"');
  });

  it("disables the primary asset-pack action while import is active", () => {
    const html = renderOverview({
      currentPackageId: "pet",
      system: { onboardingVersion: 1 },
      animations: { default: { id: "idle", asset: "assets/idle.webm" }, clips: [] },
      triggerRules: []
    }, null, { savingKey: "petpack-import" });

    expect(html).toContain('data-action="import-petpack" disabled');
    expect(html).toContain("Importing...");
  });

  it("shows the first-run sample petpack path until onboarding is completed", () => {
    const pendingHtml = renderOverview({
      currentPackageId: "default-pet",
      system: { onboardingVersion: 0 },
      animations: { default: { id: "idle", asset: "assets/idle.svg" }, clips: [] },
      triggerRules: []
    });

    expect(pendingHtml).toContain("Get your desktop pet moving");
    expect(pendingHtml).toContain('data-action="install-sample-petpack"');
    expect(pendingHtml).toContain("Import sample petpack");
    expect(pendingHtml).toContain('data-action="skip-onboarding"');

    const completedHtml = renderOverview({
      currentPackageId: "default-pet",
      system: { onboardingVersion: 1 },
      animations: { default: { id: "idle", asset: "assets/idle.svg" }, clips: [] },
      triggerRules: []
    });

    expect(completedHtml).not.toContain('data-action="install-sample-petpack"');
  });

  it("shows a disabled progress action while the sample petpack is installing", () => {
    const html = renderOverview({
      currentPackageId: "default-pet",
      system: { onboardingVersion: 0 },
      animations: { default: { id: "idle", asset: "assets/idle.svg" }, clips: [] },
      triggerRules: []
    }, null, { savingKey: "onboarding-sample-install" });

    expect(html).toContain("Downloading and importing...");
    expect(html).toContain('data-action="install-sample-petpack" disabled');
  });

  it("shows the immediate success state after the sample petpack is imported", () => {
    const html = renderOverview({
      currentPackageId: "taotao",
      system: { onboardingVersion: 1 },
      animations: { default: { id: "idle", asset: "assets/idle.svg" }, clips: [] },
      triggerRules: []
    }, null, { onboardingJustCompleted: true });

    expect(html).toContain("Taotao is now on your desktop");
    expect(html).toContain('data-action="dismiss-onboarding-success"');
  });

  it("shows recently triggered rule action summaries including blank and delay actions", () => {
    const html = renderOverview({
      currentPackageId: "pet",
      animations: {
        default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
        clips: []
      },
      triggerRules: [{
        id: "rule-wait",
        name: "Wait before wave",
        conditions: [{ type: "click", filters: [] }],
        actions: [{ type: "blank", durationMs: 1500 }, { type: "delay", durationMs: 1500 }]
      }]
    }, {
      currentState: {
        animation: "idle",
        sprite: "",
        position: { x: 10, y: 20 },
        display: { scale: 1, opacity: 1 }
      },
      recentEvents: [],
      ruleStates: { "rule-wait": Date.now() },
      timers: [],
      interactionsPaused: false
    });

    expect(html).toContain("Wait before wave");
    expect(html).toContain("Blank action");
    expect(html).not.toContain("Blank action · 1500ms");
    expect(html).toContain("Delay · 1500ms");
  });

  it("omits system status and expands recent triggered rules", () => {
    const triggerRules = Array.from({ length: 7 }, (_, index) => ({
      id: `rule-${index}`,
      name: `Rule ${index}`,
      conditions: [{ type: "click", filters: [] }],
      actions: [{ type: "showMessage", text: `Rule ${index}` }]
    }));
    const now = Date.now();
    const ruleStates = Object.fromEntries(triggerRules.map((rule, index) => [rule.id, now - index]));

    const html = renderOverview({
      currentPackageId: "pet",
      animations: {
        default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
        clips: []
      },
      triggerRules
    }, {
      currentState: {
        animation: "idle",
        sprite: "",
        position: { x: 10, y: 20 },
        display: { scale: 1, opacity: 1 }
      },
      recentEvents: [],
      ruleStates,
      timers: [],
      interactionsPaused: true
    });

    expect(html).not.toContain("System Status");
    expect(html).toContain("recent-rules-card");
    expect(html).toContain("Rule 0");
    expect(html).toContain("Rule 5");
    expect(html).not.toContain("Rule 6");
  });
});
