import { logger } from '@librechat/data-schemas';

/**
 * Discovers the context window an Ollama server is *actually* serving, rather
 * than the one a model's name implies.
 *
 * The two routinely differ by an order of magnitude and nothing surfaces it.
 * Ollama serves every model at a 4096-token default unless the operator sets
 * `OLLAMA_CONTEXT_LENGTH` (or bakes `num_ctx` into a Modelfile), while
 * LibreChat budgets from the model's architectural context - 40960 for
 * `qwen3-14b`. The result is a ~35k-token prompt sent to a 4096-token window,
 * which Ollama truncates from the left, silently, dropping the system prompt
 * and the user's actual question. A reasoning model handed that thinks
 * indefinitely and never emits content, which reads as a frozen chat.
 *
 * `num_ctx` cannot be negotiated per request: Ollama's OpenAI-compatible
 * `/v1/chat/completions` ignores it both top-level and nested under
 * `options` (verified against Ollama 0.18.2), so the only way to know is to
 * ask the native API.
 */

/** `/api/ps` reports the context a model is loaded with - the one number that
 *  reflects `OLLAMA_CONTEXT_LENGTH`, Modelfile params, and defaults all at
 *  once. It only lists *loaded* models, so this returns null until the model
 *  has served at least one request; callers fall back to their existing
 *  estimate until then. */
interface OllamaRunningModel {
  name?: string;
  model?: string;
  context_length?: number;
}

/** Long enough that a busy conversation never re-probes mid-run, short enough
 *  that restarting Ollama with a new `OLLAMA_CONTEXT_LENGTH` is picked up
 *  without restarting LibreChat. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2000;

/** A cold model has to be read off disk into VRAM before `/api/ps` can report
 *  anything, which for a quantized 14B is tens of seconds. Worth waiting for:
 *  the request that triggered this probe is about to load the very same model
 *  anyway, so this moves that cost earlier rather than adding it. Past the
 *  timeout the probe gives up and the caller keeps its existing estimate. */
const WARMUP_TIMEOUT_MS = 60_000;

const cache = new Map<string, { contextLength: number | null; expiresAt: number }>();

/** Ollama's default listening port, as it appears in a `baseURL`. Matched
 *  alongside the endpoint name because an admin is free to call the endpoint
 *  anything - the port is the part that stays put. */
const OLLAMA_DEFAULT_PORT = ':11434';

export function isOllamaTarget(baseURL?: string | null, endpointName?: string | null): boolean {
  for (const value of [baseURL, endpointName]) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.toLowerCase();
    if (normalized.includes('ollama') || normalized.includes(OLLAMA_DEFAULT_PORT)) {
      return true;
    }
  }
  return false;
}

/** The OpenAI-compatible base (`http://host:11434/v1/`) with the compat
 *  suffix removed, since the context data only exists on the native API. */
export function toNativeOllamaRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/**
 * The context length this Ollama server has the model loaded with, or `null`
 * when it cannot be determined - the model isn't loaded yet, the server is
 * unreachable, or the response is shaped unexpectedly.
 *
 * Never throws and never blocks a run for long: a probe failure means the
 * caller keeps whatever estimate it already had, which is exactly the
 * behavior that existed before this function.
 */
export async function resolveOllamaContextLength(
  baseURL: string | undefined | null,
  model: string | undefined | null,
): Promise<number | null> {
  if (!baseURL || !model) {
    return null;
  }

  const root = toNativeOllamaRoot(baseURL);
  const cacheKey = `${root}::${model}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.contextLength;
  }

  let contextLength: number | null = null;
  try {
    contextLength = await readLoadedContextLength(root, model);
    if (contextLength == null) {
      // Not resident yet. `/api/ps` only lists loaded models, and a cold
      // model is precisely the case that used to fall through to the
      // name-derived guess - i.e. the broken one. An empty-prompt generate
      // loads the model without producing tokens; the request that
      // triggered this probe was about to load it regardless.
      await loadModel(root, model);
      contextLength = await readLoadedContextLength(root, model);
    }
  } catch (error) {
    logger.debug(
      `[ollama] Could not probe context length at ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  cache.set(cacheKey, { contextLength, expiresAt: Date.now() + CACHE_TTL_MS });
  return contextLength;
}

/** The context a model is loaded with right now, or `null` if it isn't. */
async function readLoadedContextLength(root: string, model: string): Promise<number | null> {
  const response = await fetch(`${root}/api/ps`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { models?: OllamaRunningModel[] };
  const running = (body.models ?? []).find(
    (entry) => entry.model === model || entry.name === model,
  );
  return typeof running?.context_length === 'number' && running.context_length > 0
    ? running.context_length
    : null;
}

/** Resident-loads a model without generating anything. Ollama treats an empty
 *  prompt as a load-only request and returns once the model is in memory. */
async function loadModel(root: string, model: string): Promise<void> {
  await fetch(`${root}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false }),
    signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
  });
}

/**
 * Reconciles what Ollama serves with what the model's name implies, and says
 * so when they disagree badly enough to truncate prompts.
 *
 * Returns the value to budget with. The served window always wins when it is
 * smaller - budgeting above it is what causes silent truncation - but an
 * operator's explicit `maxContextTokens` is handled upstream and never
 * reaches here.
 */
export function reconcileOllamaContext({
  servedContextLength,
  estimatedContextTokens,
  model,
}: {
  servedContextLength: number | null;
  estimatedContextTokens?: number | null;
  model?: string | null;
}): number | undefined {
  if (servedContextLength == null) {
    return undefined;
  }
  if (estimatedContextTokens != null && estimatedContextTokens > servedContextLength) {
    logger.warn(
      `[ollama] ${model ?? 'model'} is loaded with a ${servedContextLength}-token context but ` +
        `its name implies ${estimatedContextTokens}. Budgeting to ${servedContextLength} so ` +
        `prompts are not silently truncated. Raise OLLAMA_CONTEXT_LENGTH on the Ollama server ` +
        `(num_ctx cannot be set per request over the OpenAI-compatible API) to use more.`,
    );
  }
  return servedContextLength;
}
