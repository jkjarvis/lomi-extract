import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './providers/anthropic.js';
import { MockProvider } from './providers/mock.js';
import { DEFAULT_OPENAI_MODEL, OpenAiProvider } from './providers/openai.js';
import type { LlmProvider } from './types.js';

export * from './pdf.js';
export * from './prompt.js';
export * from './types.js';
export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './providers/anthropic.js';
export { OpenAiProvider, DEFAULT_OPENAI_MODEL } from './providers/openai.js';
export { MockProvider, mockExtract, readMockKnobs } from './providers/mock.js';

export type ProviderName = 'anthropic' | 'openai' | 'mock';

/** LLM_PROVIDER wins; otherwise the first provider with a key; otherwise the deterministic mock. */
export function resolveProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai' || explicit === 'mock') return explicit;
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'mock';
}

export function createProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const name = resolveProviderName(env);
  if (name === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
    return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL);
  }
  if (name === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is not set');
    return new OpenAiProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL);
  }
  return new MockProvider(env);
}
