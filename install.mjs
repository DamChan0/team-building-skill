import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const skillRoot = dirname(fileURLToPath(import.meta.url));

const COMMAND_NAME = "team-building.md";
const COMMAND_MARKER = "<!-- team-building native command -->";

function nativeCommandsDir() {
  const requestedProfile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
  const profile = requestedProfile && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(requestedProfile) ? requestedProfile : null;
  return join(homedir(), process.env.PI_CONFIG_DIR || ".omp", ...(profile ? ["profiles", profile] : []), "agent", "commands");
}

function nativeCommand() {
  return `---
description: Persistent worker team commands.
argument-hint: init claude --member 3 | init gpt | member 4 | status | clear | assign --worker w1 <task>
---
${COMMAND_MARKER}
Read and follow the canonical team-building skill at \`${join(skillRoot, "SKILL.md")}\` first. Process these forwarded team-building arguments as the user request: $ARGUMENTS
`;
}

async function installNativeCommand() {
  const target = join(nativeCommandsDir(), COMMAND_NAME);
  const content = nativeCommand();
  let existing = null;
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing === content) return;
  if (existing !== null && !existing.includes(COMMAND_MARKER)) {
    console.warn(`team-building: leaving user-owned /team-building command at ${target}`);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  console.log(`team-building: installed /team-building command at ${target}`);
}

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
  const supervisor = await run("cargo", ["build", "--release", "--locked"], {
    cwd: join(skillRoot, "supervisor"),
    stdio: "inherit",
  });
  if (supervisor.code !== 0) {
    process.exitCode = supervisor.code ?? 1;
    return;
  }
  await installNativeCommand();

  try {
    const omp = await run("omp", ["--version"], { stdio: "ignore" });
    if (omp.code === 0) return;
  } catch {
    // The install remains useful: OMP will discover the command after it is installed.
  }
  console.warn("OMP was not found on PATH. This skill defaults to OMP.");
  console.warn("Install OMP on Linux/macOS: curl -fsSL https://omp.sh/install | sh");
  console.warn("Quickstart: https://omp.sh/docs/quickstart");
}

main().catch((error) => {
  console.error(`Failed to set up team-building: ${error.message}`);
  process.exitCode = 1;
});
