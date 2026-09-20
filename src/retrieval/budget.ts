import { getEncoding } from 'js-tiktoken';
import {
  RECALL_BUDGET_TOKENS_DEFAULT,
  RECALL_BUDGET_TOKENS_MAX,
  RECALL_BUDGET_TOKENS_MIN,
  TOOL_RESULT_MAX_BYTES
} from '../core/limits.js';
import type { RecallResult } from '../core/types.js';

export const BUDGET_EXHAUSTED_WARNING = 'budget_exhausted';

const encoding = getEncoding('cl100k_base');

const MAX_SETTLE_ATTEMPTS = 12;

export function countReferenceTokens(text: string): number {
  return encoding.encode(text).length;
}

export function clampRecallBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return RECALL_BUDGET_TOKENS_DEFAULT;
  const rounded = Math.trunc(value);
  if (rounded < RECALL_BUDGET_TOKENS_MIN) return RECALL_BUDGET_TOKENS_MIN;
  if (rounded > RECALL_BUDGET_TOKENS_MAX) return RECALL_BUDGET_TOKENS_MAX;
  return rounded;
}

export interface RecallMetadata {
  retrieval_id: string;
  mode: 'hybrid' | 'text';
  partial: boolean;
  warnings: string[];
}

function settleUsed(result: RecallResult): number {
  let guess = 0;
  const visited = new Set<number>();
  for (let attempt = 0; attempt < MAX_SETTLE_ATTEMPTS; attempt += 1) {
    if (visited.has(guess)) break;
    visited.add(guess);
    result.budget.used = guess;
    const measured = countReferenceTokens(JSON.stringify(result));
    if (measured === guess) return measured;
    guess = measured;
  }
  result.budget.used = guess;
  return guess;
}

function fits(result: RecallResult, limit: number): boolean {
  if (settleUsed(result) > limit) return false;
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= TOOL_RESULT_MAX_BYTES;
}

function trimExcerpt(excerpt: string, codePoints: number): string {
  return [...excerpt].slice(0, codePoints).join('').replace(/[ \t\n\r]+$/u, '');
}

function enforce(result: RecallResult, limit: number): void {
  if (fits(result, limit)) return;
  const all = result.items.map((item) => ({ ...item, warnings: [...item.warnings] }));
  result.items = [];
  for (let index = 0; index < all.length; index += 1) {
    const item = all[index];
    result.items.push({ ...item, warnings: [...item.warnings] });
    if (fits(result, limit)) continue;

    const total = [...item.excerpt].length;
    let low = 0;
    let high = total;
    let best = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      result.items[result.items.length - 1] = {
        ...item,
        warnings: [...item.warnings],
        excerpt: trimExcerpt(item.excerpt, middle)
      };
      if (fits(result, limit)) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best >= 0) {
      result.items[result.items.length - 1] = {
        ...item,
        warnings: [...item.warnings],
        excerpt: trimExcerpt(item.excerpt, best)
      };
    } else {
      result.items.pop();
    }
    break;
  }
}

export function packRecall(
  items: RecallResult['items'],
  metadata: RecallMetadata,
  budget: number
): RecallResult {
  const limit = clampRecallBudget(budget);
  const result: RecallResult = {
    retrieval_id: metadata.retrieval_id,
    mode: metadata.mode,
    partial: metadata.partial,
    warnings: [...metadata.warnings],
    budget: { tokenizer: 'cl100k_base', used: 0, limit },
    items: items.map((item) => ({ ...item, warnings: [...item.warnings] }))
  };

  enforce(result, limit);
  const truncated =
    result.items.length !== items.length ||
    result.items.some((item, index) => item.excerpt !== items[index].excerpt);
  if (truncated) {
    if (!result.warnings.includes(BUDGET_EXHAUSTED_WARNING)) {
      result.warnings.push(BUDGET_EXHAUSTED_WARNING);
    }
    result.partial = true;
    enforce(result, limit);
  }
  result.budget.used = settleUsed(result);
  return result;
}
