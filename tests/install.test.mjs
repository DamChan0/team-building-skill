import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const installer = join(root, "install.mjs");

async function fixture(check) {
  const home = await mkdtemp(join(tmpdir(), "team-building-install-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  await Promise.all([
    writeFile(join(bin, "npm"), "#!/usr/bin/env node\n"),
    writeFile(join(bin, "omp"), "#!/usr/bin/env node\nconsole.log('omp')\n"),
    writeFile(join(bin, "cargo"), "#!/usr/bin/env node\n"),
  ]);
  await Promise.all(["npm", "omp", "cargo"].map(name => chmod(join(bin, name), 0o755)));
  const run = () => spawnSync(process.execPath, [installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      PI_CONFIG_DIR: ".omp-team",
      OMP_PROFILE: "review",
    },
  });
  const agent = join(home, ".omp-team", "profiles", "review", "agent");
  const command = join(agent, "commands", "team-building.md");
  const extension = join(agent, "extensions", "team-role.ts");
  try {
    await check({ command, extension, run });
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
