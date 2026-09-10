import {
  buildFreshWorkspaceDist,
  markWorkspaceDistReady,
  runPnpm,
  WORKSPACE_ROOT,
  WORKSPACE_TARGETS,
} from "./workspace-build.mjs";

const command = process.argv[2];
const forwardedArgs = process.argv.slice(3);

if (command !== "test" && command !== "check") {
  throw new Error(
    "Usage: node ./scripts/run-workspace-command.mjs <test|check> [...args]",
  );
}

if (command === "test") {
  buildFreshWorkspaceDist({ repoRoot: WORKSPACE_ROOT });
  markWorkspaceDistReady();
}

for (const target of WORKSPACE_TARGETS.filter((entry) => entry[command])) {
  runPnpm(
    ["--filter", target.name, command, ...forwardedArgs],
    WORKSPACE_ROOT,
  );
}
