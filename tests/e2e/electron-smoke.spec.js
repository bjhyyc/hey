const { spawnSync } = require("child_process");
const { test, expect } = require("@playwright/test");

const smokeScript = `
const { _electron: electron } = require("@playwright/test");

(async () => {
  let app;

  try {
    app = await electron.launch({ args: ["."] });
    const window = await app.firstWindow();
    await window.locator("#pet-root").waitFor({ state: "visible", timeout: 10000 });
    await app.close();
  } catch (error) {
    if (app) {
      try {
        await app.close();
      } catch (_) {}
    }

    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
})();
`;

function cleanOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

test("launches the pet window and renders the pet root", async () => {
  const result = spawnSync(process.execPath, ["-e", smokeScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env
  });
  const output = cleanOutput(result);

  if (process.env.DESKTOP_PET_SKIP_ELECTRON_SMOKE === "1" && /Process failed to launch!/i.test(output)) {
    const reason = `Electron could not launch in this environment:\n${output}`;
    console.warn(reason);
    test.skip(true, reason);
  }

  expect(result.status, output || `Electron smoke exited with ${result.status}`).toBe(0);
});
