const { app } = require("electron");

console.error("[electron-smoke] start");
app.whenReady().then(() => {
  console.error("[electron-smoke] ready");
  app.quit();
});
