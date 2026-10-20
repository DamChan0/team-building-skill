import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const installer = join(root, "install.mjs");

async function fixture(check, { piAvailable = false, piAgentOverride } = {}) {
  const home = await mkdtemp(join(tmpdir(), "team-building-install-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  await Promise.all([
    writeFile(join(bin, "npm"), "#!/usr/bin/env node\n"),
    writeFile(join(bin, "omp"), "#!/usr/bin/env node\nconsole.log('omp')\n"),
    writeFile(join(bin, "cargo"), "#!/usr/bin/env node\n"),
    writeFile(join(bin, "pi"), `#!/usr/bin/env node\nprocess.exit(${piAvailable ? 0 : 1})\n`),
  ]);
  await Promise.all(["npm", "omp", "cargo", "pi"].map(name => chmod(join(bin, name), 0o755)));
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    PI_CONFIG_DIR: ".omp-team",
    OMP_PROFILE: "review",
  };
  delete env.PI_CODING_AGENT_DIR;
  if (piAgentOverride !== undefined) env.PI_CODING_AGENT_DIR = piAgentOverride;
  const run = () => spawnSync(process.execPath, [installer], { encoding: "utf8", env });
  const agent = join(home, ".omp-team", "profiles", "review", "agent");
  const command = join(agent, "commands", "team-building.md");
  const extension = join(agent, "extensions", "team-role.ts");
  const piAgent = piAgentOverride === undefined
    ? join(home, ".pi", "agent")
    : piAgentOverride === "~"
      ? home
      : piAgentOverride.startsWith("~/")
        ? join(home, piAgentOverride.slice(2))
        : piAgentOverride;
  const piExtension = join(piAgent, "extensions", "team-role.js");
  try {
    await check({ home, command, extension, piExtension, piAgent, run });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("re-running setup preserves other commands, managed alias, and role extension", async () => fixture(async ({ command, extension, run }) => {
  assert.equal(run().status, 0);
  const installed = await readFile(command, "utf8");
  const installedExtension = await readFile(extension, "utf8");
  assert.match(installedExtension, /^\/\/ team-building managed omp extension/m);

  const other = join(command, "..", "other.md");
  await writeFile(other, "user command");
  assert.equal(run().status, 0);
  assert.equal(await readFile(command, "utf8"), installed);
  assert.equal(await readFile(extension, "utf8"), installedExtension);
  assert.equal(await readFile(other, "utf8"), "user command");
}));

test("installer leaves a conflicting user-owned alias intact", async () => fixture(async ({ command, run }) => {
  await mkdir(join(command, ".."), { recursive: true });
  await writeFile(command, "user command");
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stderr, /leaving user-owned \/team-building command/);
  assert.equal(await readFile(command, "utf8"), "user command");
}));

test("installer leaves a conflicting user-owned role extension intact", async () => fixture(async ({ extension, run }) => {
  await mkdir(join(extension, ".."), { recursive: true });
  await writeFile(extension, "user extension");
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stderr, /leaving user-owned role extension/);
  assert.equal(await readFile(extension, "utf8"), "user extension");
}));

test("Pi setup installs a working manager widget in the configured agent directory", async () => fixture(async ({ home, piAgent, piExtension, run }) => {
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);

  await mkdir(piAgent, { recursive: true });
  await writeFile(join(piAgent, "package.json"), JSON.stringify({ type: "module" }));
  const cwd = join(home, "project");
  const teamDir = join(home, ".local", "state", "team-building", "tb-pi-smoke");
  const teamFile = join(teamDir, "team.json");
  await mkdir(cwd, { recursive: true });
  await mkdir(teamDir, { recursive: true });
  await writeFile(teamFile, JSON.stringify({ cwd, manager_session: null }));

  const script = `
import { readFileSync, writeFileSync } from 'node:fs';
import extension from ${JSON.stringify(pathToFileURL(piExtension).href)};
const handlers = new Map();
const widgets = [];
extension({ on: (name, handler) => handlers.set(name, handler) });
const ctx = {
  hasUI: true,
  cwd: ${JSON.stringify(cwd)},
  sessionManager: { getSessionId: () => 'pi-smoke-session' },
  ui: { setWidget: (...args) => widgets.push(args) },
};
handlers.get('session_start')({}, ctx);
const team = JSON.parse(readFileSync(${JSON.stringify(teamFile)}, 'utf8'));
team.manager_session = 'pi-smoke-session';
writeFileSync(${JSON.stringify(teamFile)}, JSON.stringify(team));
handlers.get('agent_end')({}, ctx);
console.log(JSON.stringify(widgets));
`;
  const smoke = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(smoke.status, 0, smoke.stderr);
  const [beforeInit, afterInit] = JSON.parse(smoke.stdout);
  assert.equal(beforeInit[0], "team-role");
  assert.equal(beforeInit[1], null);
  assert.equal(afterInit[0], "team-role");
  assert.match(afterInit[1][0], /Role: manager/);
  assert.deepEqual(afterInit[2], { placement: "belowEditor" });
}, { piAvailable: true, piAgentOverride: "~/.pi-custom/agent" }));
