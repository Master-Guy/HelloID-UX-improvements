// Texts for the plans and comparisons: a short preview of a value, and a unified diff of two texts
// (scripts), truncated so an answer stays small.

import { maskForAudit } from '../audit.ts';
import { SECRET_MASK, SECRET_NAME } from '../safety.ts';

/** The longest preview of a value. */
export const PREVIEW_CHARS = 300;
/** The lines of a diff shown before it is cut. */
export const DIFF_LINES = 60;
/** Lines of context around a change. */
const CONTEXT = 3;
/** Above this (lines before x lines after, of the part that differs), the diff is one block. */
const MAX_DP_CELLS = 4_000_000;

/** Whether a value is a text to show as lines (a script): it has more than one line, or is long. */
export const isText = (value: unknown): value is string => typeof value === 'string' && (value.includes('\n') || value.length > 200);

const lines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');

/** A short preview: JSON, cut at PREVIEW_CHARS; a long text as its number of lines; secrets masked. */
export function preview(value: unknown, key?: string): string {
  if (value === undefined) return '(not there)';
  if (key !== undefined && SECRET_NAME.test(key) && typeof value === 'string' && value !== '') return JSON.stringify(SECRET_MASK);
  if (isText(value)) return `(text, ${lines(value).length} line(s), ${value.length} characters)`;
  const text = JSON.stringify(maskForAudit(value, key)) ?? String(value);
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… (${text.length} characters)` : text;
}

type Op = { op: ' ' | '-' | '+'; line: string; a: number; b: number };

/** The line operations from a to b (a longest common subsequence of the part that differs). */
function lineOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ op: ' ', line: a[i]!, a: i, b: i });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_DP_CELLS) {
    midA.forEach((line, i) => ops.push({ op: '-', line, a: start + i, b: start }));
    midB.forEach((line, j) => ops.push({ op: '+', line, a: endA, b: start + j }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * (m + 1) + j] = midA[i] === midB[j] ? table[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ op: ' ', line: midA[i]!, a: start + i, b: start + j });
        i++;
        j++;
      } else if (i < n && (j >= m || table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!)) {
        // (removed lines before added ones)
        ops.push({ op: '-', line: midA[i]!, a: start + i, b: start + j });
        i++;
      } else {
        ops.push({ op: '+', line: midB[j]!, a: start + i, b: start + j });
        j++;
      }
    }
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ op: ' ', line: a[i]!, a: i, b: j });
  return ops;
}

export interface TextDiff {
  linesBefore: number;
  linesAfter: number;
  added: number;
  removed: number;
  /** A unified diff (@@ hunks, - and + lines), cut at DIFF_LINES lines. */
  diff: string;
  truncated: boolean;
}

/** A unified diff of two texts (null or missing: no text). */
export function textDiff(before: string | null | undefined, after: string | null | undefined, maxLines = DIFF_LINES): TextDiff {
  const a = before === null || before === undefined || before === '' ? [] : lines(before);
  const b = after === null || after === undefined || after === '' ? [] : lines(after);
  const ops = lineOps(a, b);
  const changed = ops.flatMap((op, i) => (op.op === ' ' ? [] : [i]));
  const out: string[] = [];
  let i = 0;
  while (i < changed.length) {
    // A hunk: changes no more than 2 x CONTEXT lines apart, with CONTEXT lines around them
    let last = i;
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= CONTEXT * 2 + 1) last++;
    const from = Math.max(0, changed[i]! - CONTEXT);
    const to = Math.min(ops.length - 1, changed[last]! + CONTEXT);
    const hunk = ops.slice(from, to + 1);
    const countA = hunk.filter((o) => o.op !== '+').length;
    const countB = hunk.filter((o) => o.op !== '-').length;
    const startA = countA ? hunk.find((o) => o.op !== '+')!.a + 1 : hunk[0]!.a;
    const startB = countB ? hunk.find((o) => o.op !== '-')!.b + 1 : hunk[0]!.b;
    out.push(`@@ -${startA},${countA} +${startB},${countB} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
    i = last + 1;
  }
  const truncated = out.length > maxLines;
  const shown = truncated ? [...out.slice(0, maxLines), `… (${out.length - maxLines} more line(s) of the diff)`] : out;
  return {
    linesBefore: a.length,
    linesAfter: b.length,
    added: ops.filter((o) => o.op === '+').length,
    removed: ops.filter((o) => o.op === '-').length,
    diff: shown.join('\n'),
    truncated,
  };
}
