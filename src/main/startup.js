function getLaunchAtLogin(app) {
  return Boolean(app.getLoginItemSettings().openAtLogin);
}

function setLaunchAtLogin(app, enabled) {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
}

module.exports = { getLaunchAtLogin, setLaunchAtLogin };
