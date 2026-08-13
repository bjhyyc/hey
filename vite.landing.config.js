const { defineConfig } = require("vite");
const { resolve } = require("path");

module.exports = defineConfig({
  base: "./",
  root: "landing",
  build: {
    outDir: "../dist/pages",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "landing/index.html"),
        manual: resolve(__dirname, "landing/manual.html"),
      },
    },
  },
});
