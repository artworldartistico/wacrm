import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// Gemini generateContent REST endpoint (v1beta).
// Docs: https://ai.google.dev/api/generate-content
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { message?: string; code?: number; status?: string }
}

/**
 * Call Google Gemini's generateContent endpoint with the caller's own key.
 * Follows the same fetch-based pattern as the OpenAI and Anthropic adapters —
 * no SDK dependency. Returns raw assistant text + token usage.
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`

  // Gemini uses a "contents" array with role "user"/"model" (not "assistant").
  const merged = mergeConsecutive(messages)
  const contents = merged.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: systemPrompt
          ? { parts: [{ text: systemPrompt }] }
          : undefined,
        contents,
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null

  if (!res.ok) {
    const detail = data?.error?.message ?? ''
    const { status } = res
    const code =
      status === 400 && detail.toLowerCase().includes('api key')
        ? 'invalid_key'
        : status === 401 || status === 403
          ? 'invalid_key'
          : status === 429
            ? 'rate_limited'
            : 'provider_error'
    const base =
      code === 'invalid_key'
        ? 'Google Gemini rejected the API key'
        : code === 'rate_limited'
          ? 'Google Gemini rate limit reached'
          : `Google Gemini API error (${status})`
    throw new AiError(detail ? `${base}: ${detail}` : base, {
      code,
      status: code === 'invalid_key' ? 401 : 502,
    })
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim()

  if (!text) {
    throw new AiError('Google Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }

  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })

  return { text, usage }
}
