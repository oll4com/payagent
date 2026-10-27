import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAgent } from '../src/agent.js';
import { setup } from './helpers.js';

test('the agent sends the brevity instruction and reasoning effort, and returns the reported tokens', async (t) => {
  let seen;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { auth: req.headers.authorization, path: req.url, body: JSON.parse(body) };
      res.end(JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 } }));
    });
  }).listen(0);
  t.after(() => server.close());
  const agent = createAgent({ AGENT_API_URL: `http://127.0.0.1:${server.address().port}/v1/`, AGENT_API_KEY: 'k', AGENT_MODEL: 'm', AGENT_REASONING_EFFORT: 'low' });
  assert.deepEqual(await agent('task'), { text: 'done', tokens: 100 });
  assert.equal(seen.path, '/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer k');
  assert.equal(seen.body.reasoning_effort, 'low');
  assert.match(seen.body.messages[0].content, /never over 600 words/);
  assert.equal(createAgent({ AGENT_MODE: 'echo' }) instanceof Function, true);
});

test('the daily token budget refuses new tasks once used up, and the tokens are kept on the task and in the audit', async () => {
  const { service, audit } = setup({ agent: async () => ({ text: 'ok', tokens: 1000 }), env: { AGENT_DAILY_TOKENS: '1500' } });
  const first = await service.submit({ description: 'one', priceSats: 2000 });
  assert.equal(first.agentTokens, 1000);
  assert.equal((await service.submit({ description: 'two', priceSats: 2000 })).status, 'AWAITING_PAYMENT');
  await assert.rejects(service.submit({ description: 'three', priceSats: 2000 }), (e) => e.status === 503 && /budget for today/.test(e.message));
  const held = await service.submit({ description: 'big', priceSats: 100_000 }).catch((e) => e);
  assert.equal(held.status, 'NEEDS_APPROVAL', 'a task held for review is still recorded');
  await assert.rejects(service.review(held.id, true, 'owner'), /budget for today/);
  assert.ok(audit.read().some((e) => e.tokens === 1000));
});
