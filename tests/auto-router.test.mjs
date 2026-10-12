import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const gptModels = [
  ['gpt-5.6-luna', ['low', 'max']],
  ['gpt-5.6-terra', ['low', 'medium']],
  ['gpt-5.6-sol', ['low', 'high']],
  ['gpt-6-astra', ['low', 'high', 'max']],
].map(([id, thinking]) => ({ id, provider: 'openai-codex', selector: `openai-codex/${id}`, thinking }));
const claudeModels = [
  ['claude-haiku-4-5', ['minimal', 'low']],
  ['claude-sonnet-5-5', ['low', 'high']],
  ['claude-opus-5-5', ['low', 'high', 'xhigh', 'max']],
].map(([id, thinking]) => ({ id, provider: 'anthropic', selector: `anthropic/${id}`, thinking }));

async function fixture(fn) {
  const home = await mkdtemp(join(tmpdir(), 'team-auto-router-'));
  const bin = join(home, 'bin');
  const events = join(home, 'events.jsonl');
  try {
    await mkdir(bin);
    await writeFile(events, '');
    await writeFile(join(bin, 'omp'), `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
const a = process.argv.slice(2);
await appendFile(process.env.ROUTER_EVENTS, JSON.stringify({ type: 'omp', args: a }) + '\\n');
if (a[0] === '--version') console.log('omp');
else if (a[0] === 'config') console.log('yolo');
else if (a[0] === 'models' && a[1] === 'refresh') console.log('refreshed');
else if (a[0] === 'models') console.log(JSON.stringify({ models: a[1] === 'anthropic' ? ${JSON.stringify(claudeModels)} : ${JSON.stringify(gptModels)} }));
else if (a[0] === '-p') {
  if (['switch-family', 'switch-thinking'].includes(process.env.CLASSIFIER_MODE)) {
    const path = process.env.ROUTER_RESULTS.replace(/results$/, 'team.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (process.env.CLASSIFIER_MODE === 'switch-family') state.router.family = 'claude';
    else state.router.models.extreme.thinking = 'low';
    await writeFile(path, JSON.stringify(state));
  }
  if (process.env.CLASSIFIER_MODE === 'bad') console.log('not json');
  else if (process.env.CLASSIFIER_MODE === 'fail') process.exit(9);
  else console.log(JSON.stringify({ intent: 'implement requested change', difficulty: process.env.CLASSIFIER_DIFFICULTY || 'simple', model: 'attacker supplied' }));
} else console.log('ok');
`);
    await writeFile(join(bin, 'orca-ide'), `#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
const a = process.argv.slice(2, -1);
await appendFile(process.env.ROUTER_EVENTS, JSON.stringify({ type: 'orca', args: a }) + '\\n');
let result = {};
if (a[0] === 'status') result = { app: { running: true }, runtime: { reachable: true } };
else if (a[0] === 'worktree' && a[1] === 'current') result = { worktree: { path: process.env.ROUTER_HOME } };
else if (a[0] === 'terminal' && a[1] === 'create') result = { terminal: { handle: 'worker-terminal' } };
else if (a[0] === 'terminal' && a[1] === 'show') result = { terminal: { handle: 'worker-terminal', connected: true, writable: true, exited: false } };
else if (a[0] === 'terminal' && a[1] === 'list') result = { terminals: [{ handle: 'worker-terminal', ptyId: null, tabId: null, leafId: null, connected: true, writable: true, exited: false, worktreePath: process.env.ROUTER_HOME }], truncated: false };
else if (a[0] === 'terminal' && a[1] === 'send') {
  const task = a[a.indexOf('--text') + 1].match(/Assignment (t\\d+)/)[1];
  await writeFile(process.env.ROUTER_RESULTS + '/' + task + '.json', JSON.stringify({ status: 'succeeded', summary: 'worker received brief' }));
}
console.log(JSON.stringify({ ok: true, result }));
`);
    await Promise.all(['omp', 'orca-ide'].map(name => chmod(join(bin, name), 0o755)));
    const run = (args, env = {}) => spawnSync(process.execPath, [helper, ...args], {
      cwd: home, encoding: 'utf8', timeout: 40_000,
      env: {
        ...process.env, ...env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
        ORCA_CLI_COMMAND: join(bin, 'orca-ide'), ROUTER_EVENTS: events, ROUTER_HOME: home,
        ROUTER_RESULTS: join(home, '.local/state/team-building', (env.team || ''), 'results'),
      },
    });
    const teamDir = async () => {
      const root = join(home, '.local/state/team-building');
      const team = (await readdir(root)).find(name => name.startsWith('tb-'));
      return join(root, team);
    };
    const calls = async () => (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    await fn({ home, run, teamDir, calls });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('plain init pins the current GPT routing catalog', async () => fixture(async ({ run, teamDir, calls }) => {
  const result = run(['init', '--member', '1']);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(await readFile(join(await teamDir(), 'team.json'), 'utf8'));
  assert.equal(saved.model, null);
  assert.equal(saved.router.family, 'gpt');
  assert.equal(saved.router.models.simple.model, 'openai-codex/gpt-5.6-luna');
  assert.equal((await calls()).filter(call => call.type === 'omp' && call.args.slice(0, 2).join(' ') === 'models refresh').length, 1);
}));

test('positional Claude selects family routing and persists the Sonnet worker baseline without tabs', async () => fixture(async ({ run, teamDir, calls }) => {
  const result = run(['init', 'claude', '--member', '1']);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(await readFile(join(await teamDir(), 'team.json'), 'utf8'));
  assert.equal(saved.model, null);
  assert.equal(saved.router.family, 'claude');
  assert.equal(saved.workers.w1.model, 'anthropic/claude-sonnet-5-5');
  assert.equal((await calls()).filter(call => call.type === 'orca' && call.args.slice(0, 2).join(' ') === 'terminal create').length, 0);
}));

test('init rejects a positional family paired with a conflicting model', async () => fixture(async ({ run }) => {
  const result = run(['init', 'claude', '--model', 'gpt', '--member', '1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicting/i);
}));

test('a simple Claude assignment uses the Sonnet worker route', async () => fixture(async ({ run, teamDir, calls }) => {
  assert.equal(run(['init', 'claude', '--member', '1']).status, 0);
  const team = (await teamDir()).split('/').at(-1);
  assert.equal(run(['assign', '--team', team, '--worker', 'w1', 'Simple work'], { team, CLASSIFIER_DIFFICULTY: 'simple' }).status, 0);
  const created = (await calls()).find(call => call.type === 'orca' && call.args.slice(0, 2).join(' ') === 'terminal create');
  assert.match(created.args.join(' '), /anthropic\/claude-sonnet-5-5/);
}));

test('automatic assignment classifies once and reuses its worker terminal', async () => fixture(async ({ run, teamDir, calls }) => {
  assert.equal(run(['init', '--member', '1']).status, 0);
  const team = (await teamDir()).split('/').at(-1);
  const first = run(['assign', '--team', team, '--worker', 'w1', 'Keep this original brief exactly.'], { team });
  assert.equal(first.status, 0, first.stderr);
  const second = run(['assign', '--team', team, '--worker', 'w1', 'Follow up.'], { team });
  assert.equal(second.status, 0, second.stderr);
  const recorded = await calls();
  assert.equal(recorded.filter(call => call.type === 'omp' && call.args[0] === '-p').length, 2);
  assert.equal(recorded.filter(call => call.type === 'orca' && call.args.slice(0, 2).join(' ') === 'terminal create').length, 1);
  assert.match(recorded.find(call => call.type === 'orca' && call.args.slice(0, 2).join(' ') === 'terminal create').args.join(' '), /gpt-5\.6-luna/);
}));

test('explicit difficulty and manual model skip classification', async () => fixture(async ({ run, teamDir, calls }) => {
  assert.equal(run(['init', '--member', '2']).status, 0);
  const team = (await teamDir()).split('/').at(-1);
  assert.equal(run(['assign', '--team', team, '--worker', 'w1', '--difficulty', 'complex', 'Known hard work'], { team }).status, 0);
  assert.equal(run(['assign', '--team', team, '--worker', 'w2', '--model', 'openai-codex/custom', 'Manual work'], { team }).status, 0);
  const recorded = await calls();
  assert.equal(recorded.filter(call => call.type === 'omp' && call.args[0] === '-p').length, 0);
  assert.match(recorded.find(call => call.type === 'orca' && call.args.slice(0, 2).join(' ') === 'terminal create' && call.args.join(' ').includes('openai-codex/custom')).args.join(' '), /openai-codex\/custom/);
}));

test('invalid or failed classification starts no worker terminal', async () => {
  for (const classifierMode of ['bad', 'fail']) await fixture(async ({ run, teamDir, calls }) => {
    assert.equal(run(['init', '--member', '1']).status, 0);
    const team = (await teamDir()).split('/').at(-1);
    const result = run(['assign', '--team', team, '--worker', 'w1', 'Route this'], { team, CLASSIFIER_MODE: classifierMode });
    assert.notEqual(result.status, 0);
    assert.equal((await calls()).filter(call => call.type === 'orca' && ['create', 'send'].includes(call.args[1])).length, 0);
  });
});


test('a busy team cannot switch routing families or replace its pinned worker session', async () => fixture(async ({ run, teamDir }) => {
  assert.equal(run(['init', '--member', '1']).status, 0);
  const dir = await teamDir();
  const saved = JSON.parse(await readFile(join(dir, 'team.json'), 'utf8'));
  Object.assign(saved.workers.w1, { state: 'busy', session_id: 'saved-session', session_file: '/saved/session.jsonl' });
  await writeFile(join(dir, 'team.json'), JSON.stringify(saved));
  const result = run(['init', '--team', saved.id, '--model', 'claude']);
  assert.notEqual(result.status, 0);
  const rejected = JSON.parse(await readFile(join(dir, 'team.json'), 'utf8'));
  assert.equal(rejected.router.family, 'gpt');
  assert.equal(rejected.workers.w1.session_id, 'saved-session');
}));

test('adopting a routed family refreshes its catalog without replacing a pinned session', async () => fixture(async ({ run, teamDir, calls }) => {
  assert.equal(run(['init', '--model', 'claude', '--member', '1']).status, 0);
  const dir = await teamDir();
  const saved = JSON.parse(await readFile(join(dir, 'team.json'), 'utf8'));
  saved.workers.w1.session_id = 'saved-session';
  saved.workers.w1.session_file = '/saved/session.jsonl';
  saved.workers.w1.terminal = 'saved-terminal';
  await writeFile(join(dir, 'team.json'), JSON.stringify(saved));
  const before = (await calls()).length;
  assert.equal(run(['init', '--team', saved.id, '--model', 'claude']).status, 0);
  const adopted = JSON.parse(await readFile(join(dir, 'team.json'), 'utf8'));
  assert.equal(adopted.workers.w1.session_id, 'saved-session');
  assert.equal(adopted.workers.w1.terminal, 'saved-terminal');
  assert.equal(adopted.model, null);
  assert.equal(adopted.workers.w1.model, 'anthropic/claude-sonnet-5-5');
  assert.equal(run(['init', '--team', saved.id, '--member', '2']).status, 0);
  assert.equal(JSON.parse(await readFile(join(dir, 'team.json'), 'utf8')).workers.w2.model, 'anthropic/claude-sonnet-5-5');
  assert.ok((await calls()).slice(before).some(call => call.type === 'omp' && call.args.slice(0, 2).join(' ') === 'models refresh'));
}));

test('a family or effort change during classification cannot dispatch the stale route', async () => {
  for (const mode of ['switch-family', 'switch-thinking']) await fixture(async ({ run, teamDir, calls }) => {
    assert.equal(run(['init', '--member', '1']).status, 0);
    const dir = await teamDir();
    const team = dir.split('/').at(-1);
    const result = run(['assign', '--team', team, '--worker', 'w1', 'Route this'], { team, CLASSIFIER_MODE: mode, CLASSIFIER_DIFFICULTY: 'extreme' });
    assert.match(result.stdout, /router configuration changed/);
    assert.equal((await calls()).filter(call => call.type === 'orca' && ['create', 'send'].includes(call.args[1])).length, 0);
    assert.equal(JSON.parse(await readFile(join(dir, 'team.json'), 'utf8')).next_task, 1);
  });
});
