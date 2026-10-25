// 输入上限: a per-user cap on how big one request's input may be, so a runaway context (hundreds of
// thousands of tokens) is stopped before it reaches an account. The size is estimated locally from the
// request body: CJK characters count as one token each, other text as one per four characters.
// Inline images / files and thought signatures are skipped; they are not prompt text.

const SKIP = new Set(['data', 'thoughtSignature', 'thought_signature', 'signature', 'encrypted_content']);
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;

function textTokens(s: string): number {
  const cjk = s.match(CJK)?.length || 0;
  return cjk + (s.length - cjk) / 4;
}

/** Estimated input tokens of a parsed request body (OpenAI, Anthropic or Gemini shape). */
export function estimateInput(body: unknown): number {
  let n = 0;
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string') {
      if (SKIP.has(key) || v.startsWith('data:')) return;
      n += textTokens(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(body, '');
  return Math.round(n);
}

/** "380000" -> "38 万" */
export const wan = (n: number) => (n >= 10000 ? `${Math.round(n / 1000) / 10} 万` : String(n));
