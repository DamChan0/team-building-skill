import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = dirname(fileURLToPath(import.meta.url));

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = await run(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: skillRoot,
    stdio: "inherit",
  });

  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
    return;
  }

  try {
    await run("omp", ["--version"], { stdio: "ignore" });
  } catch {
    console.warn("OMP was not found on PATH. This skill defaults to OMP.");
    console.warn("Install OMP on Linux/macOS: curl -fsSL https://omp.sh/install | sh");
    console.warn("Quickstart: https://omp.sh/docs/quickstart");
  }
}

main().catch((error) => {
  console.error(`Failed to set up team-building: ${error.message}`);
  process.exitCode = 1;
});
