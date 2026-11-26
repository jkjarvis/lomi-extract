import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserPrompt, renderPrompt, responseSchema } from '../prompt.js';
import type { ExtractionRequest, ExtractionResult, LlmProvider, ProviderOptions } from '../types.js';
import { LlmError, describeSdkError, parseLlmFields } from '../types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
/** Thinking (on by default on current models) counts against max_tokens; 4k could truncate the JSON answer. */
const MAX_TOKENS = 16_000;

/**
 * Claude via the Messages API with structured outputs (output_config.format = json_schema), so the answer is
 * schema-valid JSON. Forced tool_choice is rejected on current models, which is why this is not tool-based.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    opts: ProviderOptions = {},
  ) {
    this.client = new Anthropic({
      apiKey,
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const prompt = renderPrompt(req.docType, req.fields, req.text);
    let rawText = '';
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserPrompt(req.docType, req.fields, req.text) }],
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: responseSchema(req.fields) as unknown as Record<string, unknown> },
          },
        },
        { signal: req.signal },
      );
      rawText = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      if (response.stop_reason === 'refusal') throw new LlmError('Model refused the request', JSON.stringify(response), prompt);
      if (response.stop_reason === 'max_tokens') throw new LlmError('Model response was truncated (max_tokens)', rawText, prompt);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new LlmError('Model returned invalid JSON', rawText, prompt);
      }
      return { fields: parseLlmFields(parsed, rawText), prompt, rawResponse: rawText, provider: this.name, model: response.model };
    } catch (err) {
      // parseLlmFields does not know the prompt; attach it so a failed run still records what was asked.
      if (err instanceof LlmError) throw err.prompt ? err : new LlmError(err.message, err.rawResponse, prompt);
      throw new LlmError(describeSdkError('Anthropic', err), rawText || null, prompt);
    }
  }
}
