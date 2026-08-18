import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The API reports a giving-up run as `failed`, but the workflow rendered the
// candidate grid regardless, so a failed run showed "正在生成 正面" forever.
// The character page also never refreshed, so even a healthy run left the
// customer staring at a stale page while the masters finished.
describe("project workflow run-state handling", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "ProjectWorkflow.tsx"),
    "utf8"
  );

  it("renders a failure branch before any mode-specific content", () => {
    const failedBranch = source.indexOf("view.failed");
    const characterMode = source.indexOf('mode === "character"', failedBranch);
    expect(failedBranch).toBeGreaterThan(-1);
    expect(characterMode).toBeGreaterThan(failedBranch);
  });

  it("keeps polling on the character page until the run settles", () => {
    expect(source).toMatch(/const settled = /);
    expect(source).not.toContain('if (mode !== "progress") return;');
    const pollEffect = source.slice(source.indexOf("setInterval") - 300);
    expect(pollEffect).toContain("settled");
  });

  it("does not poll once the run has failed or both candidates arrived", () => {
    const start = source.indexOf("const settled = ");
    const settled = source.slice(start, source.indexOf(";", start));
    expect(settled).toContain("view.failed");
    expect(settled).toContain("characterCandidates.front");
    expect(settled).toContain("characterCandidates.side");
  });
});
