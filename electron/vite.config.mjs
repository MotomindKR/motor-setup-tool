import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  plugins: [
    {
      name: "desktop-csp",
      apply: "build",
      transformIndexHtml: (html) =>
        html.replace(
          "connect-src 'self' ws://127.0.0.1:*",
          "connect-src 'none'",
        ),
    },
  ],
  build: {
    outDir: "ui-dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("commonjsHelpers")) return "react";
          if (!id.includes("/node_modules/")) return;
          if (id.includes("/node_modules/three/")) return "three";
          if (id.includes("/@motomindkr/ui/dist/components/chart."))
            return "charts";
          if (
            /\/(recharts|recharts-scale|d3-[^/]+|victory-vendor|decimal\.js-light|es-toolkit|eventemitter3|@reduxjs|react-redux|redux|reselect)\//.test(
              id,
            )
          )
            return "charts";
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return "react";
          return "ui";
        },
      },
      onwarn(warning, warn) {
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes("use client")
        )
          return;
        warn(warning);
      },
    },
  },
});
