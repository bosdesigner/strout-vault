/**
 * Token estimate without a tokenizer: about four characters per token for English
 * transcript text, never below one token per word. Used for chunk sizing, batching and
 * the backfill's cost estimate (the provider's own count decides the bill).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(words, Math.ceil(text.length / 4));
}
