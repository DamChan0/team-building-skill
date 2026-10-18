import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Supervisor, supervisorBinary, supervisorPaths } from '../src/supervisor.mjs';

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));

test('observer restores its OSC title and repairs a mislabeled viewer without changing the worker session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-title-'));
  const root = join(home, "workspace's path");
  const stateRoot = join(home, '.local/state/team-building');
  const terminalState = join(home, 'terminals.json');
  const calls = join(home, 'calls.jsonl');
  const orca = join(home, 'orca-ide');
  const paths = supervisorPaths(stateRoot);
  let viewer;
  let daemon;
  try {
    await mkdir(root);
    await writeFile(orca, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2, -1);
appendFileSync(process.env.TITLE_CALLS, JSON.stringify(args) + '\\n');
const path = process.env.TITLE_STATE;
let terminals = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
let result = { app: { running: true }, runtime: { reachable: true } };
if (args[0] === 'worktree') result = { worktree: { path: ${JSON.stringify(root)} } };
if (args[0] === 'terminal' && args[1] === 'list') result = { terminals };
if (args[0] === 'terminal' && args[1] === 'create') {
  const terminal = { handle: 'viewer-' + Date.now(), connected: true, title: args[args.indexOf('--title') + 1] };
  terminals.push(terminal);
  result = { terminal };
}
if (args[0] === 'terminal' && args[1] === 'close') terminals = terminals.filter(item => item.handle !== args[args.indexOf('--terminal') + 1]);
writeFileSync(path, JSON.stringify(terminals));
console.log(JSON.stringify({ ok: true, result }));
`);
    await chmod(orca, 0o755);
    const env = { ...process.env, HERDR_ENV: '', HOME: home, ORCA_CLI_COMMAND: orca, TITLE_CALLS: calls, TITLE_STATE: terminalState };
    delete env.TEAM_BUILDING_WORKER;
    await mkdir(paths.stateDir, { recursive: true });
    daemon = spawn(supervisorBinary, ['serve', '--state-dir', paths.stateDir, '--socket', paths.socket], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      daemon.once('error', reject);
      daemon.once('exit', code => reject(new Error(`test supervisor exited: ${code}`)));
      daemon.stdout.once('data', chunk => {
        try { assert.equal(JSON.parse(chunk.toString().trim()).payload.ready, true); resolve(); }
        catch (error) { reject(error); }
      });
    });
    const run = () => spawnSync(process.execPath, [main, 'init', '--harness', 'claude', '--allow-bypass', '--member', '1'], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
    const created = run();
    assert.equal(created.status, 0, created.stderr);
    const team = (await readdir(stateRoot)).find(name => name.startsWith('tb-'));
    const teamFile = join(stateRoot, team, 'team.json');
    const original = JSON.parse(await readFile(teamFile, 'utf8')).workers.w1;
    const records = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    const create = records.find(args => args[0] === 'terminal' && args[1] === 'create');
    const title = `${team} w1 observer`;
    await writeFile(original.log, JSON.stringify({ version: 1, type: 'ui', payload: { text: 'viewer ready' } }) + '\n');
    viewer = spawn('/bin/sh', ['-c', create[create.indexOf('--command') + 1]], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`viewer output timed out: ${output}`)), 5_000);
      viewer.once('error', error => { clearTimeout(timer); reject(error); });
      viewer.once('exit', code => { clearTimeout(timer); reject(new Error(`viewer exited: ${code}`)); });
      viewer.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('viewer ready')) { clearTimeout(timer); resolve(); }
      });
    });
    assert.ok(output.startsWith(`\x1b]0;${title}\x07`), JSON.stringify(output));
    await writeFile(terminalState, JSON.stringify([{ handle: original.observer, connected: true, title: 'exec' }]));
    const repaired = run();
    assert.equal(repaired.status, 0, repaired.stderr);
    const current = JSON.parse(await readFile(teamFile, 'utf8')).workers.w1;
    assert.notEqual(current.observer, original.observer);
    assert.equal(current.session_id, original.session_id);
    assert.equal(current.session_file, original.session_file);
    const terminals = JSON.parse(await readFile(terminalState, 'utf8'));
    assert.deepEqual(terminals.map(item => item.title), [title]);
  } finally {
    if (viewer && viewer.exitCode === null) {
      const exited = new Promise(resolve => viewer.once('exit', resolve));
      viewer.kill('SIGTERM');
      await exited;
    }
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise(resolve => daemon.once('exit', resolve));
      await new Supervisor(paths).request('shutdown').catch(() => daemon.kill('SIGTERM'));
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  }
});
