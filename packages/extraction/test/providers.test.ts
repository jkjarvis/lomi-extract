// The Anthropic and OpenAI providers, exercised through their real SDKs with the HTTP layer stubbed (an injected
// `fetch`). No network, no keys: we assert what goes on the wire and how every kind of answer is interpreted.
import { readFileSync } from 'node:fs';
import type { DocType, LlmField } from '@lomi/core';
import { EXPECTED_FIELDS, validateExtraction } from '@lomi/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmProvider, ProviderOptions } from '../src/index.js';
import {
  AnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  LlmError,
  MockProvider,
  OpenAiProvider,
  SYSTEM_PROMPT,
  buildUserPrompt,
  createProvider,
  pdfToText,
  renderPrompt,
} from '../src/index.js';

const FIXTURE: Record<DocType, string> = { invoice: 'invoice-001.pdf', lease: 'lease-excerpt-001.pdf', market_report: 'market-report-excerpt-001.pdf' };
const DOC_TYPES = Object.keys(FIXTURE) as DocType[];
const texts = {} as Record<DocType, string>;
/** A "good LLM" answer per doc type: the deterministic mock's fields, as a real model would return them. */
const goodAnswers = {} as Record<DocType, LlmField[]>;

beforeAll(async () => {
  for (const t of DOC_TYPES) {
    texts[t] = await pdfToText(new Uint8Array(readFileSync(new URL(`../../../fixtures/documents/${FIXTURE[t]}`, import.meta.url))));
    goodAnswers[t] = (await new MockProvider({}).extract({ docType: t, fields: EXPECTED_FIELDS[t], text: texts[t], attempt: 1 })).fields;
  }
});

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | 'hang';

/** A fetch stand-in: records each request and answers from a script (the last reply repeats). */
function stubFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (r === 'hang') {
      return new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        const fail = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        if (sig?.aborted) fail();
        sig?.addEventListener('abort', fail, { once: true });
      });
    }
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

// ---------- wire formats ----------

const anthropicMessage = (text: string | null, over: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  // Current models think by default: a (display-omitted) thinking block precedes the answer and must be ignored.
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, ...(text === null ? [] : [{ type: 'text', text }])],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
  ...over,
});

const openAiCompletion = (content: string | null, over: { finish_reason?: string; refusal?: string | null } = {}) => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4.1-mini-2025-04-14',
  choices: [
    { index: 0, message: { role: 'assistant', content, refusal: over.refusal ?? null }, finish_reason: over.finish_reason ?? 'stop', logprobs: null },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const errorBody = (type: string, message: string) => ({ type: 'error', error: { type, message } });

interface Harness {
  name: 'anthropic' | 'openai';
  make: (opts: ProviderOptions) => LlmProvider;
  ok: (text: string) => unknown;
  endpoint: RegExp;
  /** Pull (system, user, schema) out of a captured request body. */
  read: (body: Record<string, unknown>) => { model: unknown; system: string; user: string; schema: Record<string, unknown> };
}

const harnesses: Harness[] = [
  {
    name: 'anthropic',
    make: (o) => new AnthropicProvider('sk-ant-test', DEFAULT_ANTHROPIC_MODEL, { maxRetries: 0, ...o }),
    ok: (t) => anthropicMessage(t),
    endpoint: /\/v1\/messages$/,
    read: (b) => {
      const oc = b.output_config as { format: { type: string; schema: Record<string, unknown> } };
      expect(oc.format.type).toBe('json_schema');
      const msgs = b.messages as Array<{ role: string; content: string }>;
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe('user');
      return { model: b.model, system: b.system as string, user: msgs[0]!.content, schema: oc.format.schema };
    },
  },
  {
    name: 'openai',
    make: (o) => new OpenAiProvider('sk-openai-test', DEFAULT_OPENAI_MODEL, { maxRetries: 0, ...o }),
    ok: (t) => openAiCompletion(t),
    endpoint: /\/chat\/completions$/,
    read: (b) => {
      const rf = b.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
      expect(rf.type).toBe('json_schema');
      expect(rf.json_schema.strict).toBe(true);
      const msgs = b.messages as Array<{ role: string; content: string }>;
      expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
      return { model: b.model, system: msgs[0]!.content, user: msgs[1]!.content, schema: rf.json_schema.schema };
    },
  },
];

const req = (docType: DocType, signal?: AbortSignal) => ({ docType, fields: EXPECTED_FIELDS[docType], text: texts[docType], attempt: 1, signal });

describe.each(harnesses)('$name provider', (h) => {
  describe('request shape', () => {
    it.each(DOC_TYPES)('%s: model, prompts with every expected field + the document text, and a schema over exactly those fields', async (docType) => {
      const { fetch, calls } = stubFetch([{ json: h.ok(JSON.stringify({ fields: goodAnswers[docType] })) }]);
      await h.make({ fetch }).extract(req(docType));
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.url).toMatch(h.endpoint);
      const { model, system, user, schema } = h.read(call.body);
      expect(model).toBe(h.name === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);

      // The two instructions the brief hinges on: verbatim evidence, and a gap instead of a guess.
      expect(system).toBe(SYSTEM_PROMPT);
      expect(system).toMatch(/VERBATIM quote copied\s+character-for-character/);
      expect(system).toMatch(/return value null, evidence null, and a short "reason"/);
      expect(system).toMatch(/Never guess, infer, compute, or use outside knowledge/);

      expect(user).toBe(buildUserPrompt(docType, EXPECTED_FIELDS[docType], texts[docType]));
      expect(user).toContain(`Document type: ${docType}`);
      for (const f of EXPECTED_FIELDS[docType]) expect(user).toContain(`- ${f.field} (`);
      expect(user).toContain(texts[docType]);

      const items = (schema as { properties: { fields: { items: Record<string, unknown> } } }).properties.fields.items as {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
      expect((items.properties.field as { enum: string[] }).enum).toEqual(EXPECTED_FIELDS[docType].map((f) => f.field));
      expect(items.required).toEqual(['field', 'value', 'evidence', 'reason']);
      expect(items.additionalProperties).toBe(false);
      expect((schema as { additionalProperties: boolean; required: string[] }).additionalProperties).toBe(false);
      expect((schema as { required: string[] }).required).toEqual(['fields']);
      // Nullable strings use anyOf (documented by both providers), so the model can say "not found".
      for (const k of ['value', 'evidence', 'reason']) {
        expect(items.properties[k]).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
      }
    });

    it('authenticates with the API key', async () => {
      const { fetch, calls } = stubFetch([{ json: h.ok(JSON.stringify({ fields: [] })) }]);
      await h.make({ fetch }).extract(req('invoice'));
      const headers = calls[0]!.headers;
      if (h.name === 'anthropic') {
        expect(headers.get('x-api-key')).toBe('sk-ant-test');
        expect(headers.get('anthropic-version')).toBeTruthy();
      } else {
        expect(headers.get('authorization')).toBe('Bearer sk-openai-test');
      }
    });

    if (h.name === 'anthropic') {
      it('asks for low effort and leaves room for thinking + the JSON answer', async () => {
        const { fetch, calls } = stubFetch([{ json: h.ok(JSON.stringify({ fields: [] })) }]);
        await h.make({ fetch }).extract(req('lease'));
        const b = calls[0]!.body as { max_tokens: number; output_config: { effort: string } };
        expect(b.output_config.effort).toBe('low');
        expect(b.max_tokens).toBeGreaterThanOrEqual(16_000);
        expect(b).not.toHaveProperty('temperature'); // rejected by current Claude models
      });
    } else {
      it('uses temperature 0', async () => {
        const { fetch, calls } = stubFetch([{ json: h.ok(JSON.stringify({ fields: [] })) }]);
        await h.make({ fetch }).extract(req('lease'));
        expect(calls[0]!.body.temperature).toBe(0);
      });
    }
  });

  describe('response parsing', () => {
    it.each(DOC_TYPES)('%s: a valid structured answer becomes LlmField[] and validates to the contract values', async (docType) => {
      const raw = JSON.stringify({ fields: goodAnswers[docType] });
      const { fetch } = stubFetch([{ json: h.ok(raw) }]);
      const res = await h.make({ fetch }).extract(req(docType));
      expect(res.fields).toEqual(goodAnswers[docType]);
      expect(res.provider).toBe(h.name);
      expect(res.model).toBe(h.name === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4.1-mini-2025-04-14'); // as reported by the API
      // (c) the prompt and the raw response are returned for the run to store.
      expect(res.prompt).toBe(renderPrompt(docType, EXPECTED_FIELDS[docType], texts[docType]));
      expect(res.rawResponse).toBe(raw);

      const values = validateExtraction(texts[docType], EXPECTED_FIELDS[docType], res.fields);
      expect(values).toHaveLength(EXPECTED_FIELDS[docType].length);
      const gaps = values.filter((v) => v.gap).map((v) => v.field);
      expect(gaps).toEqual(docType === 'market_report' ? ['median_household_income'] : []);
    });

    it('coerces numeric values to strings and tolerates a bare array', async () => {
      const raw = JSON.stringify([{ field: 'term_months', value: 24, evidence: 'twenty-four (24) months', reason: null }]);
      const { fetch } = stubFetch([{ json: h.ok(raw) }]);
      const res = await h.make({ fetch }).extract(req('lease'));
      expect(res.fields).toEqual([{ field: 'term_months', value: '24', evidence: 'twenty-four (24) months', reason: null }]);
    });

    it('a partial answer (fields missing) parses; the missing fields become gaps, never guesses', async () => {
      const partial = goodAnswers.invoice.filter((f) => f.field === 'invoice_number' || f.field === 'total_amount');
      const { fetch } = stubFetch([{ json: h.ok(JSON.stringify({ fields: partial })) }]);
      const res = await h.make({ fetch }).extract(req('invoice'));
      const values = validateExtraction(texts.invoice, EXPECTED_FIELDS.invoice, res.fields);
      expect(values.filter((v) => v.gap?.reason === 'missing_from_response').map((v) => v.field)).toEqual(['issue_date', 'due_date', 'vendor_name']);
      expect(values.find((v) => v.field === 'total_amount')!.value).toEqual({ amount: 5230.29, currency: 'USD' });
    });

    it('a "not found" answer carries the model\'s reason into the gap', async () => {
      const raw = JSON.stringify({ fields: [{ field: 'median_household_income', value: null, evidence: null, reason: 'No income figure in the report' }] });
      const { fetch } = stubFetch([{ json: h.ok(raw) }]);
      const res = await h.make({ fetch }).extract(req('market_report'));
      const v = validateExtraction(texts.market_report, EXPECTED_FIELDS.market_report, res.fields).find((x) => x.field === 'median_household_income')!;
      expect(v.value).toBeNull();
      expect(v.gap).toEqual({ reason: 'not_found', detail: 'No income figure in the report' });
    });

    const expectLlmError = async (p: Promise<unknown>, message: RegExp, raw?: string | RegExp | null) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LlmError);
      const e = err as LlmError;
      expect(e.message).toMatch(message);
      expect(e.prompt).toMatch(/^\[system\]\n/); // the prompt travels with the error so a failed run is debuggable
      if (raw instanceof RegExp) expect(e.rawResponse).toMatch(raw);
      else if (raw !== undefined) expect(e.rawResponse).toBe(raw);
      return e;
    };

    it('malformed / truncated JSON → LlmError carrying the raw text', async () => {
      const broken = '{"fields":[{"field":"invoice_number","value":"INV-2025-0847","evid';
      const { fetch } = stubFetch([{ json: h.ok(broken) }]);
      await expectLlmError(h.make({ fetch }).extract(req('invoice')), /invalid JSON/i, broken);
    });

    it('JSON without a "fields" array → LlmError', async () => {
      const { fetch } = stubFetch([{ json: h.ok('{"result":"ok"}') }]);
      await expectLlmError(h.make({ fetch }).extract(req('invoice')), /no "fields" array/, '{"result":"ok"}');
    });

    it('an empty answer → LlmError', async () => {
      const { fetch } = stubFetch([{ json: h.name === 'anthropic' ? anthropicMessage(null) : openAiCompletion(null) }]);
      await expectLlmError(h.make({ fetch }).extract(req('invoice')), /invalid JSON/i);
    });

    if (h.name === 'anthropic') {
      it('stop_reason "refusal" → LlmError with the whole response kept', async () => {
        const msg = anthropicMessage(null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'declined' } });
        const { fetch } = stubFetch([{ json: msg }]);
        await expectLlmError(h.make({ fetch }).extract(req('invoice')), /refused/i, /"stop_reason":"refusal"/);
      });
      it('stop_reason "max_tokens" → LlmError (truncated), even if the partial text happens to parse', async () => {
        const { fetch } = stubFetch([{ json: anthropicMessage('{"fields":[]}', { stop_reason: 'max_tokens' }) }]);
        await expectLlmError(h.make({ fetch }).extract(req('invoice')), /truncated/i, '{"fields":[]}');
      });
    } else {
      it('a refusal → LlmError with the whole completion kept', async () => {
        const { fetch } = stubFetch([{ json: openAiCompletion(null, { refusal: 'I cannot help with that' }) }]);
        await expectLlmError(h.make({ fetch }).extract(req('invoice')), /refused: I cannot help with that/, /"refusal":"I cannot help with that"/);
      });
      it('finish_reason "length" → LlmError (truncated)', async () => {
        const { fetch } = stubFetch([{ json: openAiCompletion('{"fields":[', { finish_reason: 'length' }) }]);
        await expectLlmError(h.make({ fetch }).extract(req('invoice')), /truncated/i, '{"fields":[');
      });
      it('finish_reason "content_filter" → LlmError', async () => {
        const { fetch } = stubFetch([{ json: openAiCompletion('', { finish_reason: 'content_filter' }) }]);
        await expectLlmError(h.make({ fetch }).extract(req('invoice')), /content filter/i);
      });
      it('no choices → LlmError', async () => {
        const { fetch } = stubFetch([{ json: { ...openAiCompletion(''), choices: [] } }]);
        await expectLlmError(h.make({ fetch }).extract(req('invoice')), /no choices/i);
      });
    }
  });

  describe('HTTP failures become LlmError (the worker records them as a failed, retryable run)', () => {
    it('429 → LlmError naming the status', async () => {
      const { fetch, calls } = stubFetch([{ status: 429, json: errorBody('rate_limit_error', 'slow down') }]);
      await expect(h.make({ fetch }).extract(req('invoice'))).rejects.toThrow(/API error 429/);
      expect(calls).toHaveLength(1); // maxRetries 0 in this test
    });

    it('500 → LlmError naming the status', async () => {
      const { fetch } = stubFetch([{ status: 500, json: errorBody('api_error', 'boom') }]);
      const err = await h.make({ fetch }).extract(req('invoice')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as Error).message).toMatch(/API error 500/);
    });

    it('400 (e.g. a schema the API rejects) is not retried', async () => {
      const { fetch, calls } = stubFetch([{ status: 400, json: errorBody('invalid_request_error', 'bad schema') }]);
      await expect(h.make({ fetch, maxRetries: 2 }).extract(req('invoice'))).rejects.toThrow(/API error 400/);
      expect(calls).toHaveLength(1);
    });

    it('transient 429/529 are retried by the SDK and then succeed', async () => {
      const retry = { 'retry-after-ms': '1', 'retry-after': '0' };
      const { fetch, calls } = stubFetch([
        { status: 429, json: errorBody('rate_limit_error', 'slow down'), headers: retry },
        { status: h.name === 'anthropic' ? 529 : 503, json: errorBody('overloaded_error', 'busy'), headers: retry },
        { json: h.ok(JSON.stringify({ fields: goodAnswers.lease })) },
      ]);
      const res = await h.make({ fetch, maxRetries: 2 }).extract(req('lease'));
      expect(calls).toHaveLength(3);
      expect(res.fields).toEqual(goodAnswers.lease);
    });

    it('a timeout → LlmError saying it timed out', async () => {
      const { fetch } = stubFetch(['hang']);
      await expect(h.make({ fetch, timeoutMs: 50 }).extract(req('invoice'))).rejects.toThrow(/timed out/i);
    });

    it('a network failure → LlmError (connection error)', async () => {
      const fetch = (async () => {
        throw new TypeError('fetch failed');
      }) as typeof globalThis.fetch;
      const err = await h.make({ fetch }).extract(req('invoice')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as Error).message).toMatch(/connection error/i);
    });

    it('the caller\'s abort signal cancels the HTTP request', async () => {
      const { fetch } = stubFetch(['hang']);
      const ac = new AbortController();
      const p = h.make({ fetch }).extract(req('invoice', ac.signal));
      setTimeout(() => ac.abort(new Error('lease lost')), 10);
      await expect(p).rejects.toThrow(/aborted/i);
    });
  });
});

describe('createProvider', () => {
  it('builds the provider LLM_PROVIDER names, with the configured model', () => {
    const a = createProvider({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-opus-5-5' });
    expect(a).toBeInstanceOf(AnthropicProvider);
    expect(a.model).toBe('claude-opus-5-5');
    const o = createProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k' });
    expect(o).toBeInstanceOf(OpenAiProvider);
    expect(o.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(createProvider({ ANTHROPIC_API_KEY: 'k' })).toBeInstanceOf(AnthropicProvider);
    expect(createProvider({})).toBeInstanceOf(MockProvider);
  });

  it('refuses a real provider without its key (a misconfiguration, not a silent mock)', () => {
    expect(() => createProvider({ LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createProvider({ LLM_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
  });
});
