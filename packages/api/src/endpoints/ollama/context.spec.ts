import {
  isOllamaTarget,
  toNativeOllamaRoot,
  reconcileOllamaContext,
  resolveOllamaContextLength,
} from './context';

describe('isOllamaTarget', () => {
  it('matches by endpoint name and by the default port', () => {
    expect(isOllamaTarget(undefined, 'Ollama')).toBe(true);
    expect(isOllamaTarget('http://localhost:11434/v1/', 'Local LLM')).toBe(true);
  });

  it('does not match unrelated OpenAI-compatible endpoints', () => {
    expect(isOllamaTarget('https://api.openai.com/v1', 'OpenAI')).toBe(false);
    expect(isOllamaTarget('https://ai-gateway.vercel.sh/v1', 'Vercel')).toBe(false);
  });
});

describe('toNativeOllamaRoot', () => {
  it('strips the OpenAI-compatible suffix, which the native API does not use', () => {
    expect(toNativeOllamaRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434');
    expect(toNativeOllamaRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(toNativeOllamaRoot('http://localhost:11434')).toBe('http://localhost:11434');
  });
});

describe('reconcileOllamaContext', () => {
  it('leaves the estimate alone when the server cannot be probed', () => {
    expect(
      reconcileOllamaContext({ servedContextLength: null, estimatedContextTokens: 40960 }),
    ).toBeUndefined();
  });

  it('budgets to what the server actually serves, not what the name implies', () => {
    // The exact production case: qwen3-14b implies 40960, Ollama serves 4096.
    expect(
      reconcileOllamaContext({
        servedContextLength: 4096,
        estimatedContextTokens: 40960,
        model: 'qwen3-14b-8k:latest',
      }),
    ).toBe(4096);
  });

  it('uses the served window even when it exceeds the name estimate', () => {
    expect(
      reconcileOllamaContext({ servedContextLength: 32768, estimatedContextTokens: 8192 }),
    ).toBe(32768);
  });
});

describe('resolveOllamaContextLength', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns null without a baseURL or model, probing nothing', async () => {
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;

    expect(await resolveOllamaContextLength(undefined, 'qwen3:14b')).toBeNull();
    expect(await resolveOllamaContextLength('http://localhost:11434/v1/', undefined)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('reads the loaded context from /api/ps', async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ models: [{ name: 'probe-a:latest', context_length: 16384 }] }),
        { status: 200 },
      )) as unknown as typeof fetch;

    expect(await resolveOllamaContextLength('http://probe-a:11434/v1/', 'probe-a:latest')).toBe(
      16384,
    );
  });

  it('loads a cold model, then reads its real context', async () => {
    // The cold path is the one that used to fall through to the name-derived
    // guess - i.e. the broken one. `/api/ps` lists only loaded models, so a
    // model that has idled out of VRAM must be loaded before it can answer.
    const calls: string[] = [];
    global.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/generate')) {
        return new Response('{}', { status: 200 });
      }
      const loaded = calls.some((call) => call.endsWith('/api/generate'));
      return new Response(
        JSON.stringify({
          models: loaded ? [{ name: 'probe-b:latest', context_length: 32768 }] : [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    expect(await resolveOllamaContextLength('http://probe-b:11434/v1/', 'probe-b:latest')).toBe(
      32768,
    );
    expect(calls.filter((call) => call.endsWith('/api/generate'))).toHaveLength(1);
  });

  it('returns null when even a load cannot make the model report a context', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch;

    expect(
      await resolveOllamaContextLength('http://probe-e:11434/v1/', 'probe-e:latest'),
    ).toBeNull();
  });

  it('fails open when the server is unreachable rather than breaking the run', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    expect(
      await resolveOllamaContextLength('http://probe-c:11434/v1/', 'probe-c:latest'),
    ).toBeNull();
  });

  it('caches, so a busy conversation does not re-probe per turn', async () => {
    const spy = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ models: [{ name: 'probe-d:latest', context_length: 8192 }] }),
          {
            status: 200,
          },
        ),
    );
    global.fetch = spy as unknown as typeof fetch;

    await resolveOllamaContextLength('http://probe-d:11434/v1/', 'probe-d:latest');
    await resolveOllamaContextLength('http://probe-d:11434/v1/', 'probe-d:latest');

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
