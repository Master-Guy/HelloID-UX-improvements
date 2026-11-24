// Partial changes to an export file (helloid_plan_edit): set, unset and list operations, checked
// against what the kind allows (the parts its import reads, its identity fields, its lists). Only
// what is listed changes; everything else stays as exported.
//
// Order: the list operations first, then the sets, then the unsets (each in the order given).

import { isPlainObject } from '../safety.ts';
import { EditError, formatPath, listsChanged, parsePath, patternOf, readablePath, resolvePath, type Segment, sameValue, valuesAtPattern } from './paths.ts';

type Any = any;

/** A list in an export file: how its items are matched, and the key HelloID gives each item (never changed). */
export interface ListSpec {
  /** The key HelloID gives an item (an ID): it cannot be set, changed or given in an added item. */
  idKey?: string;
  /** The keys that find an item (documented per list); an added item's match is made from the first one it has. */
  matchKeys: string[];
  /** The added item's match is made from all matchKeys together (e.g. agent tags: type and value). */
  matchAll?: boolean;
  /** The items are texts or numbers (match with { "$value": ... }). */
  primitive?: boolean;
}

/** What a kind of export file allows to change. */
export interface EditSpec {
  /** The top-level keys the import reads; '*' = every key except readOnly. Others are information only. */
  roots: string[] | '*';
  /** With roots '*': the top-level keys that are information only. */
  readOnly?: string[];
  /** The item's own identity (its ID, its type): cannot change. */
  identity: string[];
  /** Cannot be unset (the name). */
  required: string[];
  /** Texts that hold JSON: changed as the JSON in them (e.g. a source system's configuration). */
  jsonText?: string[];
  /** The lists, by pattern ([] for every item of a list). */
  lists: Record<string, ListSpec>;
}

/** A list that is not in the spec: items found by the keys given; added items matched by name, displayName or key. */
export const DEFAULT_LIST: ListSpec = { matchKeys: ['name', 'displayName', 'key'] };

export interface SetChange {
  path: string;
  value: unknown;
  replaceList?: boolean | undefined;
}

export interface ListChange {
  path: string;
  op: 'add' | 'remove' | 'change';
  match?: Record<string, unknown> | undefined;
  value?: unknown;
  replaceList?: boolean | undefined;
}

export interface Changes {
  set?: SetChange[] | undefined;
  unset?: string[] | undefined;
  lists?: ListChange[] | undefined;
}

/** One requested change as it was made: what it changed, from what to what. */
export interface ChangeDetail {
  /** set, unset, add, remove or change */
  change: string;
  /** The path as given. */
  path: string;
  /** The value's path, with list items as readable selectors. */
  target: string;
  /** A set that adds a property the export did not have (check the name: HelloID may ignore it). */
  newProperty: boolean;
  before: unknown;
  after: unknown;
  /** Warnings about this change (later phases add more checks here). */
  warnings: string[];
}

const dup = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** The list spec of a list's pattern. */
export function listSpecOf(spec: EditSpec, pattern: string): ListSpec {
  return spec.lists[pattern] ?? DEFAULT_LIST;
}

/** Whether an item matches: every key of match has that value (with "$value": the item itself). */
export function itemMatches(item: unknown, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(([key, value]) => {
    if (key === '$value') return sameValue(item, value);
    if (!isPlainObject(item)) return false;
    const own = item[key];
    if (sameValue(own, value)) return true;
    // (a number or true/false given as text, or the other way round)
    const primitive = (v: unknown) => v !== null && v !== undefined && ['string', 'number', 'boolean'].includes(typeof v);
    return primitive(own) && primitive(value) && String(own) === String(value);
  });
}

function checkRoot(spec: EditSpec, segments: Segment[], where: string): void {
  const first = segments[0];
  if (!first || !('key' in first)) throw new EditError(`${where}: a path starts with a key of the item.`);
  const roots = spec.roots;
  const allowed = roots === '*' ? !(spec.readOnly ?? []).includes(first.key) : roots.includes(first.key);
  if (!allowed) {
    const what = roots === '*' ? `every key except ${(spec.readOnly ?? []).join(', ')}` : roots.join(', ');
    throw new EditError(`${where}: "${first.key}" is information of the export that the import does not read; it cannot be changed (the import reads ${what}).`);
  }
}

/** Refuses a set or unset of an identity field, or of a list item's ID. */
function checkIdentity(spec: EditSpec, concrete: Segment[], where: string): void {
  const pattern = patternOf(concrete);
  if (spec.identity.includes(pattern)) throw new EditError(`${where}: ${pattern} is the item's identity; it cannot be changed.`);
  const last = concrete[concrete.length - 1];
  if (last && 'key' in last && concrete.length >= 2) {
    const listPattern = patternOf(concrete.slice(0, -2));
    const beforeLast = concrete[concrete.length - 2]!;
    if (!('key' in beforeLast)) {
      const list = listSpecOf(spec, listPattern);
      if (list.idKey === last.key) throw new EditError(`${where}: ${last.key} is the ID HelloID gives the items of ${listPattern}; it cannot be changed.`);
    }
  }
}

/** The values of the identity fields and of the list items' IDs (to check none changed or was made up). */
function identityValues(spec: EditSpec, doc: Any) {
  const own = Object.fromEntries(spec.identity.map((pattern) => [pattern, valuesAtPattern(doc, pattern)]));
  const ids = Object.fromEntries(
    Object.entries(spec.lists)
      .filter(([, list]) => list.idKey)
      .map(([pattern, list]) => [pattern, valuesAtPattern(doc, `${pattern}[].${list.idKey}`).map((v) => JSON.stringify(v))]),
  );
  return { own, ids };
}

/** JSON in texts made objects (and back), so a path can go into them. */
function parseJsonTexts(spec: EditSpec, doc: Any): string[] {
  const parsed: string[] = [];
  for (const path of spec.jsonText ?? []) {
    try {
      const found = resolvePath(doc, path);
      if (!found.exists || typeof found.value !== 'string') continue;
      const value = JSON.parse(found.value);
      if (value === null || typeof value !== 'object') continue;
      found.parent[found.key] = value;
      parsed.push(path);
    } catch {
      /* not JSON: left as text */
    }
  }
  return parsed;
}

function stringifyJsonTexts(doc: Any, paths: string[]): void {
  for (const path of paths) {
    const found = resolvePath(doc, path);
    if (found.exists && typeof found.value !== 'string') found.parent[found.key] = JSON.stringify(found.value);
  }
}

/**
 * Applies the changes to a copy of an export file. Throws EditError (which change, why) when a
 * path does not exist, a list would be replaced without replaceList, an identity field would
 * change, a list item is not found, or found more than once.
 */
export function applyChanges(original: Any, changes: Changes, spec: EditSpec): { doc: Any; details: ChangeDetail[] } {
  const doc = structuredClone(original);
  const jsonTexts = parseJsonTexts(spec, doc);
  const startDoc = structuredClone(doc);
  const details: ChangeDetail[] = [];

  // List operations
  for (const [n, change] of (changes.lists ?? []).entries()) {
    const where = `changes.lists[${n}] (${change.op} at ${JSON.stringify(change.path)})`;
    const segments = parsePath(change.path);
    checkRoot(spec, segments, where);
    const found = resolvePath(doc, segments, `${where}: the path`);
    if (!found.exists) throw new EditError(`${where}: the path does not exist.`);
    if (!Array.isArray(found.value)) throw new EditError(`${where}: the path is not a list.`);
    const list: Any[] = found.value;
    const pattern = patternOf(found.concrete);
    const listSpec = listSpecOf(spec, pattern);
    const target = readablePath(doc, found.concrete);
    const matching = (match: Record<string, unknown>) => list.flatMap((item, index) => (itemMatches(item, match) ? [index] : []));
    const describeMatch = (match: Record<string, unknown>) => JSON.stringify(match);
    if (change.match !== undefined && (!isPlainObject(change.match) || !Object.keys(change.match).length)) {
      throw new EditError(`${where}: match is an object with one or more keys (${listSpec.matchKeys.join(', ') || 'the keys of the item'}).`);
    }
    if (change.op === 'add') {
      if (change.value === undefined) throw new EditError(`${where}: add needs value (the new item).`);
      const value = dup(change.value);
      if (listSpec.idKey && isPlainObject(value) && listSpec.idKey in value) {
        throw new EditError(`${where}: leave ${listSpec.idKey} out of the new item: HelloID gives it.`);
      }
      let match = change.match;
      if (!match) {
        if (!isPlainObject(value)) match = { $value: value };
        else {
          const keys = listSpec.matchKeys.filter((k) => value[k] !== undefined && value[k] !== null);
          if (listSpec.matchAll && keys.length) match = Object.fromEntries(keys.map((k) => [k, value[k]]));
          else if (keys.length) match = { [keys[0]!]: value[keys[0]!] };
        }
      }
      if (!match) {
        throw new EditError(
          `${where}: give match (the keys that make the new item unique${listSpec.matchKeys.length ? `, e.g. ${listSpec.matchKeys.join(' or ')}` : ''}), so the add can check it is not there already.`,
        );
      }
      if (matching(match).length) throw new EditError(`${where}: the list has an item that matches ${describeMatch(match)} already; use op "change".`);
      list.push(value);
      details.push({ change: 'add', path: change.path, target: `${target}[${list.length - 1}]`, newProperty: false, before: null, after: value, warnings: [] });
      continue;
    }
    if (!change.match) {
      const example = listSpec.primitive ? '{"$value": ...}' : listSpec.matchKeys.map((k) => `{"${k}": ...}`).join(' or ') || '{"<key>": <value>}';
      throw new EditError(`${where}: ${change.op} needs match (e.g. ${example}).`);
    }
    const indexes = matching(change.match);
    if (!indexes.length) throw new EditError(`${where}: no item matches ${describeMatch(change.match)}.`);
    if (indexes.length > 1) throw new EditError(`${where}: ${indexes.length} items match ${describeMatch(change.match)}; give more keys in match.`);
    const index = indexes[0]!;
    const itemTarget = formatPath([...parsePath(target), ...parsePath(readablePath(list, [{ index }]))]);
    const before = list[index];
    if (change.op === 'remove') {
      if (change.value !== undefined) throw new EditError(`${where}: remove takes no value.`);
      list.splice(index, 1);
      details.push({ change: 'remove', path: change.path, target: itemTarget, newProperty: false, before, after: null, warnings: [] });
      continue;
    }
    // change: an object item gets the keys of value (its other keys stay); a text or number is replaced
    if (change.value === undefined) throw new EditError(`${where}: change needs value (for an object item: the keys to change).`);
    let after: Any;
    if (isPlainObject(before) && isPlainObject(change.value)) {
      if (listSpec.idKey && listSpec.idKey in change.value && !sameValue(change.value[listSpec.idKey], before[listSpec.idKey])) {
        throw new EditError(`${where}: ${listSpec.idKey} is the ID HelloID gives the item; it cannot be changed.`);
      }
      after = { ...before, ...dup(change.value) };
      const replaced = listsChanged(before, after);
      if (replaced.length && !change.replaceList) {
        throw new EditError(`${where}: this replaces the list(s) ${replaced.join(', ')} of the item; change their items with their own list operations, or add replaceList: true.`);
      }
    } else {
      after = dup(change.value);
      const replaced = listsChanged(before, after);
      if (replaced.length && !change.replaceList) throw new EditError(`${where}: this replaces a list; add replaceList: true to do that.`);
    }
    list[index] = after;
    details.push({ change: 'change', path: change.path, target: itemTarget, newProperty: false, before, after, warnings: [] });
  }

  // Sets
  for (const [n, change] of (changes.set ?? []).entries()) {
    const where = `changes.set[${n}] (${JSON.stringify(change.path)})`;
    if (change.value === undefined) throw new EditError(`${where}: set needs value.`);
    const segments = parsePath(change.path);
    checkRoot(spec, segments, where);
    const found = resolvePath(doc, segments, `${where}: the path`);
    checkIdentity(spec, found.concrete, where);
    const target = readablePath(doc, found.concrete);
    const value = dup(change.value);
    if (found.exists) {
      const replaced = listsChanged(found.value, value);
      if (replaced.length && !change.replaceList) {
        throw new EditError(
          `${where}: this replaces ${replaced[0] === '(the value itself)' ? 'a list' : `the list(s) ${replaced.join(', ')} in it`}. ` +
            'Change list items with list operations (add, remove, change), or add replaceList: true to this set to replace the whole list.',
        );
      }
    } else if (!isPlainObject(found.parent)) {
      throw new EditError(`${where}: the path does not exist.`);
    }
    const before = found.value;
    found.parent[found.key] = value;
    details.push({
      change: 'set',
      path: change.path,
      target,
      newProperty: !found.exists,
      before: found.exists ? before : null,
      after: value,
      warnings: found.exists ? [] : [`"${formatPath(found.concrete)}" is a new property: the export did not have it, so check its name (HelloID may ignore it).`],
    });
  }

  // Unsets
  for (const [n, path] of (changes.unset ?? []).entries()) {
    const where = `changes.unset[${n}] (${JSON.stringify(path)})`;
    const segments = parsePath(path);
    checkRoot(spec, segments, where);
    const found = resolvePath(doc, segments, `${where}: the path`);
    if (!found.exists) throw new EditError(`${where}: the path does not exist.`);
    checkIdentity(spec, found.concrete, where);
    const pattern = patternOf(found.concrete);
    if (spec.required.includes(pattern)) throw new EditError(`${where}: ${pattern} is required; it cannot be unset.`);
    if (segments.length === 1) throw new EditError(`${where}: a whole part of the export cannot be unset.`);
    if (Array.isArray(found.parent)) throw new EditError(`${where}: a list item is removed with a list operation (op "remove"), not unset.`);
    const target = readablePath(doc, found.concrete);
    const replaced = listsChanged(found.value, undefined);
    if (replaced.length) throw new EditError(`${where}: this removes the list(s) ${replaced.join(', ')}; remove their items with list operations instead.`);
    delete found.parent[found.key];
    details.push({ change: 'unset', path, target, newProperty: false, before: found.value, after: null, warnings: [] });
  }

  // No identity changed, no list item ID made up
  const before = identityValues(spec, startDoc);
  const after = identityValues(spec, doc);
  for (const [pattern, values] of Object.entries(after.own)) {
    if (!sameValue(values, before.own[pattern])) throw new EditError(`The changes change ${pattern}, the item's identity; it cannot be changed.`);
  }
  for (const [pattern, values] of Object.entries(after.ids)) {
    const known = new Set(before.ids[pattern]);
    const made = values.filter((v) => !known.has(v));
    if (made.length) {
      throw new EditError(`The changes give items of ${pattern} an ID (${spec.lists[pattern]!.idKey}) they did not have: ${made.join(', ')}. IDs are given by HelloID; leave them out.`);
    }
  }
  stringifyJsonTexts(doc, jsonTexts);
  return { doc, details };
}
