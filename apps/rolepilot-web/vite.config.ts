import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = dirname(fileURLToPath(import.meta.url));
const workbenchRoot = resolve(webRoot, "../../packages/resume-workbench");
const workbenchBuildScript = resolve(workbenchRoot, "scripts/build.mjs");
const watchedWorkbenchRoots = [
  resolve(workbenchRoot, "src"),
  resolve(workbenchRoot, "fixtures"),
];

function buildWorkbench(): void {
  const result = spawnSync(process.execPath, [workbenchBuildScript], {
    cwd: workbenchRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`resume-workbench build failed with status ${result.status ?? "unknown"}.`);
  }
}

function isWithin(directory: string, file: string): boolean {
  const pathFromDirectory = relative(directory, file);
  return pathFromDirectory === ""
    || (!pathFromDirectory.startsWith("..") && !pathFromDirectory.startsWith("/"));
}

function workbenchPlugin(): Plugin {
  let prepared = false;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    name: "rolepilot-resume-workbench",
    config() {
      if (!prepared) {
        buildWorkbench();
        prepared = true;
      }
    },
    configureServer(server) {
      server.watcher.add(watchedWorkbenchRoots);

      const scheduleRebuild = (file: string) => {
        if (!watchedWorkbenchRoots.some((directory) => isWithin(directory, file))) return;
        if (rebuildTimer) clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
          try {
            buildWorkbench();
            server.ws.send({ type: "full-reload" });
          } catch (error) {
            server.config.logger.error(
              error instanceof Error ? error.message : String(error),
            );
          }
        }, 50);
      };

      server.watcher.on("change", scheduleRebuild);
      server.watcher.on("add", scheduleRebuild);
      server.watcher.on("unlink", scheduleRebuild);

      return () => {
        if (rebuildTimer) clearTimeout(rebuildTimer);
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), workbenchPlugin()],
  resolve: {
    alias: {
      "web-contracts/resume-document": resolve(webRoot, "../../packages/web-contracts/src/resume-document.ts"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(webRoot, "index.html"),
        workbench: resolve(webRoot, "workbench/index.html"),
      },
    },
  },
  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4173),
    strictPort: true,
    proxy: { "/api": { target: process.env.ROLEPILOT_API_TARGET ?? "http://127.0.0.1:4174", changeOrigin: true } },
  },
  preview: {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4173),
    strictPort: true,
    proxy: { "/api": { target: process.env.ROLEPILOT_API_TARGET ?? "http://127.0.0.1:4174", changeOrigin: true } },
  },
});
