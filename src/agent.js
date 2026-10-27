// The worker: any OpenAI-compatible chat endpoint (AGENT_API_URL, AGENT_API_KEY, AGENT_MODEL).
// AGENT_MODE=echo is for local tests only and says so in its answer.
export function createAgent(env = process.env, maxTokens = 800) {
  if (env.AGENT_MODE === 'echo') return async (description) => `[echo test agent] ${description}`;
  const { AGENT_API_URL: url, AGENT_API_KEY: key, AGENT_MODEL: model } = env;
  if (!url || !key || !model) throw new Error('set AGENT_API_URL, AGENT_API_KEY and AGENT_MODEL (or AGENT_MODE=echo for tests)');
  return async (description) => {
    const response = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: 'You complete one well-defined task for a paying customer. Answer with the finished work only.' },
          { role: 'user', content: description }
        ]
      }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`agent endpoint answered ${response.status}`);
    const text = (await response.json()).choices?.[0]?.message?.content;
    if (!text) throw new Error('agent returned no text');
    return text;
  };
}
