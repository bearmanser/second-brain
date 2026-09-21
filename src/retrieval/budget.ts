import { getEncoding } from 'js-tiktoken';
import {
  RECALL_BUDGET_TOKENS_DEFAULT,
  RECALL_BUDGET_TOKENS_MAX,
  RECALL_BUDGET_TOKENS_MIN,
  TOOL_RESULT_MAX_BYTES
} from '../core/limits.js';
import type { RecallResult } from '../core/types.js';
import type { ResultDelivery } from '../config/schema.js';
import { modelVisibleRepresentation, toolResultByteLength } from '../mcp/tools.js';

export const BUDGET_EXHAUSTED_WARNING = 'budget_exhausted';

const encoding = getEncoding('cl100k_base');

const MAX_SETTLE_ATTEMPTS = 12;
const MAX_EXCERPT_CODE_POINTS = 1100;

export function countReferenceTokens(text: string): number {
  return encoding.encode(text).length;
}

export function boundExcerpt(excerpt: string): string {
  const points = [...excerpt];
  return points.length <= MAX_EXCERPT_CODE_POINTS
    ? excerpt
    : points.slice(0, MAX_EXCERPT_CODE_POINTS).join('');
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

function settleUsed(result: RecallResult, delivery: ResultDelivery): number {
  let guess = 0;
  const visited = new Set<number>();
  for (let attempt = 0; attempt < MAX_SETTLE_ATTEMPTS; attempt += 1) {
    if (visited.has(guess)) break;
    visited.add(guess);
    result.budget.used = guess;
    const measured = countReferenceTokens(
      modelVisibleRepresentation('brain_recall', result as unknown as Record<string, unknown>, delivery)
    );
    if (measured === guess) return measured;
    guess = measured;
  }
  result.budget.used = guess;
  return guess;
}

function fits(result: RecallResult, limit: number, delivery: ResultDelivery): boolean {
  if (settleUsed(result, delivery) > limit) return false;
  return (
    toolResultByteLength(
      'brain_recall',
      result as unknown as Record<string, unknown>,
      delivery
    ) <= TOOL_RESULT_MAX_BYTES
  );
}

function trimExcerpt(excerpt: string, codePoints: number): string {
  return [...excerpt].slice(0, codePoints).join('').replace(/[ \t\n\r]+$/u, '');
}

function enforce(result: RecallResult, limit: number, delivery: ResultDelivery): void {
  if (fits(result, limit, delivery)) return;
  const all = result.items.map((item) => ({ ...item, warnings: [...item.warnings] }));
  result.items = [];
  for (let index = 0; index < all.length; index += 1) {
    const item = all[index];
    result.items.push({ ...item, warnings: [...item.warnings] });
    if (fits(result, limit, delivery)) continue;

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
      if (fits(result, limit, delivery)) {
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
  budget: number,
  delivery: ResultDelivery = 'text-json'
): RecallResult {
  const limit = clampRecallBudget(budget);
  const result: RecallResult = {
    retrieval_id: metadata.retrieval_id,
    mode: metadata.mode,
    partial: metadata.partial,
    warnings: [...metadata.warnings],
    budget: { tokenizer: 'cl100k_base', used: 0, limit },
    items: items.map((item) => ({
      ...item,
      warnings: [...item.warnings],
      excerpt: boundExcerpt(item.excerpt)
    }))
  };

  enforce(result, limit, delivery);
  const truncated =
    result.items.length !== items.length ||
    result.items.some((item, index) => item.excerpt !== items[index].excerpt);
  if (truncated) {
    if (!result.warnings.includes(BUDGET_EXHAUSTED_WARNING)) {
      result.warnings.push(BUDGET_EXHAUSTED_WARNING);
    }
    result.partial = true;
    enforce(result, limit, delivery);
  }
  result.budget.used = settleUsed(result, delivery);
  return result;
}
