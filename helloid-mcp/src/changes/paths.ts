// Paths in the export files and partial changes to them (helloid_plan_edit), and the paths that
// helloid_compare and helloid_search_configuration report (so a path they give can be edited).
//
// A path is keys separated by dots, with list items in brackets:
//   configuration.scripts.accountCreate
//   configuration.mappingConfiguration.fields[name=mail].mappingActions[0].value
//   rule.entitlements[entitlementId="88888888-..."]
//   configuration.scriptConfiguration["key.with.dots"]
// [n] is the n-th item (0-based); [key=value] the one item whose key has that value (the value as
// text, or "quoted" as a JSON string); ["name"] a key that has dots or brackets in it.
//
// The data is HelloID's own JSON, of many shapes; it is handled as `any`, as the exports are.

import { canonicalJson, isPlainObject } from '../safety.ts';

type Any = any;

export type Segment = { key: string } | { index: number } | { select: string; value: string; quoted: boolean };

/** A change that cannot be made: the message says which one and why. */
export class EditError extends Error {
  override name = 'EditError';
}

/** Parses a path; throws EditError on a malformed one. */
export function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  const fail = (why: string): never => {
    throw new EditError(`The path ${JSON.stringify(path)} is not valid: ${why} (at character ${i + 1}).`);
  };
  const readQuoted = (): string => {
    // A JSON string: from the quote to the next unescaped quote
    let j = i + 1;
    while (j < path.length && path[j] !== '"') j += path[j] === '\\' ? 2 : 1;
    if (j >= path.length) fail('a quote is not closed');
    const text = path.slice(i, j + 1);
    i = j + 1;
    try {
      return JSON.parse(text) as string;
    } catch {
      return fail('a quoted text is not a valid JSON string');
    }
  };
  if (!path) fail('it is empty');
  while (i < path.length) {
    const ch = path[i]!;
    if (ch === '[') {
      i++;
      if (path[i] === '"') {
        const key = readQuoted();
        if (path[i] !== ']') fail('expected ] after a quoted key');
        i++;
        segments.push({ key });
      } else {
        const close = path.indexOf(']', i);
        const equals = path.indexOf('=', i);
        if (close === -1) fail('a [ is not closed');
        if (equals !== -1 && equals < close) {
          const select = path.slice(i, equals).trim();
          if (!select) fail('[=value] needs a key before the =');
          i = equals + 1;
          if (path[i] === '"') {
            const value = readQuoted();
            if (path[i] !== ']') fail('expected ] after a quoted value');
            i++;
            segments.push({ select, value, quoted: true });
          } else {
            const end = path.indexOf(']', i);
            segments.push({ select, value: path.slice(i, end).trim(), quoted: false });
            i = end + 1;
          }
        } else {
          const text = path.slice(i, close).trim();
          if (!/^\d+$/.test(text)) fail('[...] needs a number, key=value or a "quoted key"');
          segments.push({ index: Number(text) });
          i = close + 1;
        }
      }
      if (i < path.length && path[i] !== '.' && path[i] !== '[') fail('expected . or [ after ]');
      if (path[i] === '.') {
        i++;
        if (i >= path.length) fail('it ends with a dot');
      }
    } else {
      let j = i;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
      const key = path.slice(i, j);
      if (!key) fail('an empty key');
      if (key.includes(']')) fail('a ] without [');
      segments.push({ key });
      i = j;
      if (path[i] === '.') {
        i++;
        if (i >= path.length) fail('it ends with a dot');
      }
    }
  }
  return segments;
}

const BARE_KEY = /^[A-Za-z0-9_$@-]+$/;
const BARE_VALUE = /^[^\]"\s][^\]]*$/;

/** A path as text (the opposite of parsePath). */
export function formatPath(segments: readonly Segment[]): string {
  let text = '';
  for (const segment of segments) {
    if ('key' in segment) {
      if (BARE_KEY.test(segment.key)) text += (text ? '.' : '') + segment.key;
      else text += `[${JSON.stringify(segment.key)}]`;
    } else if ('index' in segment) {
      text += `[${segment.index}]`;
    } else {
      const value = !segment.quoted && BARE_VALUE.test(segment.value) && segment.value.trim() === segment.value ? segment.value : JSON.stringify(segment.value);
      text += `[${segment.select}=${value}]`;
    }
  }
  return text;
}

/** The path with every list item as [] (how list specs and identity paths are named). */
export function patternOf(segments: readonly Segment[]): string {
  let text = '';
  for (const segment of segments) {
    if ('key' in segment) text += (text ? '.' : '') + segment.key;
    else text += '[]';
  }
  return text;
}

/** Whether a value (of a list item's key) is the value of a [key=value] selector. */
function selects(value: unknown, segment: { value: string; quoted: boolean }): boolean {
  if (segment.quoted) return value === segment.value;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return String(value) === segment.value;
  return false;
}

/** The index of the one item a [key=value] selects; throws when none or several do. */
function selectIndex(list: Any[], segment: { select: string; value: string; quoted: boolean }, where: string): number {
  const found = list.flatMap((item, index) => (isPlainObject(item) && selects(item[segment.select], segment) ? [index] : []));
  if (found.length === 1) return found[0]!;
  const label = formatPath([segment]);
  if (!found.length) throw new EditError(`${where}: no item of the list matches ${label}.`);
  throw new EditError(`${where}: ${found.length} items of the list match ${label}; use more of the item (another key) or its index.`);
}

export interface Resolved {
  /** The value at the path; undefined when only its parent exists. */
  value: Any;
  /** Whether the last key exists (false: a new property of an object). */
  exists: boolean;
  parent: Any;
  /** The key in the parent (a number for a list item). */
  key: string | number;
  /** The path with list items as their index. */
  concrete: Segment[];
}

/**
 * Follows a path. Every step but the last must exist; the last may be missing from an object
 * (exists: false). Throws EditError when the path does not exist.
 */
export function resolvePath(doc: Any, path: string | Segment[], where = 'the path'): Resolved {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  const text = typeof path === 'string' ? path : formatPath(path);
  let parent: Any = undefined;
  let value: Any = doc;
  let key: string | number = '';
  let exists = true;
  const concrete: Segment[] = [];
  for (const [n, segment] of segments.entries()) {
    if (!exists) throw new EditError(`${where} ${JSON.stringify(text)} does not exist: ${JSON.stringify(formatPath(concrete))} is not there.`);
    const at = formatPath(concrete) || '(the item)';
    if ('key' in segment) {
      if (!isPlainObject(value)) {
        throw new EditError(`${where} ${JSON.stringify(text)} does not exist: ${at} is ${Array.isArray(value) ? 'a list (use [n] or [key=value])' : 'not an object'}.`);
      }
      parent = value;
      key = segment.key;
      exists = Object.prototype.hasOwnProperty.call(value, segment.key);
      value = exists ? value[segment.key] : undefined;
      concrete.push({ key: segment.key });
      if (!exists && n < segments.length - 1) {
        throw new EditError(`${where} ${JSON.stringify(text)} does not exist: ${JSON.stringify(formatPath(concrete))} is not there.`);
      }
    } else {
      if (!Array.isArray(value)) throw new EditError(`${where} ${JSON.stringify(text)} does not exist: ${at} is not a list.`);
      const index = 'index' in segment ? segment.index : selectIndex(value, segment, `${where} ${JSON.stringify(text)}`);
      if (index >= value.length) throw new EditError(`${where} ${JSON.stringify(text)} does not exist: ${at} has ${value.length} item(s).`);
      parent = value;
      key = index;
      value = value[index];
      concrete.push({ index });
    }
  }
  return { value, exists, parent, key, concrete };
}

/** The value at a path, or undefined when it is not there. */
export function valueAt(doc: Any, path: string | Segment[]): Any {
  try {
    const found = resolvePath(doc, path);
    return found.exists ? found.value : undefined;
  } catch {
    return undefined;
  }
}

/** Every value at a pattern (keys, [] for every item of a list). */
export function valuesAtPattern(doc: Any, pattern: string): Any[] {
  const parts = pattern.split(/(?=\[\])|\./).filter(Boolean);
  let values: Any[] = [doc];
  for (const part of parts) {
    if (part === '[]') values = values.flatMap((v) => (Array.isArray(v) ? v : []));
    else {
      const key = part.startsWith('[]') ? part.slice(2) : part;
      if (part.startsWith('[]')) values = values.flatMap((v) => (Array.isArray(v) ? v : []));
      if (key) values = values.flatMap((v) => (isPlainObject(v) && key in v ? [v[key]] : []));
    }
  }
  return values;
}

/** Keys that name a list item, in the order they are tried for a readable [key=value]. */
const LABEL_KEYS = ['name', 'displayName', 'key', 'eventType', 'externalId', 'identifier', 'systemId', 'entitlementId'];

/** A readable segment for a list item: [key=value] when that key is unique in the list, else [index]. */
export function itemSegment(list: readonly Any[], index: number): Segment {
  const item = list[index];
  if (isPlainObject(item)) {
    for (const key of LABEL_KEYS) {
      const value = item[key];
      if (value === null || value === undefined || !['string', 'number'].includes(typeof value) || String(value) === '') continue;
      if (list.filter((other) => isPlainObject(other) && String(other[key]) === String(value)).length !== 1) continue;
      return { select: key, value: String(value), quoted: typeof value === 'string' && !BARE_VALUE.test(String(value)) };
    }
  }
  return { index };
}

/** The concrete path with list items written as readable selectors (where the list allows). */
export function readablePath(doc: Any, concrete: readonly Segment[]): string {
  const out: Segment[] = [];
  let value: Any = doc;
  for (const segment of concrete) {
    if ('index' in segment && Array.isArray(value)) {
      out.push(itemSegment(value, segment.index));
      value = value[segment.index];
    } else if ('key' in segment) {
      out.push(segment);
      value = isPlainObject(value) ? value[segment.key] : undefined;
    } else {
      out.push(segment);
      value = undefined;
    }
  }
  return formatPath(out);
}

export const sameValue = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * The lists inside `before` (itself, or nested in it) that `after` changes: their paths relative to
 * `before`. Used to refuse replacing a list by accident.
 */
export function listsChanged(before: Any, after: Any, at = ''): string[] {
  if (Array.isArray(before)) return sameValue(before, after) ? [] : [at || '(the value itself)'];
  if (!isPlainObject(before)) return [];
  return Object.keys(before).flatMap((key) => listsChanged(before[key], isPlainObject(after) ? after[key] : undefined, at ? `${at}.${key}` : key));
}
