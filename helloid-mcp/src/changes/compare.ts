// Comparing export files (helloid_compare): what differs per path, leaving out what differs between
// environments by nature. Left out, as the import's planners do where they compare (sameNotification,
// changedParts): the export header (exportedAt, exportedFrom, exportedBy), when items were changed
// or ran (lastChanged, lastChange, lastRunTime, changeId), what HelloID fills in itself (tenantUrl,
// verifiedDomains), and null next to missing. IDs differ per environment: every ID (a GUID, or an
// account reference _<ID without dashes>) is compared as the name of what it points at when the
// export or the environment's systems know it (<Alpha Directory>), else as <id>.

import { isPlainObject, SECRET_MASK } from '../safety.ts';
import { isText, preview, textDiff } from './diff.ts';
import { formatPath, itemSegment, type Segment, sameValue } from './paths.ts';

type Any = any;

/** Keys left out of a comparison. */
export const VOLATILE_KEYS = new Set([
  'exportedAt',
  'exportedFrom',
  'exportedBy',
  'lastChanged',
  'lastChange',
  'lastRunTime',
  'changeId',
  'tenantUrl',
  'verifiedDomains',
]);

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ACCOUNT_REFERENCE = /_([0-9a-f]{32})\b/gi;
/** Keys of an object that hold its ID, with the key of its name. */
const ID_NAME_KEYS: Array<[string, string]> = [
  ['systemId', 'displayName'],
  ['entitlementId', 'displayName'],
  ['ruleId', 'name'],
  ['ruleId', 'ruleName'],
  ['customEventId', 'name'],
  ['toxicCombinationId', 'name'],
  ['scheduleId', 'name'],
  ['identifier', 'name'],
  ['identification', 'displayName'],
  ['resourceDefinitionId', 'displayName'],
  ['scriptId', 'displayName'],
  ['templateId', 'displayName'],
];

/** The names of the IDs an export file knows (systems, entitlements, rules, mapping fields, ...). */
export function idNames(doc: Any, extra: Array<{ id: unknown; name: unknown }> = []): Map<string, string> {
  const names = new Map<string, string>();
  const add = (id: unknown, name: unknown) => {
    if (typeof id === 'string' && typeof name === 'string' && name.trim() && !names.has(id.toLowerCase())) names.set(id.toLowerCase(), name.trim());
  };
  for (const { id, name } of extra) add(id, name);
  const walk = (value: Any) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isPlainObject(value)) {
      for (const [idKey, nameKey] of ID_NAME_KEYS) add(value[idKey], value[nameKey]);
      Object.values(value).forEach(walk);
    }
  };
  walk(doc);
  return names;
}

/** An export file as it is compared (see the top of this file). */
export function normalizeForCompare(doc: Any, names: Map<string, string>): Any {
  const nameOf = (id: string) => {
    const name = names.get(id.toLowerCase());
    return name ? `<${name}>` : '<id>';
  };
  const dashed = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const text = (value: string) => value.replace(GUID, (id) => nameOf(id)).replace(ACCOUNT_REFERENCE, (_m, hex: string) => `_${nameOf(dashed(hex))}`);
  const walk = (value: Any): Any => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key, inner]) => !VOLATILE_KEYS.has(key) && inner !== null && inner !== undefined)
          .map(([key, inner]) => [key, walk(inner)]),
      );
    }
    return value;
  };
  return walk(doc);
}

/** One difference: the reference's value (left) and the other's (right). */
export interface Difference {
  path: string;
  /** A preview of the left value; null when only right has it. */
  left: string | null;
  right: string | null;
  /** left or right: the item or value is only on that side. */
  onlyIn: 'left' | 'right' | null;
  /** Texts (scripts): a unified diff from left to right, cut. */
  diff: string | null;
}

/** The key that pairs the items of two lists: unique on both sides, a text or number in every item. */
function pairingKey(a: Any[], b: Any[]): string | undefined {
  const candidates = ['name', 'displayName', 'key', 'eventType', 'externalId', 'ruleName', 'field'];
  const usable = (list: Any[], key: string) => {
    if (!list.every((i) => isPlainObject(i) && ['string', 'number'].includes(typeof i[key]))) return false;
    return new Set(list.map((i) => String(i[key]))).size === list.length;
  };
  return candidates.find((key) => (a.length || b.length) && usable(a, key) && usable(b, key));
}

const lastKey = (segments: Segment[]) => {
  const last = segments[segments.length - 1];
  return last && 'key' in last ? last.key : undefined;
};

/** The differences between two (normalized) export files. */
export function compareValues(left: Any, right: Any, at: Segment[] = []): Difference[] {
  if (sameValue(left, right)) return [];
  const path = formatPath(at) || '(the item)';
  const key = lastKey(at);
  if (left === undefined || right === undefined) {
    return [{ path, left: left === undefined ? null : preview(left, key), right: right === undefined ? null : preview(right, key), onlyIn: left === undefined ? 'right' : 'left', diff: null }];
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...Object.keys(left), ...Object.keys(right).filter((k) => !(k in left))];
    return keys.flatMap((k) => compareValues(left[k], right[k], [...at, { key: k }]));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const byKey = pairingKey(left, right);
    if (byKey) {
      const values = [...left.map((i) => String(i[byKey])), ...right.map((i) => String(i[byKey])).filter((v) => !left.some((l) => String(l[byKey]) === v))];
      return values.flatMap((value) => {
        const segment: Segment = { select: byKey, value, quoted: false };
        return compareValues(
          left.find((i) => String(i[byKey]) === value),
          right.find((i) => String(i[byKey]) === value),
          [...at, segment],
        );
      });
    }
    // Items that are the same on both sides are paired; the others are only on one side
    const rightLeft = [...right.keys()];
    const onlyLeft: number[] = [];
    left.forEach((item, i) => {
      const j = rightLeft.findIndex((r) => sameValue(right[r], item));
      if (j === -1) onlyLeft.push(i);
      else rightLeft.splice(j, 1);
    });
    if (left.every((i) => !isPlainObject(i) && !Array.isArray(i)) && right.every((i) => !isPlainObject(i) && !Array.isArray(i))) {
      return [
        {
          path,
          left: preview(left, key),
          right: preview(right, key),
          onlyIn: null,
          diff: [...onlyLeft.map((i) => `- ${JSON.stringify(left[i])}`), ...rightLeft.map((j) => `+ ${JSON.stringify(right[j])}`)].join('\n') || null,
        },
      ];
    }
    return [
      ...onlyLeft.map((i): Difference => ({ path: formatPath([...at, itemSegment(left, i)]), left: preview(left[i], key), right: null, onlyIn: 'left', diff: null })),
      ...rightLeft.map((j): Difference => ({ path: formatPath([...at, itemSegment(right, j)]), left: null, right: preview(right[j], key), onlyIn: 'right', diff: null })),
    ];
  }
  if (typeof left === 'string' && typeof right === 'string' && (isText(left) || isText(right))) {
    const diff = textDiff(left, right);
    return [{ path, left: preview(left, key), right: preview(right, key), onlyIn: null, diff: `${diff.removed} line(s) removed, ${diff.added} added\n${diff.diff}` }];
  }
  return [{ path, left: preview(left, key), right: preview(right, key), onlyIn: null, diff: null }];
}

/** A note for the answer: what a comparison leaves out. */
export const COMPARE_NOTE =
  'Left out: the export header, when items were changed or ran (lastChanged, lastChange, lastRunTime, changeId), what HelloID fills in ' +
  `itself (tenantUrl, verifiedDomains), and null next to missing. IDs are compared as the name of what they point at (<name>), else as <id>. ` +
  `Secrets are masked (${SECRET_MASK}) on both sides, so they are not compared.`;
