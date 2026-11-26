import OpenAI from 'openai';
import { SYSTEM_PROMPT, buildUserPrompt, renderPrompt, responseSchema } from '../prompt.js';
import type { ExtractionRequest, ExtractionResult, LlmProvider } from '../types.js';
import { LlmError, parseLlmFields } from '../types.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

/** OpenAI Chat Completions with a strict JSON schema response format. */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_OPENAI_MODEL,
    timeoutMs = 120_000,
  ) {
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 2 });
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const prompt = renderPrompt(req.docType, req.fields, req.text);
    let rawText = '';
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(req.docType, req.fields, req.text) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'extraction',
              strict: true,
              schema: responseSchema(req.fields) as unknown as Record<string, unknown>,
            },
          },
        },
        { signal: req.signal },
      );
      const choice = completion.choices[0];
      rawText = choice?.message?.content ?? '';
      if (choice?.message?.refusal) throw new LlmError(`Model refused: ${choice.message.refusal}`, rawText, prompt);
      if (choice?.finish_reason === 'length') throw new LlmError('Model response was truncated', rawText, prompt);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new LlmError('Model returned invalid JSON', rawText, prompt);
      }
      return { fields: parseLlmFields(parsed, rawText), prompt, rawResponse: rawText, provider: this.name, model: completion.model };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      const msg = err instanceof OpenAI.APIError ? `OpenAI API error ${err.status ?? ''}: ${err.message}` : String(err);
      throw new LlmError(msg, rawText || null, prompt);
    }
  }
}
