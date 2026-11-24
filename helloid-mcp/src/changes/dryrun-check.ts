// The DryRun check: a static check of a PowerShell target system script against the rule of
// Tools4ever / HelloID (see DRYRUN_RULE). A HelloID dry run runs the REAL script against the REAL
// target system with $actionContext.DryRun = $true; only the script's own guard keeps it from
// changing things. So every writing or deleting action must be inside a dry-run check, and the
// script must never change DryRun itself.
//
// Pure functions on the script text: a small PowerShell tokenizer (strings, here-strings, comments,
// line continuations), the blocks with their controlling if / elseif / else and function, and the
// writing calls. Findings: [{ line, kind, text, detail }]. It is a static check: see
// DRYRUN_LIMITATIONS for what it can miss or flag wrongly.

import { isPlainObject } from '../safety.ts';
import { formatPath, readablePath, type Segment } from './paths.ts';

type Any = any;

export type DryRunFindingKind = 'dryrun-override' | 'unguarded-write' | 'empty-script';

export interface DryRunFinding {
  /** The line in the script (1-based). */
  line: number;
  kind: DryRunFindingKind;
  /** The line of the script, trimmed (cut at 200 characters). */
  text: string;
  /** What was found, and why it breaks the rule. */
  detail: string;
}

export interface DryRunCheckResult {
  findings: DryRunFinding[];
  limitations: string;
}

/** v2: PowerShell v2 (powershell-target), guard $actionContext.DryRun; v1: PowerShell v1 (powershell-onpremise), guard $dryRun. */
export type ScriptVariant = 'v2' | 'v1';

/** The variant of the scripts of a target system type. */
export const variantOf = (templateIdentifier: unknown): ScriptVariant => (templateIdentifier === 'powershell-onpremise' ? 'v1' : 'v2');

/** The rule, as the tool descriptions and warnings state it. */
export const DRYRUN_RULE =
  'Tools4ever/HelloID rule: every writing or deleting action in a target system script must be inside a dry-run check ' +
  '(e.g. `if (-not($actionContext.DryRun -eq $true)) { ... }`), and a script must never disable or override DryRun itself. ' +
  'A HelloID dry run runs the REAL script against the REAL target system with $actionContext.DryRun = $true; only the ' +
  'script\'s own guard keeps it from changing things.';

/** What the static check can and cannot see. */
export const DRYRUN_LIMITATIONS =
  'This is a static check of the script text, not a proof. It can MISS writes: code that is built or run dynamically ' +
  '(Invoke-Expression, & $command, scriptblocks or functions called by a name in a variable, dot-sourced files, modules), ' +
  'writes inside double-quoted strings ("$(...)"), .NET methods other than the few it knows (ExecuteNonQuery, ' +
  'CommitChanges, SetInfo, DeleteTree, HttpClient Post/Put/Patch/Delete/SendAsync, [IO.File]/[IO.Directory] write methods), ' +
  'cmdlets whose verb is not a writing verb (e.g. Invoke-Sqlcmd, Start-Process, Out-File, Export-Csv), and cmdlets that ' +
  'write although their verb is not in its list. It can FLAG writes that are safe: writes guarded in another way than a ' +
  'block of `if` / `elseif` / `else` on $actionContext.DryRun (an early `return` or `exit` when DryRun is true, ' +
  'a guard in a variable that is not exactly $actionContext.DryRun, a switch, -WhatIf given through splatting), ' +
  'Invoke-RestMethod / Invoke-WebRequest whose method is a variable or parameter it cannot resolve (e.g. a helper ' +
  'function called with -Method GET outside the guard), and harmless cmdlets with a writing verb (e.g. New-Item of a ' +
  'temporary file). Not counted as writes: a cmdlet called with -WhatIf (also -WhatIf:$true or -WhatIf:$actionContext.DryRun), and an ' +
  'OAuth token request: a POST whose Uri is a token endpoint (oauth2/token, oauth2/v2.0/token, .../token) or whose Body has ' +
  'grant_type or client_assertion (a POST to such a Uri that does write would be missed). A function counts as guarded only when every call of it is inside a dry-run check (or in a function ' +
  'that is); a function that is never called is not checked. When it flags a safe write, restructure the script into the ' +
  'standard pattern: `if (-not($actionContext.DryRun -eq $true)) { <the write> }`.';

// ---------------------------------------------------------------------------------------------
// Tokens

type TokenType = 'var' | 'splat' | 'member' | 'word' | 'string' | 'type' | 'op' | 'nl';

interface Token {
  type: TokenType;
  /** var: the name (scope prefix such as script: left out); member: the name; string: the content; type: the type name. */
  text: string;
  lower: string;
  line: number;
  /** Whitespace (or a line continuation) right before it. */
  space: boolean;
}

const SINGLE_QUOTES = "'‘’‚‛";
const DOUBLE_QUOTES = '"“”„';
const WORD_STOP = new Set([' ', '\t', '\n', '(', ')', '{', '}', '[', ']', ';', ',', '|', '&', '$', '@', '=', '<', '>', '!', ...SINGLE_QUOTES, ...DOUBLE_QUOTES]);
const SCOPES = /^(global|script|local|private|using):/i;
const isIdentStart = (ch: string | undefined) => ch !== undefined && /[A-Za-z_]/.test(ch);

/** The tokens of a script (CRLF already made LF). */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let space = true;
  const n = source.length;
  const push = (type: TokenType, text: string, at: number) => {
    if (type === 'nl' && (!tokens.length || tokens[tokens.length - 1]!.type === 'nl')) {
      space = true;
      return;
    }
    tokens.push({ type, text, lower: text.toLowerCase(), line: at, space });
    space = false;
  };
  const last = () => tokens[tokens.length - 1];
  const countLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (source[k] === '\n') line++;
  };
  /** From after the opening quote of a double-quoted string to after its closing quote. */
  const skipDouble = (from: number): number => {
    let k = from;
    while (k < n) {
      const ch = source[k]!;
      if (ch === '`') {
        k += 2;
        continue;
      }
      if (DOUBLE_QUOTES.includes(ch)) {
        if (DOUBLE_QUOTES.includes(source[k + 1] ?? '')) {
          k += 2;
          continue;
        }
        return k + 1;
      }
      if (ch === '$' && source[k + 1] === '(') {
        k = skipSubexpression(k + 2);
        continue;
      }
      k++;
    }
    return n;
  };
  /** From after "$(" to after its ")" (strings in it skipped). */
  const skipSubexpression = (from: number): number => {
    let depth = 1;
    let k = from;
    while (k < n && depth > 0) {
      const ch = source[k]!;
      if (SINGLE_QUOTES.includes(ch)) {
        k = skipSingle(k + 1);
        continue;
      }
      if (DOUBLE_QUOTES.includes(ch)) {
        k = skipDouble(k + 1);
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      k++;
    }
    return k;
  };
  /** From after the opening quote of a single-quoted string to after its closing quote. */
  const skipSingle = (from: number): number => {
    let k = from;
    while (k < n) {
      if (SINGLE_QUOTES.includes(source[k]!)) {
        if (SINGLE_QUOTES.includes(source[k + 1] ?? '')) {
          k += 2;
          continue;
        }
        return k + 1;
      }
      k++;
    }
    return n;
  };

  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v' || ch === ' ') {
      space = true;
      i++;
      continue;
    }
    if (ch === '`' && next === '\n') {
      // A line continuation: the command goes on on the next line
      line++;
      space = true;
      i += 2;
      continue;
    }
    if (ch === '\n') {
      push('nl', '\n', line);
      line++;
      space = true;
      i++;
      continue;
    }
    if (ch === '<' && next === '#') {
      const end = source.indexOf('#>', i + 2);
      const stop = end === -1 ? n : end + 2;
      countLines(i, stop);
      space = true;
      i = stop;
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // Here-strings: @' ... '@ and @" ... "@ (the closing quote at the start of a line)
    if (ch === '@' && next !== undefined && (SINGLE_QUOTES.includes(next) || DOUBLE_QUOTES.includes(next))) {
      const rest = source.slice(i + 2, source.indexOf('\n', i + 2) === -1 ? n : source.indexOf('\n', i + 2));
      if (!rest.trim()) {
        const quotes = SINGLE_QUOTES.includes(next) ? SINGLE_QUOTES : DOUBLE_QUOTES;
        const start = i;
        const startLine = line;
        let k = source.indexOf('\n', i + 2);
        let end = n;
        let contentEnd = n;
        while (k !== -1 && k < n) {
          let m = k + 1;
          while (source[m] === ' ' || source[m] === '\t') m++;
          if (quotes.includes(source[m] ?? '') && source[m + 1] === '@') {
            contentEnd = k;
            end = m + 2;
            break;
          }
          k = source.indexOf('\n', k + 1);
        }
        const firstLineEnd = source.indexOf('\n', i + 2);
        const text = firstLineEnd === -1 || contentEnd <= firstLineEnd ? '' : source.slice(firstLineEnd + 1, contentEnd);
        countLines(start, end);
        tokens.push({ type: 'string', text, lower: text.toLowerCase(), line: startLine, space });
        space = false;
        i = end;
        continue;
      }
    }
    if (SINGLE_QUOTES.includes(ch)) {
      const end = skipSingle(i + 1);
      const text = source.slice(i + 1, Math.max(i + 1, end - 1)).replace(/''/g, "'");
      const startLine = line;
      countLines(i, end);
      tokens.push({ type: 'string', text, lower: text.toLowerCase(), line: startLine, space });
      space = false;
      i = end;
      continue;
    }
    if (DOUBLE_QUOTES.includes(ch)) {
      const end = skipDouble(i + 1);
      const text = source.slice(i + 1, Math.max(i + 1, end - 1));
      const startLine = line;
      countLines(i, end);
      tokens.push({ type: 'string', text, lower: text.toLowerCase(), line: startLine, space });
      space = false;
      i = end;
      continue;
    }
    if (ch === '@') {
      if (next === '{' || next === '(') {
        push('op', `@${next}`, line);
        i += 2;
        continue;
      }
      if (isIdentStart(next) || /\d/.test(next ?? '')) {
        let k = i + 1;
        while (k < n && /[\w:]/.test(source[k]!)) k++;
        push('splat', source.slice(i + 1, k), line);
        i = k;
        continue;
      }
    }
    if (ch === '$') {
      if (next === '(') {
        push('op', '$(', line);
        i += 2;
        continue;
      }
      if (next === '{') {
        const end = source.indexOf('}', i + 2);
        const stop = end === -1 ? n : end;
        push('var', source.slice(i + 2, stop).replace(SCOPES, ''), line);
        i = stop + 1;
        continue;
      }
      if (next !== undefined && /[\w?^$]/.test(next)) {
        let k = i + 1;
        if (/[?^$]/.test(next)) k++;
        else while (k < n && /[\w:]/.test(source[k]!)) k++;
        // (a trailing colon is not part of the name, e.g. "$name:")
        let name = source.slice(i + 1, k);
        if (name.endsWith(':')) {
          name = name.slice(0, -1);
          k--;
        }
        push('var', name.replace(SCOPES, ''), line);
        i = k;
        continue;
      }
    }
    if (ch === '.') {
      const prev = last();
      if (next === '.') {
        push('op', '..', line);
        i += 2;
        continue;
      }
      const afterValue = prev && !space && (['var', 'member', 'type', 'string'].includes(prev.type) || (prev.type === 'op' && (prev.text === ')' || prev.text === ']')));
      if (afterValue && (isIdentStart(next) || (next !== undefined && (SINGLE_QUOTES + DOUBLE_QUOTES).includes(next)))) {
        if (isIdentStart(next)) {
          let k = i + 1;
          while (k < n && /\w/.test(source[k]!)) k++;
          push('member', source.slice(i + 1, k), line);
          i = k;
        } else {
          const end = SINGLE_QUOTES.includes(next!) ? skipSingle(i + 2) : skipDouble(i + 2);
          push('member', source.slice(i + 2, Math.max(i + 2, end - 1)), line);
          i = end;
        }
        continue;
      }
      if (next === ' ' || next === '\t') {
        push('op', '.', line);
        i++;
        continue;
      }
    }
    if (ch === ':' && next === ':') {
      let k = i + 2;
      while (k < n && /\w/.test(source[k]!)) k++;
      push('member', source.slice(i + 2, k), line);
      i = k;
      continue;
    }
    if (ch === '[') {
      const prev = last();
      const isIndex = prev && !space && (['var', 'member', 'string'].includes(prev.type) || (prev.type === 'op' && (prev.text === ')' || prev.text === ']')));
      if (!isIndex) {
        // A type literal: [bool], [ref], [System.IO.File], [System.Collections.Generic.List[object]]
        let depth = 0;
        let k = i;
        for (; k < n; k++) {
          if (source[k] === '[') depth++;
          else if (source[k] === ']') {
            depth--;
            if (depth === 0) break;
          } else if (source[k] === '\n') break;
        }
        const inner = source.slice(i + 1, k);
        if (k < n && source[k] === ']' && /^[A-Za-z_][\w.,`\[\] ]*$/.test(inner)) {
          push('type', inner.trim(), line);
          i = k + 1;
          continue;
        }
      }
      push('op', '[', line);
      i++;
      continue;
    }
    if ('(){}];,|'.includes(ch)) {
      push('op', ch, line);
      i++;
      continue;
    }
    if (ch === '&') {
      push('op', next === '&' ? '&&' : '&', line);
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (ch === '=') {
      push('op', '=', line);
      i++;
      continue;
    }
    if ('+-*/%'.includes(ch) && next === '=') {
      push('op', `${ch}=`, line);
      i += 2;
      continue;
    }
    if ('+*/%'.includes(ch) && (next === undefined || /\s/.test(next))) {
      push('op', ch, line);
      i++;
      continue;
    }
    if (ch === '!' || ch === '<' || ch === '>') {
      push('op', ch, line);
      i++;
      continue;
    }
    // A bare word: a command, a parameter (-Method), an operator (-eq), a number, a path
    let k = i;
    while (k < n) {
      const c = source[k]!;
      if (c === '`' && k + 1 < n && source[k + 1] !== '\n') {
        k += 2;
        continue;
      }
      if (WORD_STOP.has(c) || (c === '`' && source[k + 1] === '\n')) break;
      k++;
    }
    if (k === i) k = i + 1;
    push('word', source.slice(i, k), line);
    i = k;
  }
  return tokens;
}

const OPENERS = new Set(['{', '@{', '(', '@(', '$(', '[']);
const CLOSERS = new Set(['}', ')', ']']);
const isOp = (t: Token | undefined, ...texts: string[]) => t?.type === 'op' && texts.includes(t.text);
const isWord = (t: Token | undefined, ...words: string[]) => t?.type === 'word' && words.includes(t.lower);

/** The index of the matching bracket of every bracket token (-1 when unmatched). */
function matchBrackets(tokens: Token[]): number[] {
  const match = tokens.map(() => -1);
  const stack: number[] = [];
  tokens.forEach((t, i) => {
    if (t.type !== 'op') return;
    if (OPENERS.has(t.text)) stack.push(i);
    else if (CLOSERS.has(t.text) && stack.length) {
      const open = stack.pop()!;
      match[open] = i;
      match[i] = open;
    }
  });
  return match;
}

// ---------------------------------------------------------------------------------------------
// Conditions: when does a block run? Only the cases that matter: the dry-run value (D), its
// negation, -and, -or, -not / !, comparisons with $true / $false, parentheses.

type Condition = { k: 'atom'; v: 'D' | 'ND' | 'X' } | { k: 'not'; a: Condition } | { k: 'and' | 'or'; a: Condition; b: Condition };
const OTHER: Condition = { k: 'atom', v: 'X' };

/** The block only runs when it is not a dry run (condition true implies not dry run). */
function onlyWhenNotDry(c: Condition): boolean {
  switch (c.k) {
    case 'atom':
      return c.v === 'ND';
    case 'not':
      return alwaysWhenDry(c.a);
    case 'and':
      return onlyWhenNotDry(c.a) || onlyWhenNotDry(c.b);
    case 'or':
      return onlyWhenNotDry(c.a) && onlyWhenNotDry(c.b);
  }
}

/** The condition is true whenever it is a dry run (so its else only runs when it is not). */
function alwaysWhenDry(c: Condition): boolean {
  switch (c.k) {
    case 'atom':
      return c.v === 'D';
    case 'not':
      return onlyWhenNotDry(c.a);
    case 'and':
      return alwaysWhenDry(c.a) && alwaysWhenDry(c.b);
    case 'or':
      return alwaysWhenDry(c.a) || alwaysWhenDry(c.b);
  }
}

const COMPARE_EQ = new Set(['-eq', '-ieq', '-ceq']);
const COMPARE_NE = new Set(['-ne', '-ine', '-cne']);

/** Parses a condition (the tokens between the parentheses of an if); anything it does not know is OTHER. */
function parseCondition(tokens: Token[], isDryRunAt: (list: Token[], at: number) => number): Condition {
  const list = tokens.filter((t) => t.type !== 'nl');
  let pos = 0;
  const peek = () => list[pos];
  type Operand = 'D' | 'ND' | 'TRUE' | 'FALSE' | 'X';
  const operand = (): Operand => {
    while (peek()?.type === 'type') pos++;
    const t = peek();
    if (!t) return 'X';
    if (isOp(t, '(', '$(')) {
      pos++;
      const inner = parseOr();
      if (isOp(peek(), ')')) pos++;
      else return 'X';
      if (inner.k === 'atom') return inner.v;
      if (inner.k === 'not' && inner.a.k === 'atom' && inner.a.v !== 'X') return inner.a.v === 'D' ? 'ND' : 'D';
      return 'X';
    }
    const length = isDryRunAt(list, pos);
    if (length) {
      pos += length;
      return 'D';
    }
    if (t.type === 'var') {
      pos++;
      while (peek()?.type === 'member') pos++;
      return t.lower === 'true' ? 'TRUE' : t.lower === 'false' ? 'FALSE' : 'X';
    }
    pos++;
    return 'X';
  };
  const compare = (): Condition => {
    const start = pos;
    // A parenthesised condition keeps its structure (-and / -or inside)
    if (isOp(peek(), '(', '$(')) {
      pos++;
      const inner = parseOr();
      if (!isOp(peek(), ')')) return OTHER;
      pos++;
      const op = peek();
      if (!(op?.type === 'word' && (COMPARE_EQ.has(op.lower) || COMPARE_NE.has(op.lower)))) return inner;
      pos = start;
    }
    const left = operand();
    const op = peek();
    if (op?.type === 'word' && (COMPARE_EQ.has(op.lower) || COMPARE_NE.has(op.lower))) {
      pos++;
      const right = operand();
      const pair = [left, right];
      const has = (a: Operand, b: Operand) => (pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a);
      const isDry = has('D', 'TRUE') || has('ND', 'FALSE');
      const isNotDry = has('D', 'FALSE') || has('ND', 'TRUE');
      const eq = COMPARE_EQ.has(op.lower);
      if (isDry) return { k: 'atom', v: eq ? 'D' : 'ND' };
      if (isNotDry) return { k: 'atom', v: eq ? 'ND' : 'D' };
      return OTHER;
    }
    return { k: 'atom', v: left === 'D' ? 'D' : left === 'ND' ? 'ND' : 'X' };
  };
  const parseNot = (): Condition => {
    const t = peek();
    if (isWord(t, '-not') || isOp(t, '!')) {
      pos++;
      return { k: 'not', a: parseNot() };
    }
    return compare();
  };
  const parseAnd = (): Condition => {
    let left = parseNot();
    while (isWord(peek(), '-and')) {
      pos++;
      left = { k: 'and', a: left, b: parseNot() };
    }
    return left;
  };
  function parseOr(): Condition {
    let left = parseAnd();
    while (isWord(peek(), '-or', '-xor')) {
      const xor = peek()!.lower === '-xor';
      pos++;
      const right = parseAnd();
      left = xor ? OTHER : { k: 'or', a: left, b: right };
    }
    return left;
  }
  const result = parseOr();
  return pos === list.length ? result : OTHER;
}

// ---------------------------------------------------------------------------------------------
// The check

const WRITE_VERBS = new Set([
  'new', 'set', 'remove', 'add', 'enable', 'disable', 'clear', 'rename', 'move', 'grant', 'revoke', 'update', 'reset', 'unlock', 'send',
  'copy', 'install', 'uninstall', 'register', 'unregister', 'publish', 'lock',
]);
/** Cmdlets with a writing verb that change nothing outside the script. */
const HARMLESS = new Set([
  'new-object', 'new-timespan', 'new-guid', 'set-strictmode', 'set-variable', 'new-variable', 'clear-variable', 'remove-variable',
  'add-member', 'add-type', 'set-location', 'new-pssessionoption', 'new-cimsessionoption', 'new-pssession', 'remove-pssession',
  'new-cimsession', 'remove-cimsession', 'remove-module', 'clear-host',
]);
const REST_COMMANDS = new Set(['invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr', 'invoke-mggraphrequest']);
const WRITE_METHODS = /^(post|put|patch|delete|merge)$/i;
/** The Uri of an OAuth token request (a POST that only reads). */
const TOKEN_URI = /oauth2\/(v2\.0\/)?token|\/token(\?|"|'|$)/i;
/** .NET methods that write (on any object). */
const WRITE_MEMBERS = new Set(['executenonquery', 'commitchanges', 'setinfo', 'deletetree', 'postasync', 'putasync', 'patchasync', 'deleteasync', 'sendasync']);
/** Static methods of [System.IO.File] / [System.IO.Directory] that write. */
const FILE_WRITE_MEMBERS = new Set(['writealltext', 'writeallbytes', 'writealllines', 'appendalltext', 'appendalllines', 'delete', 'move', 'copy', 'createdirectory', 'replace']);
/** Tokens before a command name. */
const COMMAND_START_OPS = new Set([';', '|', '{', '(', '$(', '@(', '=', '+=', '-=', '*=', '/=', '%=', '&', '&&', '||', '.']);
const STATEMENT_START_OPS = new Set([';', '{', '(', '@(', '$(', '[', ',', '|', '@{']);

interface Frame {
  kind: 'if' | 'elseif' | 'else' | 'function' | 'hash' | 'block';
  /** The block only runs when it is not a dry run. */
  guard: boolean;
  name?: string;
  /** The conditions of its if / elseif chain so far. */
  chain?: Condition[];
  closeAt: number;
}

interface Where {
  line: number;
  /** The innermost function it is in (lower case), null at the top of the script. */
  fn: string | null;
  /** Inside a dry-run check within that function (or the script). */
  guarded: boolean;
}

const lineText = (lines: string[], line: number) => {
  const text = (lines[line - 1] ?? '').trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
};

/**
 * Checks a PowerShell target system script against the dry-run rule. An empty script (null,
 * undefined, only whitespace) gives one empty-script finding.
 */
export function checkDryRun(script: unknown, options: { variant?: ScriptVariant } = {}): DryRunCheckResult {
  if (typeof script !== 'string' || !script.trim()) {
    return {
      findings: [{ line: 1, kind: 'empty-script', text: '', detail: 'The script is empty: there is nothing to run (HelloID would run an empty script).' }],
      limitations: DRYRUN_LIMITATIONS,
    };
  }
  const variant = options.variant ?? 'v2';
  const source = script.replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const tokens = tokenize(source);
  const match = matchBrackets(tokens);
  const findings: DryRunFinding[] = [];
  const add = (line: number, kind: DryRunFindingKind, detail: string) => findings.push({ line, kind, text: lineText(lines, line), detail });
  const guardName = variant === 'v1' ? '$dryRun' : '$actionContext.DryRun';

  const prevIndex = (i: number) => {
    let k = i - 1;
    while (k >= 0 && tokens[k]!.type === 'nl') k--;
    return k;
  };
  const isVar = (t: Token | undefined, name: string) => t?.type === 'var' && t.lower === name;

  // Functions defined in the script (lower case, without scope)
  const functions = new Set<string>();
  tokens.forEach((t, i) => {
    const next = tokens[i + 1];
    if (isWord(t, 'function', 'filter', 'workflow') && next?.type === 'word') functions.add(next.lower.replace(SCOPES, ''));
  });

  // The start of the statement that ends just before i (an assignment's left side)
  const statementStart = (i: number) => {
    let k = i - 1;
    while (k >= 0) {
      const t = tokens[k]!;
      if (t.type === 'nl' || (t.type === 'op' && STATEMENT_START_OPS.has(t.text))) break;
      if (t.type === 'op' && (t.text === ')' || t.text === ']' || t.text === '}') && match[k]! >= 0) {
        k = match[k]! - 1;
        continue;
      }
      k--;
    }
    return k + 1;
  };
  // The end (exclusive) of the expression that starts at i (an assignment's right side)
  const expressionEnd = (i: number) => {
    let j = i;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (t.type === 'nl' || isOp(t, ';', '}', ')', ']')) break;
      if (t.type === 'op' && OPENERS.has(t.text) && match[j]! > j) {
        j = match[j]! + 1;
        continue;
      }
      j++;
    }
    return j;
  };
  const withoutWrapping = (list: Token[]) => {
    let items = list.filter((t) => t.type !== 'nl');
    for (;;) {
      while (items[0]?.type === 'type') items = items.slice(1);
      if (isOp(items[0], '(', '$(') && isOp(items[items.length - 1], ')')) items = items.slice(1, -1);
      else return items;
    }
  };

  // Aliases of the dry-run value: $x = $actionContext.DryRun (v1: $x = $dryRun)
  const aliases = new Set<string>();
  const aliasAssignments = new Set<number>();
  const isDryRunAt = (list: Token[], at: number): number => {
    const t = list[at];
    if (t?.type !== 'var') return 0;
    if (variant === 'v2' && t.lower === 'actioncontext') {
      const member = list[at + 1];
      const after = list[at + 2];
      return member?.type === 'member' && member.lower === 'dryrun' && !(after?.type === 'member' || isOp(after, '(', '[')) ? 2 : 0;
    }
    if (variant === 'v1' && t.lower === 'dryrun') return isOp(list[at + 1], '(', '[') || list[at + 1]?.type === 'member' ? 0 : 1;
    return aliases.has(t.lower) && list[at + 1]?.type !== 'member' ? 1 : 0;
  };
  const isDryRunValue = (list: Token[]) => {
    const items = withoutWrapping(list);
    return items.length > 0 && isDryRunAt(items, 0) === items.length;
  };
  // The variables used in the conditions of if / elseif
  const conditionVars = new Set<string>();
  tokens.forEach((t, i) => {
    if (!isWord(t, 'if', 'elseif') || !isOp(tokens[i + 1], '(') || match[i + 1]! < 0) return;
    for (const x of tokens.slice(i + 2, match[i + 1]!)) if (x.type === 'var') conditionVars.add(x.lower);
  });
  /** A variable that stands for the dry-run value: an alias, $dryRun / $isDryRun, or a dry-run name used in a condition. */
  const isDryRunName = (name: string) =>
    aliases.has(name) || (variant === 'v1' && name === 'dryrun') || (/dry_?run/i.test(name) && (conditionVars.has(name) || /^(is_?)?dry_?run$/i.test(name)));
  for (let round = 0; round < 3; round++) {
    tokens.forEach((t, i) => {
      if (!isOp(t, '=')) return;
      const start = statementStart(i);
      const left = withoutWrapping(tokens.slice(start, i));
      if (left.length !== 1 || left[0]!.type !== 'var' || left[0]!.lower === 'actioncontext') return;
      if (variant === 'v1' && left[0]!.lower === 'dryrun') return;
      if (isDryRunValue(tokens.slice(i + 1, expressionEnd(i + 1)))) {
        aliases.add(left[0]!.lower);
        aliasAssignments.add(i);
      }
    });
  }

  /** The text value of a variable: its nearest string assignment before `before`; undefined when not found. */
  const resolveVariable = (name: string, before: number, depth = 0): string | undefined => {
    if (depth > 5) return undefined;
    for (let k = before - 1; k >= 0; k--) {
      const t = tokens[k]!;
      if (!isVar(t, name) || !isOp(tokens[k + 1], '=') || statementStart(k + 1) !== k - countTypes(k)) continue;
      const value = withoutWrapping(tokens.slice(k + 2, expressionEnd(k + 2)));
      if (value.length !== 1) return undefined;
      const v = value[0]!;
      if (v.type === 'string' || v.type === 'word') return v.text;
      if (v.type === 'var') return resolveVariable(v.lower, k, depth + 1);
      return undefined;
    }
    return undefined;
  };
  const countTypes = (k: number) => {
    let c = 0;
    while (tokens[k - 1 - c]?.type === 'type') c++;
    return c;
  };
  /** A value token: its text, a resolved variable, or undefined (not a fixed value). */
  const valueOf = (t: Token | undefined, at: number): { text: string | undefined; shown: string } => {
    if (!t) return { text: undefined, shown: '?' };
    if (t.type === 'string' || t.type === 'word') return { text: t.text, shown: t.text };
    if (t.type === 'var') return { text: resolveVariable(t.lower, at), shown: `$${t.text}` };
    return { text: undefined, shown: t.text };
  };

  /** The method a splatted hashtable sets: 'absent' (none: GET), the value, or undefined (cannot tell). */
  const splatMethod = (name: string, before: number): { state: 'absent' | 'known' | 'unknown'; shown: string; value?: string } => {
    let assigned = -1;
    for (let k = before - 1; k >= 0; k--) {
      if (isVar(tokens[k], name) && isOp(tokens[k + 1], '=') && statementStart(k + 1) === k - countTypes(k)) {
        assigned = k;
        break;
      }
    }
    let result: { state: 'absent' | 'known' | 'unknown'; shown: string; value?: string } = { state: 'unknown', shown: `@${name} (not assigned as a hashtable in the script)` };
    if (assigned >= 0) {
      let v = assigned + 2;
      while (tokens[v]?.type === 'type' || tokens[v]?.type === 'nl') v++;
      if (isOp(tokens[v], '@{') && match[v]! > v) {
        result = { state: 'absent', shown: `@${name}` };
        for (let q = v + 1; q < match[v]!; q++) {
          const t = tokens[q]!;
          if (t.type === 'op' && OPENERS.has(t.text) && match[q]! > q) {
            q = match[q]!;
            continue;
          }
          if ((t.type === 'word' || t.type === 'string') && t.lower === 'method' && isOp(tokens[q + 1], '=')) {
            const value = valueOf(tokens[q + 2], q + 2);
            result = value.text === undefined ? { state: 'unknown', shown: `@${name} (Method = ${value.shown})` } : { state: 'known', shown: `@${name} (Method = '${value.text}')`, value: value.text };
          }
        }
      } else {
        result = { state: 'unknown', shown: `@${name} (not a hashtable written in the script)` };
      }
    }
    // Later changes of its Method: $x.Method = ..., $x['Method'] = ..., $x.Add('Method', ...)
    for (let k = Math.max(assigned, 0); k < before; k++) {
      if (!isVar(tokens[k], name)) continue;
      const a = tokens[k + 1];
      let valueAt = -1;
      if (a?.type === 'member' && a.lower === 'method' && isOp(tokens[k + 2], '=')) valueAt = k + 3;
      else if (isOp(a, '[') && tokens[k + 2]?.lower === 'method' && isOp(tokens[k + 3], ']') && isOp(tokens[k + 4], '=')) valueAt = k + 5;
      else if (a?.type === 'member' && a.lower === 'add' && isOp(tokens[k + 2], '(') && tokens[k + 3]?.lower === 'method' && isOp(tokens[k + 4], ',')) valueAt = k + 5;
      if (valueAt < 0) continue;
      const value = valueOf(tokens[valueAt], valueAt);
      result = value.text === undefined ? { state: 'unknown', shown: `@${name} (Method = ${value.shown})` } : { state: 'known', shown: `@${name} (Method = '${value.text}')`, value: value.text };
    }
    return result;
  };

  /** The arguments of the command at i: up to the end of the command (nested brackets skipped). */
  const commandArguments = (i: number): number[] => {
    const indexes: number[] = [];
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (t.type === 'nl' || isOp(t, ';', '|', '&&', '||', '}', ')', ']')) break;
      indexes.push(j);
      if (t.type === 'op' && OPENERS.has(t.text) && match[j]! > j) {
        j = match[j]! + 1;
        continue;
      }
      j++;
    }
    return indexes;
  };

  /**
   * The texts a value is made of, to recognise an OAuth token request: a string or word; a variable:
   * the pieces of its nearest assignment before `at` (followed through simple assignments such as
   * $authUri = $baseUri + "$TenantId/oauth2/token"); an inline hashtable: every token in it.
   */
  const valuePieces = (at: number, depth = 0): string[] => {
    const t = tokens[at];
    if (!t || depth > 5) return [];
    if (t.type === 'string' || t.type === 'word') return [t.text];
    if (t.type === 'op' && OPENERS.has(t.text) && match[at]! > at) {
      return tokens.slice(at + 1, match[at]!).filter((x) => x.type === 'string' || x.type === 'word').map((x) => x.text);
    }
    if (t.type !== 'var') return [];
    for (let k = at - 1; k >= 0; k--) {
      if (!isVar(tokens[k], t.lower) || !isOp(tokens[k + 1], '=') || statementStart(k + 1) !== k - countTypes(k)) continue;
      const end = expressionEnd(k + 2);
      const pieces: string[] = [];
      for (let q = k + 2; q < end; q++) {
        const x = tokens[q]!;
        if (x.type === 'string' || x.type === 'word') pieces.push(x.text);
        else if (x.type === 'var') pieces.push(...valuePieces(q, depth + 1));
        else if (x.type === 'op' && OPENERS.has(x.text) && match[q]! > q) {
          pieces.push(...valuePieces(q, depth + 1));
          q = match[q]!;
        }
      }
      return pieces;
    }
    return [];
  };
  /** The value token of a key (Uri, Body) in the hashtable assigned to $name nearest before `before`. */
  const splatEntry = (name: string, before: number, key: string): number => {
    for (let k = before - 1; k >= 0; k--) {
      if (!(isVar(tokens[k], name) && isOp(tokens[k + 1], '=') && statementStart(k + 1) === k - countTypes(k))) continue;
      let v = k + 2;
      while (tokens[v]?.type === 'type' || tokens[v]?.type === 'nl') v++;
      if (!isOp(tokens[v], '@{') || match[v]! <= v) return -1;
      let found = -1;
      for (let q = v + 1; q < match[v]!; q++) {
        const t = tokens[q]!;
        if (t.type === 'op' && OPENERS.has(t.text) && match[q]! > q) {
          q = match[q]!;
          continue;
        }
        if ((t.type === 'word' || t.type === 'string') && t.lower === key && isOp(tokens[q + 1], '=')) found = q + 2;
      }
      return found;
    }
    return -1;
  };
  /**
   * An OAuth token request: a POST whose Uri (literal, or the variable or hashtable entry it comes
   * from) ends in a token endpoint, or whose Body has grant_type or client_assertion. It reads only.
   */
  const isTokenRequest = (i: number, args: number[]): boolean => {
    const uri: string[] = [];
    const body: string[] = [];
    for (const j of args) {
      const t = tokens[j]!;
      if (t.type === 'word' && /^-(uri|body):?$/i.test(t.text)) (/^-uri/i.test(t.text) ? uri : body).push(...valuePieces(j + 1));
      if (t.type === 'splat') {
        const u = splatEntry(t.lower, i, 'uri');
        const b = splatEntry(t.lower, i, 'body');
        if (u >= 0) uri.push(...valuePieces(u));
        if (b >= 0) body.push(...valuePieces(b));
      }
    }
    return uri.some((p) => TOKEN_URI.test(p)) || body.some((p) => /grant_type|client_assertion/i.test(p));
  };

  /** Whether a REST call at i writes: undefined when it reads (GET, or a POST that requests an OAuth token), else what it does. */
  const restWrite = (i: number): string | undefined => {
    const name = tokens[i]!.text;
    const args = commandArguments(i);
    const write = (method: string, what: string) => (method.trim().toLowerCase() === 'post' && isTokenRequest(i, args) ? undefined : what);
    for (const j of args) {
      const t = tokens[j]!;
      if (t.type !== 'word' || !/^-method(:|$)/i.test(t.text)) continue;
      const colon = t.text.indexOf(':');
      const value = colon >= 0 ? (t.text.slice(colon + 1) ? { text: t.text.slice(colon + 1), shown: t.text.slice(colon + 1) } : valueOf(tokens[j + 1], j + 1)) : valueOf(tokens[j + 1], j + 1);
      if (value.text === undefined) return `${name} with -Method ${value.shown}, which is not a fixed value: it may write`;
      return WRITE_METHODS.test(value.text.trim()) ? write(value.text, `${name} -Method ${value.text.trim().toUpperCase()}`) : undefined;
    }
    let unknown: string | undefined;
    for (const j of args) {
      const t = tokens[j]!;
      if (t.type !== 'splat') continue;
      const method = splatMethod(t.lower, i);
      if (method.state === 'known' && WRITE_METHODS.test(method.value!.trim())) {
        const what = write(method.value!, `${name} with ${method.shown}`);
        if (what) return what;
        continue;
      }
      if (method.state === 'unknown') unknown ??= `${name} with ${method.shown}: the method cannot be told, so it may write`;
    }
    return unknown;
  };

  // The pass over the blocks
  const stack: Frame[] = [];
  let lastChain: { closeAt: number; chain: Condition[] } | null = null;
  const writes: Array<Where & { what: string }> = [];
  const calls: Array<Where & { name: string }> = [];
  const where = (line: number): Where => {
    let guarded = false;
    for (let k = stack.length - 1; k >= 0; k--) {
      const frame = stack[k]!;
      if (frame.kind === 'function') return { line, fn: frame.name ?? null, guarded };
      if (frame.guard) guarded = true;
    }
    return { line, fn: null, guarded };
  };
  const inHash = () => stack[stack.length - 1]?.kind === 'hash';

  const classify = (i: number): Frame => {
    const closeAt = match[i]! > i ? match[i]! : Number.MAX_SAFE_INTEGER;
    if (tokens[i]!.text === '@{') return { kind: 'hash', guard: false, closeAt };
    const p = prevIndex(i);
    const prev = tokens[p];
    if (isOp(prev, ')') && match[p]! >= 0) {
      const open = match[p]!;
      const keyIndex = prevIndex(open);
      const key = tokens[keyIndex];
      if (isWord(key, 'if', 'elseif')) {
        const condition = parseCondition(tokens.slice(open + 1, p), isDryRunAt);
        if (key!.lower === 'if') return { kind: 'if', guard: onlyWhenNotDry(condition), chain: [condition], closeAt };
        const before = lastChain && prevIndex(keyIndex) === lastChain.closeAt ? lastChain.chain : null;
        if (!before) return { kind: 'elseif', guard: false, chain: [condition], closeAt };
        return { kind: 'elseif', guard: onlyWhenNotDry(condition) || before.some(alwaysWhenDry), chain: [...before, condition], closeAt };
      }
      const fnKey = tokens[prevIndex(keyIndex)];
      if (key?.type === 'word' && isWord(fnKey, 'function', 'filter', 'workflow')) return { kind: 'function', guard: false, name: key.lower.replace(SCOPES, ''), closeAt };
      return { kind: 'block', guard: false, closeAt };
    }
    if (isWord(prev, 'else')) {
      const before = lastChain && prevIndex(p) === lastChain.closeAt ? lastChain.chain : null;
      return { kind: 'else', guard: before ? before.some(alwaysWhenDry) : false, closeAt };
    }
    if (prev?.type === 'word' && isWord(tokens[prevIndex(p)], 'function', 'filter', 'workflow')) {
      return { kind: 'function', guard: false, name: prev.lower.replace(SCOPES, ''), closeAt };
    }
    return { kind: 'block', guard: false, closeAt };
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === 'op' && (t.text === '{' || t.text === '@{')) {
      stack.push(classify(i));
      continue;
    }
    if (isOp(t, '}')) {
      const frame = stack.pop();
      lastChain = frame && (frame.kind === 'if' || frame.kind === 'elseif') ? { closeAt: i, chain: frame.chain ?? [] } : null;
      continue;
    }

    // Assignments that change the dry-run value
    if (t.type === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(t.text) && !inHash() && !aliasAssignments.has(i)) {
      const start = statementStart(i);
      const left = tokens.slice(start, i).filter((x) => x.type !== 'nl');
      const plain = withoutWrapping(left);
      if (plain.length === 1 && isVar(plain[0], 'actioncontext')) {
        add(t.line, 'dryrun-override', `$actionContext is replaced: that also replaces ${guardName}, which a script must never change.`);
      } else if (variant === 'v2' && left.some((x, k) => isVar(x, 'actioncontext') && left.slice(k + 1).some((y) => /^dry_?run$/i.test(y.text)))) {
        add(t.line, 'dryrun-override', '$actionContext.DryRun is changed: a script must never disable or override DryRun.');
      } else if (plain.length === 1 && plain[0]!.type === 'var' && isDryRunName(plain[0]!.lower)) {
        add(
          t.line,
          'dryrun-override',
          variant === 'v1' && isVar(plain[0], 'dryrun')
            ? '$dryRun is changed: a script must never disable or override the dry-run value.'
            : `$${plain[0]!.text} is assigned something other than ${guardName}: a variable that stands for the dry-run value must never be set by the script ` +
                '(it shadows the real value, so a guard on it no longer follows HelloID\'s dry run).',
        );
      }
      continue;
    }

    // [ref] to the dry-run value: it can be changed through the reference
    if (t.type === 'type' && t.lower === 'ref') {
      const next = tokens[i + 1];
      if (next && (isDryRunAt(tokens, i + 1) || (next.type === 'var' && isDryRunName(next.lower)))) {
        add(t.line, 'dryrun-override', `[ref] to the dry-run value: it can be changed through the reference, and a script must never change ${guardName}.`);
      }
      continue;
    }

    // Methods that change the dry-run value on $actionContext ($actionContext.set_DryRun(...), .Remove('DryRun'))
    if (t.type === 'member') {
      if (t.lower === 'set_dryrun') {
        add(t.line, 'dryrun-override', `${t.text}() changes the dry-run value: a script must never change ${guardName}.`);
        continue;
      }
      const prev = tokens[i - 1];
      if (isOp(tokens[i + 1], '(')) {
        let k = i - 1;
        while (k >= 0 && tokens[k]!.type === 'member') k--;
        const receiver = tokens[k];
        const close = match[i + 1]!;
        if (isVar(receiver, 'actioncontext') && close > i && tokens.slice(i + 2, close).some((x) => /^dry_?run$/i.test(x.text))) {
          add(t.line, 'dryrun-override', `$actionContext...${t.text}('DryRun') changes the dry-run value: a script must never change ${guardName}.`);
          continue;
        }
        const fileType = prev?.type === 'type' && /(^|\.)(file|directory)$/i.test(prev.text);
        if (WRITE_MEMBERS.has(t.lower) || (fileType && FILE_WRITE_MEMBERS.has(t.lower))) {
          writes.push({ ...where(t.line), what: `${fileType ? `[${prev!.text}]::` : '.'}${t.text}() (writes)` });
        }
      }
      continue;
    }

    if (t.type !== 'word' || t.text.startsWith('-')) continue;
    const prev = tokens[i - 1];
    const isDefinition = isWord(tokens[prevIndex(i)], 'function', 'filter', 'workflow');
    if (isDefinition) continue;
    const afterParam = isOp(prev, ')') && match[i - 1]! >= 0 && isWord(tokens[match[i - 1]! - 1], 'param');
    const atCommand = !prev || prev.type === 'nl' || (prev.type === 'op' && COMMAND_START_OPS.has(prev.text)) || isWord(prev, 'return', 'throw', 'exit') || afterParam;
    if (!atCommand) continue;
    const name = t.lower.slice(t.lower.lastIndexOf('\\') + 1);
    const shown = t.text.slice(t.text.lastIndexOf('\\') + 1);

    // Commands that change the dry-run value
    if (['set-variable', 'new-variable', 'remove-variable', 'clear-variable', 'add-member', 'set-itemproperty'].includes(name)) {
      const args = commandArguments(i).map((j) => tokens[j]!);
      const named =
        name.endsWith('-variable') &&
        args.some((x) => (x.type === 'word' || x.type === 'string') && !x.text.startsWith('-') && (isDryRunName(x.lower) || x.lower === 'actioncontext'));
      const onContext = name === 'add-member' && args.some((x) => isVar(x, 'actioncontext')) && args.some((x) => /^dry_?run$/i.test(x.text));
      const piped = name === 'add-member' && isOp(prev, '|') && args.some((x) => /^dry_?run$/i.test(x.text));
      if (named || onContext || piped) {
        add(t.line, 'dryrun-override', `${shown} changes the dry-run value (or $actionContext): a script must never disable or override ${guardName}.`);
        continue;
      }
    }

    if (functions.has(name)) {
      calls.push({ ...where(t.line), name });
      continue;
    }
    if (REST_COMMANDS.has(name)) {
      const what = restWrite(i);
      if (what) writes.push({ ...where(t.line), what });
      continue;
    }
    const verb = /^([a-z]+)-[a-z0-9]/.exec(name)?.[1];
    if (verb && WRITE_VERBS.has(verb) && !HARMLESS.has(name)) {
      // -WhatIf, -WhatIf:$true or -WhatIf:<the dry-run value>: the cmdlet only says what it would do
      const whatIf = commandArguments(i).some((j) => {
        const a = tokens[j]!;
        if (a.type !== 'word') return false;
        if (/^-whatif$/i.test(a.text) || /^-whatif:\$?true$/i.test(a.text)) return true;
        return /^-whatif:$/i.test(a.text) && (isVar(tokens[j + 1], 'true') || isDryRunAt(tokens, j + 1) > 0);
      });
      if (!whatIf) writes.push({ ...where(t.line), what: `${shown} (a cmdlet with a writing verb)` });
    }
  }

  // Functions: guarded when every call is inside a dry-run check, or in a function that is (greatest fixpoint)
  const safe = new Map<string, boolean>([...functions].map((f) => [f, true]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of functions) {
      if (!safe.get(f)) continue;
      const own = calls.filter((c) => c.name === f);
      if (own.some((c) => !c.guarded && c.fn !== f && (c.fn === null || safe.get(c.fn) === false))) {
        safe.set(f, false);
        changed = true;
      }
    }
  }
  const called = (f: string) => calls.some((c) => c.name === f && c.fn !== f);
  for (const w of writes) {
    if (w.guarded) continue;
    if (w.fn === null) {
      add(w.line, 'unguarded-write', `${w.what} outside a dry-run check: it would run in a dry run too.`);
      continue;
    }
    if (!called(w.fn) || safe.get(w.fn) !== false) continue;
    const outside = [...new Set(calls.filter((c) => c.name === w.fn && !c.guarded && c.fn !== w.fn && (c.fn === null || safe.get(c.fn) === false)).map((c) => c.line))];
    add(
      w.line,
      'unguarded-write',
      `${w.what} in function ${w.fn} without a dry-run check in the function, and the function is called outside a dry-run check ` +
        `(line${outside.length === 1 ? '' : 's'} ${outside.join(', ')}): it would run in a dry run too.`,
    );
  }

  const seen = new Set<string>();
  const unique = findings
    .sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
    .filter((f) => {
      const key = `${f.line}:${f.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { findings: unique, limitations: DRYRUN_LIMITATIONS };
}

/** A finding as one line of text, e.g. for a warning or a refusal. */
export function findingText(finding: DryRunFinding): string {
  return `line ${finding.line}: ${finding.kind}: ${finding.detail}${finding.text ? ` [${finding.text}]` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// The PowerShell scripts of a target system (as its export has them)

export interface ScriptRef {
  /** What it is, e.g. accountCreate, permission "Groups" grantPermissionScript, resource "Folders" script, uniqueness script. */
  name: string;
  /** A stable key: by the names of permission sets and resources, not their place in the list. */
  key: string;
  /** The path in the export (helloid_plan_edit's format), list items as [key=value] where they can be. */
  path: string;
  /** The same path with list items as their index. */
  concrete: string;
  script: string | null;
  /** Not used by HelloID with the system's settings (e.g. grantPermissionScript of a set that uses permissionActionScript). */
  unused: boolean;
}

const isScriptKey = (key: string) => /script$/i.test(key);
const scriptValue = (value: unknown): value is string | null => value === null || typeof value === 'string';

/**
 * The PowerShell scripts of a target system export (or of { configuration, resources }): the account
 * scripts (configuration.scripts), the scripts of every permission set (configuration.permissions[]),
 * of every resource (resources), and the uniqueness script.
 */
export function targetScripts(doc: Any): ScriptRef[] {
  const out: ScriptRef[] = [];
  const configuration = isPlainObject(doc?.configuration) ? (doc.configuration as Any) : {};
  const push = (name: string, key: string, segments: Segment[], script: string | null, unused = false) =>
    out.push({ name, key, path: readablePath(doc, segments), concrete: formatPath(segments), script, unused });
  if (isPlainObject(configuration.scripts)) {
    for (const [key, value] of Object.entries(configuration.scripts as Any)) {
      if (scriptValue(value)) push(key, `scripts.${key}`, [{ key: 'configuration' }, { key: 'scripts' }, { key }], value);
    }
  }
  const permissions: Any[] = Array.isArray(configuration.permissions) ? configuration.permissions : [];
  permissions.forEach((set, index) => {
    if (!isPlainObject(set)) return;
    const separate = (set as Any).useSeparateScriptForEachAction;
    for (const [key, value] of Object.entries(set)) {
      if (!isScriptKey(key) || !scriptValue(value)) continue;
      const unused =
        (separate === true && key === 'permissionActionScript') ||
        (separate === false && ['grantPermissionScript', 'revokePermissionScript', 'updatePermissionScript'].includes(key)) ||
        ((set as Any).useScriptToRetrievePermissions === false && key === 'retrievePermissionsScript');
      push(`permission "${(set as Any).displayName ?? index}" ${key}`, `permission:${(set as Any).displayName ?? index}:${key}`, [{ key: 'configuration' }, { key: 'permissions' }, { index }, { key }], value, unused);
    }
  });
  const resources: Any[] = Array.isArray(doc?.resources) ? doc.resources : Array.isArray(doc?.resources?.resources) ? doc.resources.resources : [];
  const listed = Array.isArray(doc?.resources);
  resources.forEach((resource, index) => {
    if (!isPlainObject(resource)) return;
    for (const [key, value] of Object.entries(resource)) {
      if (!isScriptKey(key) || !scriptValue(value)) continue;
      const segments: Segment[] = listed ? [{ key: 'resources' }, { index }, { key }] : [{ key: 'resources' }, { key: 'resources' }, { index }, { key }];
      push(`resource "${(resource as Any).displayName ?? index}" ${key}`, `resource:${(resource as Any).displayName ?? index}:${key}`, segments, value);
    }
  });
  const uniqueness = configuration.mappingConfiguration?.uniquenessConfiguration;
  if (isPlainObject(uniqueness) && scriptValue((uniqueness as Any).script)) {
    push('uniqueness script', 'uniqueness', [{ key: 'configuration' }, { key: 'mappingConfiguration' }, { key: 'uniquenessConfiguration' }, { key: 'script' }], (uniqueness as Any).script);
  }
  return out;
}

/** Whether a target system type has PowerShell scripts this check knows (PowerShell v2 and v1). */
export const isPowerShellSystem = (templateIdentifier: unknown) => templateIdentifier === 'powershell-target' || templateIdentifier === 'powershell-onpremise';

export interface ScriptWarning {
  ref: ScriptRef;
  findings: DryRunFinding[];
}

/**
 * The scripts of `after` that are new or different from `before` (by key), with their findings
 * (only those that have findings). before null: every script of after (a new system).
 */
export function changedScriptFindings(before: Any | null, after: Any, variant: ScriptVariant): ScriptWarning[] {
  const old = new Map((before ? targetScripts(before) : []).map((s) => [s.key, s.script]));
  return targetScripts(after)
    .filter((s) => (before ? !old.has(s.key) || old.get(s.key) !== s.script : typeof s.script === 'string' && s.script.trim() !== ''))
    .filter((s) => !(s.script === null && !old.get(s.key)))
    .map((s) => ({ ref: s, findings: checkDryRun(s.script, { variant }).findings }))
    .filter((w) => w.findings.length);
}

/** The warning lines of a script with findings (the rule, then each finding). */
export function scriptWarningLines(warning: ScriptWarning): string[] {
  return [
    `DryRun check of ${warning.ref.name} (${warning.ref.path}): ${warning.findings.length} finding(s); a warning only, the plan is not refused. ${DRYRUN_RULE} ` +
      'Test the script with the dry-run tools (helloid_dryrun_account_action, helloid_dryrun_permission_action, helloid_dryrun_permission_import, ' +
      'helloid_dryrun_uniqueness) only once these are fixed: they refuse a script with findings.',
    ...warning.findings.map(findingText),
  ];
}
