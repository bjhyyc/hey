import { describe, expect, it, vi } from "vitest";
import { handleChange, handleClickAction } from "../../src/renderer/panel/handlers/event-handlers";
import { renderRuleConditionEditor } from "../../src/renderer/panel/components/rule-condition-editor";
import { renderRules } from "../../src/renderer/panel/tabs/rules";

describe("rules tab", () => {
  const config = {
    animations: {
      default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
      clips: []
    },
    triggerRules: [
      {
        id: "rule-click",
        name: "Click reaction",
        enabled: true,
        relation: "single",
        priority: 1,
        conditions: [{ type: "click", filters: [] }],
        actions: [{ type: "playAnimation", animation: "idle", durationMs: 900 }]
      }
    ]
  };

  it("renders the rule editor only when the modal state is open", () => {
    expect(renderRules({ selectedRuleId: "", ruleEditorOpen: false, savingKey: "" }, config)).not.toContain("modal-panel rule-editor-modal");

    const html = renderRules({ selectedRuleId: "", ruleEditorOpen: true, savingKey: "" }, config);
    expect(html).toContain("modal-panel rule-editor-modal");
    expect(html).toContain('id="rule-form"');
    expect(html).not.toContain('name="enabled"');
    expect(html).toContain('name="stopOnMatch" type="checkbox" checked');
    expect(html).toContain('data-action="toggle-rule-enabled"');
    expect(html).toContain('data-action="close-rule-editor"');
  });

  it("renders translated condition names in the rule list", () => {
    const html = renderRules({ selectedRuleId: "", ruleEditorOpen: false, savingKey: "" }, config);

    expect(html).toContain(">Click</span>");
    expect(html).not.toContain(">click</span>");
  });

  it("renders rule import/export controls and disables export when no rules are selected", () => {
    const html = renderRules({ selectedRuleId: "", selectedRuleExportIds: [], ruleEditorOpen: false, savingKey: "" }, config);

    expect(html).toContain('class="rule-transfer-menu" data-transfer-menu="import"');
    expect(html).toContain('class="rule-transfer-menu" data-transfer-menu="export"');
    expect(html.match(/class="rule-menu-trigger"/g)).toHaveLength(2);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('data-action="import-rules-file"');
    expect(html).toContain('data-action="import-rules-clipboard"');
    expect(html).toContain('data-action="export-selected-rules-file"');
    expect(html).toContain('data-action="export-selected-rules-clipboard"');
    expect(html).toContain('data-action="toggle-all-rule-exports"');
    expect(html).toContain('data-action="toggle-rule-export-selection" data-id="rule-click" aria-selected="false"');
    expect(html).toContain('class="header-actions rule-header-actions"');
    expect(html).toContain('data-id="rule-click"');
    expect(html).toContain('data-transfer-menu="export"');
    expect(html).toMatch(/>\s*Export selected\s*<\/button>/);
    expect(html).toContain('data-action="export-selected-rules-file" disabled');
    expect(html).toContain('data-action="export-selected-rules-clipboard" disabled');
  });

  it("enables selected rule export when at least one rule is selected", () => {
    const html = renderRules({ selectedRuleId: "", selectedRuleExportIds: ["rule-click"], ruleEditorOpen: false, savingKey: "" }, config);
    const exportIndex = html.indexOf('data-action="export-selected-rules-file"');
    const exportSnippet = html.slice(exportIndex, exportIndex + 120);

    expect(exportSnippet).not.toContain("disabled");
    expect(html).toContain('data-action="toggle-rule-export-selection" data-id="rule-click" aria-selected="true"');
  });

  it("does not render a conflict alert when rules do not conflict", () => {
    const html = renderRules({ selectedRuleId: "", ruleEditorOpen: false, savingKey: "" }, {
      ...config,
      triggerRules: [
        { id: "rule-click", name: "Click", conditions: [{ type: "click", filters: [] }] },
        { id: "rule-enter", name: "Enter", conditions: [{ type: "mouseEnter", filters: [] }] }
      ]
    });

    expect(html).not.toContain("rule-conflict-alert");
  });

  it("renders a conflict alert with rule names and translated action labels", () => {
    const html = renderRules({ selectedRuleId: "", ruleEditorOpen: false, savingKey: "" }, {
      ...config,
      triggerRules: [
        {
          id: "rule-hide",
          name: "Hide on click",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "hidePet" }]
        },
        {
          id: "rule-show",
          name: "Show on click",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showPet" }]
        }
      ]
    });

    expect(html).toContain("rule-conflict-alert");
    expect(html).toContain("2 potential rule conflict detected");
    expect(html).toContain("Hide on click / Show on click");
    expect(html).toContain("Hide on click and Show on click may match the same interaction.");
    expect(html).toContain("Hide pet and Show pet");
  });

  it("limits rendered conflict details and shows the remaining count", () => {
    const rules = Array.from({ length: 6 }, (_, index) => ({
      id: `rule-${index}`,
      name: `Rule ${index}`,
      conditions: [{ type: "click", filters: [] }],
      actions: []
    }));
    const html = renderRules({ selectedRuleId: "", ruleEditorOpen: false, savingKey: "" }, {
      ...config,
      triggerRules: rules
    });

    expect(html).toContain("15 potential rule conflict detected");
    expect(html).toContain("10 more potential conflict(s) not shown.");
    expect(html.match(/may match the same interaction/g)).toHaveLength(5);
  });

  it("renders the stop-on-match switch in basic information and reflects disabled state", () => {
    const html = renderRules({ selectedRuleId: "rule-click", ruleEditorOpen: true, savingKey: "" }, {
      ...config,
      triggerRules: [{ ...config.triggerRules[0], stopOnMatch: false }]
    });
    const basicInfoIndex = html.indexOf("Basic Information");
    const stopOnMatchIndex = html.indexOf('name="stopOnMatch"');
    const triggerConditionsIndex = html.indexOf("Trigger Conditions");
    const inputSnippet = html.slice(stopOnMatchIndex, stopOnMatchIndex + 80);

    expect(basicInfoIndex).toBeGreaterThan(-1);
    expect(stopOnMatchIndex).toBeGreaterThan(basicInfoIndex);
    expect(stopOnMatchIndex).toBeLessThan(triggerConditionsIndex);
    expect(inputSnippet).not.toContain("checked");
  });

  it("renders global cooldown in basic information instead of advanced options", () => {
    const html = renderRules({ selectedRuleId: "rule-click", ruleEditorOpen: true, savingKey: "" }, {
      ...config,
      triggerRules: [{ ...config.triggerRules[0], cooldownMs: 1200 }]
    });
    const basicInfoIndex = html.indexOf("Basic Information");
    const cooldownIndex = html.indexOf('name="cooldownMs"');
    const triggerConditionsIndex = html.indexOf("Trigger Conditions");

    expect(basicInfoIndex).toBeGreaterThan(-1);
    expect(cooldownIndex).toBeGreaterThan(basicInfoIndex);
    expect(cooldownIndex).toBeLessThan(triggerConditionsIndex);
    expect(html).not.toContain("Advanced Options");
    expect(html).toContain('name="cooldownMs" type="number" min="0" step="1" value="1200"');
  });

  it("renders exit condition/action blocks only for mouseMove trigger rules", () => {
    const newRuleHtml = renderRules({ selectedRuleId: "", ruleEditorOpen: true, savingKey: "" }, config);

    expect(newRuleHtml).toContain('name="conditionSustainMs"');
    expect(newRuleHtml).toContain('name="conditionRequired"');
    expect(newRuleHtml).toContain('data-role="exit-state-block" style="display: none;"');
    expect(newRuleHtml).toContain('data-scope="actions"');
    expect(newRuleHtml).toContain('data-scope="exitActions"');

    const mouseMoveConfig = {
      ...config,
      triggerRules: [{
        id: "rule-near",
        name: "Near",
        enabled: true,
        relation: "single",
        priority: 1,
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }], sustainMs: 3000 }],
        actions: [{ type: "playAnimation", animation: "idle", durationMs: 900 }],
        state: {
          exitRelation: "single",
          exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 3000 }],
          exitActions: [{ type: "playAnimation", animation: "idle", durationMs: 900 }]
        }
      }]
    };
    const mouseMoveHtml = renderRules({ selectedRuleId: "rule-near", ruleEditorOpen: true, savingKey: "" }, mouseMoveConfig);

    expect(mouseMoveHtml).not.toContain('name="exitRelation"');
    expect(mouseMoveHtml).not.toContain('name="exitAndWindowMs"');
    expect(mouseMoveHtml).toContain('data-scope="exitConditions"');
    expect(mouseMoveHtml).toContain('data-action="add-rule-condition" data-scope="exitConditions"');
    expect(mouseMoveHtml.match(/data-action="show-condition-help"/g)).toHaveLength(2);
    expect(mouseMoveHtml).not.toContain('data-role="exit-state-block" style="display: none;"');
  });

  it("renders blank actions as no-param probability placeholders", () => {
    const html = renderRules({ selectedRuleId: "rule-wait", ruleEditorOpen: true, savingKey: "" }, {
      ...config,
      triggerRules: [{
        id: "rule-wait",
        name: "Wait",
        enabled: true,
        relation: "single",
        priority: 1,
        conditions: [{ type: "click", filters: [] }],
        actions: [{ type: "blank" }]
      }]
    });

    expect(html).toContain('option value="blank" selected');
    expect(html).toContain("Blank action");
    expect(html).not.toContain('option value="delay"');
    expect(html).not.toContain('name="durationMs" value="1200"');
    expect(html).toContain("Does nothing. Useful with random execution to control the chance that no action runs.");
    expect(html).toContain('data-action="add-inline-delay" data-scope="actions"');
  });

  it("renders delay actions with editable duration and add delay controls", () => {
    const html = renderRules({ selectedRuleId: "rule-delay", ruleEditorOpen: true, savingKey: "" }, {
      ...config,
      triggerRules: [{
        id: "rule-delay",
        name: "Delay",
        enabled: true,
        relation: "single",
        priority: 1,
        conditions: [{ type: "mouseMove", filters: [] }],
        actions: [{ type: "delay", durationMs: 1200 }],
        state: {
          exitConditions: [{ type: "mouseMove", filters: [] }],
          exitActions: [{ type: "delay", durationMs: 800 }]
        }
      }]
    });

    expect(html).toContain("Delay");
    expect(html).toContain('name="durationMs" value="1200"');
    expect(html).toContain('name="durationMs" value="800"');
    expect(html).toContain("Wait for this duration before the next action.");
    expect(html).toContain('data-action="add-inline-delay" data-scope="actions"');
    expect(html).toContain('data-action="add-inline-delay" data-scope="exitActions"');
  });

  it("renders pomodoro timer action parameters", () => {
    const html = renderRules({ selectedRuleId: "rule-focus", ruleEditorOpen: true, savingKey: "" }, {
      ...config,
      triggerRules: [{
        id: "rule-focus",
        name: "Focus",
        enabled: true,
        relation: "single",
        priority: 1,
        conditions: [{ type: "click", filters: [] }],
        actions: [{ type: "pomodoroTimer", command: "start", durationMs: 1500000, label: "Focus" }]
      }]
    });

    expect(html).toContain('option value="pomodoroTimer" selected');
    expect(html).toContain("Pomodoro timer");
    expect(html).toContain('name="pomodoroCommand"');
    expect(html).toContain('option value="start" selected');
    expect(html).toContain('name="durationMs" value="1500000"');
    expect(html).toContain('name="label" value="Focus"');
  });

  it("refreshes pomodoro timer parameters when command changes", async () => {
    const replacements = {};
    const actionRow = {
      dataset: { index: "0", scope: "actions" }
    };
    Object.defineProperty(actionRow, "outerHTML", {
      set: (value) => { replacements.row = value; }
    });
    const target = {
      value: "cancel",
      dataset: {},
      classList: {
        contains: (className) => className === "pomodoro-command-selector"
      },
      closest: (selector) => selector === "[data-inline-action]" ? actionRow : null
    };

    await handleChange({ target }, { config }, {}, vi.fn(), vi.fn());

    expect(replacements.row).toContain('option value="pomodoroTimer" selected');
    expect(replacements.row).toContain('option value="cancel" selected');
    expect(replacements.row).not.toContain('name="durationMs"');
    expect(replacements.row).not.toContain('name="label"');
  });

  it("refreshes play animation parameters when selecting a oneshot clip from a newly added action", async () => {
    const replacements = {};
    const actionRow = {
      dataset: { index: "0", scope: "actions" },
      querySelector: vi.fn((selector) => selector === '[data-role="loop-hint"]' ? { style: { display: "" } } : null)
    };
    Object.defineProperty(actionRow, "outerHTML", {
      set: (value) => { replacements.row = value; }
    });
    const target = {
      dataset: { role: "animation-selector" },
      classList: { contains: () => false },
      value: "jump",
      selectedIndex: 1,
      options: [
        { dataset: { type: "default", duration: "900" } },
        { dataset: { type: "oneshot", duration: "1350" } }
      ],
      closest: (selector) => selector === "[data-inline-action]" ? actionRow : null
    };
    const state = {
      config: {
        animations: {
          default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
          clips: [
            { id: "jump", name: "Jump", asset: "assets/jump.svg", type: "oneshot", durationMs: 1350 }
          ]
        }
      }
    };

    await handleChange({ target }, state, {}, vi.fn(), vi.fn());

    expect(replacements.row || "").toContain('option value="jump" selected');
    expect(replacements.row || "").toContain('data-role="oneshot-duration-hint"');
    expect(replacements.row || "").toContain('name="durationMs" value="1350" disabled');
  });

  it("renders inline action rows as draggable for reordering", () => {
    const html = renderRules({ selectedRuleId: "rule-click", ruleEditorOpen: true, savingKey: "" }, config);

    expect(html).toContain('class="inline-action-row"');
    expect(html).toContain('data-inline-action draggable="true"');
    expect(html).not.toContain('data-action-drag-handle');
  });

  it("renders filter controls according to field type", () => {
    const booleanHtml = renderRuleConditionEditor({
      type: "mouseMove",
      filters: [{ field: "isInsidePet", operator: "!=", value: true }]
    }, 0);
    const numberHtml = renderRuleConditionEditor({
      type: "mouseMove",
      filters: [{ field: "speed", operator: ">", value: 100 }]
    }, 0);
    const selectHtml = renderRuleConditionEditor({
      type: "mouseMove",
      filters: [{ field: "direction", operator: "=", value: "right" }]
    }, 0);
    const noFilterHtml = renderRuleConditionEditor({ type: "click", filters: [] }, 0);

    expect(booleanHtml).toContain('data-role="filter-operator-container" style="display: none;"');
    expect(booleanHtml).toContain('name="filterOperator" value="="');
    expect(booleanHtml).toContain('<option value="true" selected>True</option>');
    expect(booleanHtml).toContain('<option value="false" >False</option>');

    const numberOperatorHtml = numberHtml.slice(numberHtml.indexOf('data-role="filter-operator-container"'), numberHtml.indexOf('data-role="filter-value-container"'));
    expect(numberOperatorHtml).toContain('<option value="between"');
    expect(numberOperatorHtml).toContain('<option value="&gt;" selected>&gt;</option>');
    expect(numberHtml).toContain('name="filterValue" data-role="filter-value" type="number"');

    const selectOperatorHtml = selectHtml.slice(selectHtml.indexOf('data-role="filter-operator-container"'), selectHtml.indexOf('data-role="filter-value-container"'));
    expect(selectOperatorHtml).toContain('<option value="in"');
    expect(selectOperatorHtml).not.toContain('<option value="between"');
    expect(selectHtml).toContain('<option value="right" selected>Right</option>');

    expect(noFilterHtml).toContain('data-role="filter-operator-container" style="display: none;"');
    expect(noFilterHtml).toContain('data-role="filter-value-container" style="display: none;"');
    expect(noFilterHtml).not.toContain('value="petPosition"');
  });

  it("does not render redundant filter fields for discrete pointer conditions", () => {
    const clickHtml = renderRuleConditionEditor({ type: "click", filters: [] }, 0);
    const enterHtml = renderRuleConditionEditor({ type: "mouseEnter", filters: [] }, 0);
    const dragStartHtml = renderRuleConditionEditor({ type: "dragStart", filters: [] }, 0);
    const moveHtml = renderRuleConditionEditor({ type: "mouseMove", filters: [] }, 0);

    expect(clickHtml).not.toContain('value="isInsidePet"');
    expect(clickHtml).not.toContain('value="distanceToPetBounds"');
    expect(clickHtml).toContain('value="distanceToPetCenter"');

    expect(enterHtml).not.toContain('value="isInsidePet"');
    expect(enterHtml).not.toContain('value="distanceToPetBounds"');
    expect(enterHtml).toContain('value="distanceToPetCenter"');

    expect(dragStartHtml).not.toContain('value="isInsidePet"');
    expect(dragStartHtml).not.toContain('value="dragDistance"');
    expect(dragStartHtml).toContain('value="distanceToPetCenter"');

    expect(moveHtml).toContain('value="isInsidePet"');
    expect(moveHtml).toContain('value="distanceToPetBounds"');
  });

  it("renders random timer min and max interval settings outside advanced filters", () => {
    const html = renderRuleConditionEditor({
      type: "randomTimer",
      minMs: 3000,
      maxMs: 9000
    }, 0);

    expect(html).toContain('name="randomTimerMinMs"');
    expect(html).toContain('name="randomTimerMaxMs"');
    expect(html).toContain('value="3000"');
    expect(html).toContain('value="9000"');
    expect(html).not.toContain('<option value="minMs"');
    expect(html).not.toContain('<option value="maxMs"');
  });

  it("renders timer interval settings outside advanced filters", () => {
    const html = renderRuleConditionEditor({
      type: "timer",
      intervalMs: 7000
    }, 0);

    expect(html).toContain('name="timerIntervalMs"');
    expect(html).toContain('value="7000"');
    expect(html).not.toContain('<option value="intervalMs"');
  });

  it("refreshes filter operator and value controls when field choices change", async () => {
    const replacements = {};
    const operatorContainer = {};
    const valueContainer = {};
    Object.defineProperty(operatorContainer, "outerHTML", {
      set: (value) => { replacements.operator = value; }
    });
    Object.defineProperty(valueContainer, "outerHTML", {
      set: (value) => { replacements.value = value; }
    });
    const row = {
      dataset: { scope: "conditions" },
      parentElement: null,
      querySelector: (selector) => {
        if (selector === '[data-role="filter-operator-container"]') return operatorContainer;
        if (selector === '[data-role="filter-value-container"]') return valueContainer;
        return null;
      }
    };
    const target = {
      dataset: { role: "filter-field" },
      classList: { contains: () => false },
      value: "isInsidePet",
      closest: () => row
    };

    await handleChange({ target }, {}, {}, vi.fn(), vi.fn());

    expect(replacements.operator).toContain('style="display: none;"');
    expect(replacements.operator).toContain('name="filterOperator" value="="');
    expect(replacements.value).toContain('<select id="rule-filter-value-conditions-0" name="filterValue" data-role="filter-value">');
    expect(replacements.value).toContain('<option value="true" selected>True</option>');

    target.value = "";
    await handleChange({ target }, {}, {}, vi.fn(), vi.fn());

    expect(replacements.operator).toContain('style="display: none;"');
    expect(replacements.value).toContain('style="display: none;"');
    expect(replacements.value).toContain('name="filterValue" value=""');
  });

  it("resets filter field, operator, and value when condition type changes", async () => {
    const replacements = {};
    const operatorContainer = {};
    const valueContainer = {};
    Object.defineProperty(operatorContainer, "outerHTML", {
      set: (value) => { replacements.operator = value; }
    });
    Object.defineProperty(valueContainer, "outerHTML", {
      set: (value) => { replacements.value = value; }
    });
    const fieldSelect = { innerHTML: "", value: "speed" };
    const row = {
      dataset: { scope: "conditions" },
      parentElement: null,
      querySelector: (selector) => {
        if (selector === '[data-role="filter-field"]') return fieldSelect;
        if (selector === '[data-role="filter-operator-container"]') return operatorContainer;
        if (selector === '[data-role="filter-value-container"]') return valueContainer;
        if (selector === '[data-role="condition-sustain"]') return null;
        return null;
      }
    };
    const target = {
      dataset: { role: "condition-type" },
      classList: { contains: () => false },
      value: "click",
      closest: (selector) => selector === "[data-rule-condition]" ? row : null
    };

    await handleChange({ target }, {}, {}, vi.fn(), vi.fn());

    expect(fieldSelect.value).toBe("");
    expect(fieldSelect.innerHTML).toContain('value="distanceToPetCenter"');
    expect(fieldSelect.innerHTML).not.toContain('value="isInsidePet"');
    expect(fieldSelect.innerHTML).not.toContain('value="petPosition"');
    expect(replacements.operator).toContain('style="display: none;"');
    expect(replacements.value).toContain('style="display: none;"');
  });

  it("refreshes the filter value control when operator changes", async () => {
    const replacements = {};
    const operatorContainer = {};
    const valueContainer = {};
    Object.defineProperty(operatorContainer, "outerHTML", {
      set: (value) => { replacements.operator = value; }
    });
    Object.defineProperty(valueContainer, "outerHTML", {
      set: (value) => { replacements.value = value; }
    });
    const fieldSelect = { value: "speed" };
    const row = {
      dataset: { scope: "conditions" },
      parentElement: null,
      querySelector: (selector) => {
        if (selector === '[data-role="filter-field"]') return fieldSelect;
        if (selector === '[data-role="filter-operator-container"]') return operatorContainer;
        if (selector === '[data-role="filter-value-container"]') return valueContainer;
        return null;
      }
    };
    const target = {
      dataset: { role: "filter-operator" },
      classList: { contains: () => false },
      value: "between",
      closest: () => row
    };

    await handleChange({ target }, {}, {}, vi.fn(), vi.fn());

    expect(replacements.operator).toContain('<option value="between" selected>');
    expect(replacements.value).toContain('type="text" inputmode="decimal"');
    expect(replacements.value).toContain('Comma-separated values');
    expect(replacements.value).not.toContain('value="100"');
  });

  it("opens the modal for new and existing rules from click actions", async () => {
    const state = { config, savingKey: "", selectedRuleId: "", ruleEditorOpen: false };
    const render = vi.fn();
    const makeEvent = (action, id) => ({
      target: {
        closest: () => ({ dataset: { action, id } })
      }
    });

    await handleClickAction(makeEvent("new-rule"), state, {}, vi.fn(), render);
    expect(state).toMatchObject({ selectedRuleId: "", ruleEditorOpen: true });
    expect(render).toHaveBeenCalledTimes(1);

    await handleClickAction(makeEvent("edit-rule", "rule-click"), state, {}, vi.fn(), render);
    expect(state).toMatchObject({ selectedRuleId: "rule-click", ruleEditorOpen: true });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("saves rule enabled state from the list switch", async () => {
    const state = { config, savingKey: "", selectedRuleId: "", ruleEditorOpen: false };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);
    const input = { dataset: { action: "toggle-rule-enabled", id: "rule-click" }, checked: false };

    await handleClickAction({ target: { closest: () => input } }, state, {}, saveConfig, vi.fn());

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      triggerRules: [expect.objectContaining({ id: "rule-click", enabled: false })]
    }), "rule");
  });
});
