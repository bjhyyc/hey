import { describe, expect, it } from "vitest";
import { renderTabs } from "../../src/renderer/panel/ui/tabs";

function renderNavigation(activeTab) {
  const element = { innerHTML: "" };
  renderTabs(activeTab, element);
  return element.innerHTML;
}

describe("panel tab navigation", () => {
  it("keeps overview visible and places all advanced pages inside Settings", () => {
    const html = renderNavigation("overview");

    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('<details class="settings-menu">');
    expect(html).not.toContain('<details class="settings-menu" open>');
    expect(html).toContain(">Settings</summary>");
    for (const tab of ["assets", "animations", "rules", "display", "system"]) {
      expect(html).toContain(`data-tab="${tab}"`);
    }
  });

  it("opens Settings automatically while an advanced page is active", () => {
    const html = renderNavigation("assets");

    expect(html).toContain('<details class="settings-menu" open>');
    expect(html).toContain('data-tab="assets" aria-selected="true"');
  });
});
