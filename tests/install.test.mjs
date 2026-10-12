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
  ]);
  await Promise.all(["npm", "omp"].map(name => chmod(join(bin, name), 0o755)));
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
  const command = join(home, ".omp-team", "profiles", "review", "agent", "commands", "team-building.md");
  try {
    await check({ command, run });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("re-running setup preserves other commands and the managed alias", async () => fixture(async ({ command, run }) => {
  assert.equal(run().status, 0);
  const installed = await readFile(command, "utf8");

  const other = join(command, "..", "other.md");
  await writeFile(other, "user command");
  assert.equal(run().status, 0);
  assert.equal(await readFile(command, "utf8"), installed);
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
