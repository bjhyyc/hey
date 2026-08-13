import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../src/renderer/panel/panel.css", import.meta.url), "utf8");

function getMediaBlock(maxWidth) {
  const marker = `@media (max-width: ${maxWidth}px)`;
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const openBrace = css.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(openBrace + 1, index);
  }
  throw new Error(`Unclosed media block: ${marker}`);
}

describe("panel asset browser layout css", () => {
  it("keeps non-oneshot animation duration controls hidden", () => {
    expect(css).toMatch(/\.animation-editor-compact-grid\s+\[data-role="animation-duration"\]\[hidden\]\s*\{[^}]*display:\s*none/s);
  });

  it("keeps long resource and animation lists independently scrollable beside a sticky detail pane", () => {
    expect(css).toMatch(/\.asset-browser\s*>\s*\.item-list\s*\{[^}]*max-height:\s*calc\(100vh - 260px\)/s);
    expect(css).toMatch(/\.asset-browser\s*>\s*\.item-list\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.asset-browser\s*>\s*\.asset-detail\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(/\.asset-browser\s*>\s*\.asset-detail\s*\{[^}]*top:\s*16px/s);
  });

  it("keeps the two-column browser on the default 960px panel and returns to single flow only on narrow widths", () => {
    const defaultPanelBlock = getMediaBlock(1040);
    const narrowPanelBlock = getMediaBlock(720);

    expect(defaultPanelBlock).not.toContain(".asset-browser");
    expect(narrowPanelBlock).toMatch(/\.asset-browser\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(narrowPanelBlock).toMatch(/\.asset-browser\s*>\s*\.asset-detail\s*\{[^}]*position:\s*static/s);
  });

  it("keeps rule transfer dropdowns hoverable without a trigger arrow", () => {
    expect(css).not.toContain(".rule-menu-trigger::after");
    expect(css).toMatch(/\.rule-menu-panel\s*\{[^}]*top:\s*100%/s);
    expect(css).not.toMatch(/\.rule-menu-panel\s*\{[^}]*top:\s*calc\(100% \+ 4px\)/s);
  });
});
