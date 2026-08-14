const fs = require("node:fs");

const ACTION_ID_ALIASES = Object.freeze({
  "idle-loop": "idle",
  idle: "idle",
  "sleep-transition": "sleep-transition",
  "sleep-loop": "sleep-loop",
  stretch: "stretch",
  sneeze: "sneeze",
  roll: "roll",
  "paw-lick": "hover-attention",
  "hover-attention": "hover-attention"
});

const ACTION_FRAME_MODES = Object.freeze({
  idle: ["awake", "awake"],
  "sleep-transition": ["awake", "sleep"],
  "sleep-loop": ["sleep", "sleep"],
  stretch: ["sleep", "awake"],
  sneeze: ["awake", "awake"],
  roll: ["awake", "awake"],
  "hover-attention": ["awake", "awake"]
});

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function readPromptFile(filePath, { readFileSync = fs.readFileSync } = {}) {
  return readFileSync(filePath, "utf8");
}

function sectionize(text) {
  const lines = requiredString(text, "Prompt file").split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^\s*[一二三四五六七八九十]+、\s*(.+?)\s*$/u);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

function captureBetween(lines, startLabel, endLabel) {
  const start = lines.findIndex((line) => line.trim() === startLabel);
  if (start < 0) throw new Error(`Prompt section is missing ${startLabel}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === endLabel);
  if (end < 0) throw new Error(`Prompt section is missing ${endLabel}`);
  const value = lines.slice(start + 1, end).join("\n").trim();
  if (!value) throw new Error(`${startLabel} cannot be empty`);
  return value;
}

function parseFrameBinding(lines, label) {
  const line = lines.find((value) => value.trim().startsWith(`${label}：`) || value.trim().startsWith(`${label}:`));
  if (!line) throw new Error(`Prompt section is missing ${label}`);
  const value = line.replace(/^.*?(?:：|:)\s*/, "").trim();
  if (!value) throw new Error(`${label} binding cannot be empty`);
  return value;
}

function parseDuration(lines) {
  const line = lines.find((value) => value.includes("建议时长"));
  const match = line && line.match(/([0-9]+(?:\.[0-9]+)?)\s*秒/u);
  if (!match) throw new Error("Prompt section must declare a duration in seconds");
  const duration = Number(match[1]);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Prompt duration must be positive");
  return duration;
}

function replacePromptTokens(prompt, { petType = "狗" } = {}) {
  const species = petType === "猫" ? "猫" : petType === "狗" ? "狗" : requiredString(petType, "petType");
  return requiredString(prompt, "Prompt")
    .replaceAll("{{pet_type}}", species)
    .replaceAll("@front", "the approved front awake identity master image")
    .replaceAll("@side", "the approved side or 45-degree awake identity master image")
    .replaceAll("@long", "the approved awake master image")
    .replaceAll("@sleep", "the approved sleeping master image");
}

function parseImageSection(section, kind) {
  const prompt = captureBetween(section.lines, "正向提示词", "反向提示词");
  const negativePrompt = section.lines.slice(section.lines.findIndex((line) => line.trim() === "反向提示词") + 1).join("\n").trim();
  if (!negativePrompt) throw new Error(`${kind} image negative prompt cannot be empty`);
  return { kind, title: section.heading, prompt, negativePrompt };
}

function parseVideoSection(section) {
  const actionMatch = section.heading.match(/\(([^)]+)\)/u);
  if (!actionMatch) throw new Error(`Video section ${section.heading} must declare an action ID`);
  const sourceActionId = actionMatch[1].trim();
  const actionId = ACTION_ID_ALIASES[sourceActionId];
  if (!actionId) throw new Error(`Unsupported action ID in prompt file: ${sourceActionId}`);
  const prompt = captureBetween(section.lines, "正向提示词", "反向提示词");
  const negativePrompt = section.lines.slice(section.lines.findIndex((line) => line.trim() === "反向提示词") + 1).join("\n").trim();
  if (!negativePrompt) throw new Error(`${actionId} negative prompt cannot be empty`);
  const firstFrame = parseFrameBinding(section.lines, "首帧");
  const lastFrame = parseFrameBinding(section.lines, "尾帧");
  const duration = parseDuration(section.lines);
  const expectedModes = ACTION_FRAME_MODES[actionId];
  const expectedFirst = firstFrame.includes("sleep") ? "sleep" : "awake";
  const expectedLast = lastFrame.includes("sleep") ? "sleep" : "awake";
  if (!expectedModes || expectedModes[0] !== expectedFirst || expectedModes[1] !== expectedLast) {
    throw new Error(`${actionId} first/last frame binding does not match the client action catalog`);
  }
  return { actionId, sourceActionId, title: section.heading, prompt, negativePrompt, firstFrame, lastFrame, duration, resolution: "480p" };
}

function parsePetPackPromptFile(text) {
  const sections = sectionize(text);
  if (sections.length !== 10) throw new Error(`Prompt file must contain exactly 10 sections (3 images + 7 videos), found ${sections.length}`);
  const imageSections = [
    parseImageSection(sections[0], "front"),
    parseImageSection(sections[1], "side"),
    parseImageSection(sections[2], "sleep")
  ];
  const videos = sections.slice(3).map(parseVideoSection);
  const expected = ["idle", "sleep-transition", "sleep-loop", "stretch", "sneeze", "roll", "hover-attention"];
  const actual = videos.map((video) => video.actionId);
  if (new Set(actual).size !== expected.length || expected.some((id) => !actual.includes(id))) {
    throw new Error(`Prompt file must cover the seven client actions exactly once; found ${actual.join(", ")}`);
  }
  return { images: imageSections, videos };
}

function parsePetPackPromptFileFromPath(filePath, options = {}) {
  return parsePetPackPromptFile(readPromptFile(filePath, options));
}

module.exports = { ACTION_FRAME_MODES, ACTION_ID_ALIASES, parsePetPackPromptFile, parsePetPackPromptFileFromPath, readPromptFile, replacePromptTokens };
