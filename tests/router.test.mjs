import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyRequest, configureRouter } from '../src/router.mjs';

const gptModels = [
  ['gpt-5.6-luna', ['low', 'max']],
  ['gpt-5.6-luna-2026-09-01', ['low', 'max']],
  ['gpt-6-luna', ['low', 'max']],
  ['gpt-5.6-terra', ['low', 'max']],
  ['gpt-5.6-terra-preview', ['low']],
  ['gpt-6-sol', ['low']],
  ['gpt-6.1-sol', ['low']],
  ['gpt-6-astra', ['low', 'max']],
];

const claudeModels = [
  ['claude-haiku-4-5', ['minimal', 'low']],
  ['claude-haiku-4-5-20260901', ['minimal']],
  ['claude-sonnet-5', ['minimal', 'high']],
  ['claude-sonnet-5-5', ['minimal', 'high']],
  ['claude-opus-5', ['minimal', 'high']],
  ['claude-opus-5-5', ['low', 'high', 'xhigh', 'max']],
];

function catalog(provider, entries) {
  return {
    models: entries.map(([id, thinking]) => ({ id, provider, selector: `${provider}/${id}`, thinking })),
  };
}

async function withFakeOmp({ openai = gptModels, anthropic = claudeModels, classifier = '{"intent":"implement","difficulty":"moderate"}' }, check) {
  const root = await mkdtemp(join(tmpdir(), 'team-router-'));
  const bin = join(root, 'bin');
  const previousPath = process.env.PATH;
  try {
    await mkdir(bin);
    await writeFile(join(bin, 'omp'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const catalogs = JSON.parse(process.env.OMP_CATALOGS);
if (args[0] === 'models' && args[1] === 'refresh') process.exit(0);
if (args[0] === 'models') {
  console.log(JSON.stringify(catalogs[args[1]]));
  process.exit(0);
}
console.log(process.env.OMP_CLASSIFIER);
`);
    await chmod(join(bin, 'omp'), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.OMP_CATALOGS = JSON.stringify({
      'openai-codex': catalog('openai-codex', openai),
      anthropic: catalog('anthropic', anthropic),
    });
    process.env.OMP_CLASSIFIER = classifier;
    await check();
  } finally {
    process.env.PATH = previousPath;
    delete process.env.OMP_CATALOGS;
    delete process.env.OMP_CLASSIFIER;
    await rm(root, { recursive: true, force: true });
  }
}

test('chooses canonical numeric latest models independently per GPT role', async () => {
  await withFakeOmp({}, async () => {
    const router = await configureRouter('gpt');
    assert.deepEqual(router.models, {
      simple: { model: 'openai-codex/gpt-6-luna', thinking: 'max' },
      moderate: { model: 'openai-codex/gpt-5.6-terra', thinking: null },
      complex: { model: 'openai-codex/gpt-6.1-sol', thinking: null },
      extreme: { model: 'openai-codex/gpt-6-astra', thinking: null },
    });
    assert.equal(router.classifier, 'openai-codex/gpt-6-luna');
    assert.equal(router.classifier_thinking, 'low');
  });
});

test('uses Haiku only for Claude classification while Sonnet handles ordinary worker routes', async () => {
  await withFakeOmp({}, async () => {
    const router = await configureRouter('claude');
    assert.deepEqual(router.models, {
      simple: { model: 'anthropic/claude-sonnet-5-5', thinking: null },
      moderate: { model: 'anthropic/claude-sonnet-5-5', thinking: null },
      complex: { model: 'anthropic/claude-opus-5-5', thinking: null },
      extreme: { model: 'anthropic/claude-opus-5-5', thinking: 'xhigh' },
    });
    assert.equal(router.worker_model, 'anthropic/claude-sonnet-5-5');
    assert.equal(router.classifier, 'anthropic/claude-haiku-4-5');
    assert.equal(router.classifier_thinking, 'minimal');
  });
});

test('fails closed when the inventory lacks a required routing role', async () => {
  await withFakeOmp({ openai: gptModels.filter(([id]) => !id.includes('terra')) }, async () => {
    await assert.rejects(configureRouter('gpt'), /missing.*moderate/i);
  });
});

test('classifies only validated JSON and cannot let model output escape the selected family', async () => {
  const prompt = `Please route this exactly: ${'x'.repeat(8192)}`;
  await withFakeOmp({ classifier: '```json\n{"intent":"add test","difficulty":"complex","model":"evil/model"}\n```' }, async () => {
    const router = await configureRouter('gpt');
    const route = await classifyRequest(router, prompt);
    assert.deepEqual(route, {
      intent: 'add test',
      difficulty: 'complex',
      router_model: 'openai-codex/gpt-6-luna',
      model: 'openai-codex/gpt-6.1-sol',
      thinking: null,
    });
  });
});

test('Claude classifier output cannot select Haiku or a foreign worker model', async () => {
  await withFakeOmp({ classifier: '{"intent":"small fix","difficulty":"simple","model":"evil/model"}' }, async () => {
    const route = await classifyRequest(await configureRouter('claude'), 'route this');
    assert.deepEqual(route, {
      intent: 'small fix',
      difficulty: 'simple',
      router_model: 'anthropic/claude-haiku-4-5',
      model: 'anthropic/claude-sonnet-5-5',
      thinking: null,
    });
  });
});

test('rejects malformed or out-of-contract classifier output without fallback', async () => {
  await withFakeOmp({ classifier: '{"intent":"","difficulty":"expert"}' }, async () => {
    const router = await configureRouter('gpt');
    await assert.rejects(classifyRequest(router, 'route this'), /classifier/i);
  });
});

test('highest difficulty selects Astra or Opus xhigh without changing ordinary routes', async () => {
  for (const family of ['gpt', 'claude']) {
    await withFakeOmp({ classifier: '{"intent":"cross-system architecture","difficulty":"extreme"}' }, async () => {
      const route = await classifyRequest(await configureRouter(family), 'Resolve an unresolved high-risk system design.');
      assert.equal(route.model, family === 'gpt' ? 'openai-codex/gpt-6-astra' : 'anthropic/claude-opus-5-5');
      assert.equal(route.thinking, family === 'claude' ? 'xhigh' : null);
    });
  }
});

test('highest Claude tier fails closed when Opus does not support xhigh', async () => {
  await withFakeOmp({ anthropic: claudeModels.map(([id, levels]) => [id, levels.filter(level => level !== 'xhigh')]) }, async () => {
    await assert.rejects(configureRouter('claude'), /xhigh/);
  });
});
