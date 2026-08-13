const path = require("path");
const { defineConfig } = require("vite");

module.exports = defineConfig({
  base: "./",
  root: "src/renderer",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pet: path.resolve(__dirname, "src/renderer/pet/pet.html"),
        panel: path.resolve(__dirname, "src/renderer/panel/panel.html")
      }
    }
  }
});
