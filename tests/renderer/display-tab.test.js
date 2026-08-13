import { describe, expect, it } from "vitest";
import { renderDisplay } from "../../src/renderer/panel/tabs/display";

describe("display tab", () => {
  it("renders direct-save controls without a save button", () => {
    const html = renderDisplay({ savingKey: "" }, {
      display: {
        scale: 1.25,
        opacity: 0.8,
        alwaysOnTop: true,
        mousePassthrough: false
      }
    });

    expect(html).toContain('id="display-scale"');
    expect(html).toContain('id="display-scale" name="scale" type="range" min="50" max="300"');
    expect(html).toContain('id="display-opacity"');
    expect(html).toContain('name="alwaysOnTop"');
    expect(html).toContain('name="mousePassthrough"');
    expect(html).toContain('data-action="reset-position"');
    expect(html).not.toContain('type="submit"');
  });
});
