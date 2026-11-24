// helloid_compare and helloid_search_configuration: read-only tools over the exports of one or more
// environments (secrets masked, as the helloid_get_* tools give them).

import { z } from 'zod';
import { compareValues, COMPARE_NOTE, type Difference, idNames, normalizeForCompare } from '../changes/compare.ts';
import { canonicalKind, CANONICAL_KINDS, type CanonicalKind, ITEM_KINDS, type ItemKind, ItemReader, KINDS } from '../changes/kinds.ts';
import { formatPath, itemSegment, type Segment, valueAt } from '../changes/paths.ts';
import { inBatches } from '../helloid/exports.ts';
import { errorMessage } from '../log.ts';
import { isPlainObject, SECRET_MASK, SECRET_NAME } from '../safety.ts';
import type { AppContext } from './context.ts';
import {
  DEFAULT_LIMIT,
  defineTool,
  environmentWithAccess,
  exporterForEnvironment,
  loggedInEnvironments,
  pagingInput,
  readAnnotations,
  type ResolvedEnvironment,
  type ToolGroup,
} from './helpers.ts';

type Any = any;

/** Environments read at the same time. */
export const ENVIRONMENT_BATCH = 4;

const kindInput = z.enum(ITEM_KINDS).describe('The kind of item (as helloid_plan_edit; toxicPolicy = toxicCombination)');

const unavailableOutput = z.object({ environment: z.string(), reason: z.string() });

/** The environments to read: the ones given (checked), else every logged-in one. */
function environmentsToRead(context: AppContext, names: string[] | undefined) {
  const wanted = names?.length ? [...new Set(names)] : loggedInEnvironments(context);
  const ready: ResolvedEnvironment[] = [];
  const unavailable: Array<{ environment: string; reason: string }> = [];
  for (const name of wanted) {
    try {
      const environment = environmentWithAccess(context, name, 'read');
      const state = environment.session.state;
      if (state !== 'logged-in') unavailable.push({ environment: name, reason: state === 'expired' ? 'the session has expired: helloid_login' : 'not logged in: helloid_login' });
      else ready.push(environment);
    } catch (error) {
      unavailable.push({ environment: name, reason: errorMessage(error) });
    }
  }
  return { ready, unavailable };
}

// ---------------------------------------------------------------------------------------------
// Compare

const sideInput = z.object({
  environment: z.string().min(1),
  kind: kindInput,
  id: z.string().optional(),
  name: z.string().optional().describe('Instead of id (refused when not unique)'),
});

const differenceOutput = z.object({
  path: z.string().describe('Where it differs (an edit path: list items as [key=value])'),
  left: z.string().nullable().describe('The reference\'s value (the left item, or the first group); null when only right has it'),
  right: z.string().nullable().describe('This side\'s value; null when only left has it'),
  onlyIn: z.enum(['left', 'right']).nullable(),
  diff: z.string().nullable().describe('Texts (scripts): a unified diff from left to right, cut'),
});

const groupOutput = z.object({
  group: z.number().describe('0 is the reference'),
  environments: z.array(z.string()).describe('The environments whose item is identical (after leaving out what differs by nature)'),
  total: z.number().describe('The number of differences from the reference group'),
  offset: z.number(),
  limit: z.number(),
  differences: z.array(differenceOutput),
});

/** The export of an item, normalized for comparing; its kind's identity fields left out. */
async function comparable(environment: ResolvedEnvironment, context: AppContext, signal: AbortSignal, kind: CanonicalKind, by: { id?: string | undefined; name?: string | undefined }) {
  const reader = new ItemReader(exporterForEnvironment(environment, context, signal, true));
  const item = await reader.find(kind, by);
  const doc = structuredClone(await reader.read(kind, item));
  for (const path of KINDS[kind].spec.identity) {
    const parts = path.split('.');
    const last = parts.pop()!;
    const parent = parts.length ? valueAt(doc, parts.join('.')) : doc;
    if (isPlainObject(parent)) delete parent[last];
  }
  const systems = await reader.systems().catch(() => null);
  const names = idNames(doc, (systems?.all ?? []).map((s: Any) => ({ id: s.systemId, name: s.displayName })));
  return { item, normalized: normalizeForCompare(doc, names) };
}

function compareDefinition() {
  return {
    name: 'helloid_compare',
    title: 'Compare items',
    description:
      'Compares the exports of items (as the helloid_get_* tools give them, secrets masked). Either two items: left and right, each ' +
      '{environment, kind, id or name} (the same item in two environments, or two items); or the same item by name in several ' +
      'environments: kind and name (no name for a settings page), and environments (default: every logged-in one). What differs by ' +
      'nature is left out: the export header, change and run times (lastChanged, lastRunTime, ...), IDs (compared as the name of what ' +
      'they point at), what HelloID fills in itself. Returns per path the differences (scripts as unified diffs, cut), in pages ' +
      '(offset, limit); for several environments, the groups of environments that are identical, and per group the differences from ' +
      'the first (largest) group. Paths are edit paths (helloid_plan_edit). Changes nothing. Works in every mode.',
    access: 'none' as const,
    environment: false as const,
    input: {
      left: sideInput.optional(),
      right: sideInput.optional(),
      kind: kindInput.optional().describe('The same item across environments: its kind'),
      name: z.string().optional().describe('The same item across environments: its name (not for a settings page)'),
      environments: z.array(z.string().min(1)).optional().describe('The environments to compare (default: every logged-in one)'),
      ...pagingInput,
    },
    output: {
      form: z.enum(['pair', 'environments']),
      kind: z.string(),
      identical: z.boolean().describe('Whether every item compared is identical'),
      items: z.array(z.object({ environment: z.string(), id: z.string().nullable(), name: z.string().nullable(), group: z.number() })),
      groups: z.array(groupOutput),
      missing: z.array(z.string()).describe('Environments that have no such item'),
      unavailable: z.array(unavailableOutput).describe('Environments that could not be read (not logged in, refused)'),
      notes: z.array(z.string()),
    },
    annotations: readAnnotations,
  };
}

async function runCompare(call: { args: Any; signal: AbortSignal }, context: AppContext) {
  const { offset = 0, limit = DEFAULT_LIMIT } = call.args;
  const sides: Array<{ label: string; environment: ResolvedEnvironment; kind: CanonicalKind; by: { id?: string; name?: string } }> = [];
  const missing: string[] = [];
  let unavailable: Array<{ environment: string; reason: string }> = [];
  let form: 'pair' | 'environments';
  let kind: CanonicalKind;
  if (call.args.left || call.args.right) {
    if (!call.args.left || !call.args.right) throw new Error('Give both left and right (or kind and name to compare across environments).');
    if (call.args.kind || call.args.name || call.args.environments) throw new Error('Give either left and right, or kind, name and environments; not both.');
    form = 'pair';
    kind = canonicalKind(call.args.left.kind);
    if (canonicalKind(call.args.right.kind) !== kind) throw new Error('left and right must be of the same kind.');
    for (const side of [call.args.left, call.args.right]) {
      const environment = environmentWithAccess(context, side.environment, 'read');
      sides.push({ label: side.environment, environment, kind, by: { id: side.id, name: side.name } });
    }
  } else {
    if (!call.args.kind) throw new Error('Give left and right, or kind (and name) to compare the same item across environments.');
    form = 'environments';
    kind = canonicalKind(call.args.kind);
    if (!KINDS[kind].single && !call.args.name) throw new Error(`Give the name of the ${KINDS[kind].label} to compare across environments.`);
    const { ready, unavailable: notReady } = environmentsToRead(context, call.args.environments);
    unavailable = notReady;
    for (const environment of ready) sides.push({ label: environment.name, environment, kind, by: { name: call.args.name } });
    if (ready.length < 2 && !call.args.environments) throw new Error('Fewer than two environments are logged in: log in to more, or name the environments.');
  }
  const read = await inBatches(sides, async (side) => {
    try {
      return { side, ...(await comparable(side.environment, context, call.signal, side.kind, side.by)) };
    } catch (error) {
      if (form === 'environments' && (error as Error).name === 'NotFoundError') {
        missing.push(side.label);
        return null;
      }
      if (form === 'environments') {
        unavailable.push({ environment: side.label, reason: errorMessage(error) });
        return null;
      }
      throw new Error(`${side.label}: ${errorMessage(error)}`);
    }
  }, ENVIRONMENT_BATCH);
  const found = read.filter((r): r is NonNullable<typeof r> => r !== null);
  // Groups of identical items; the first (largest) is the reference
  const groups: Array<{ members: typeof found; key: string }> = [];
  for (const entry of found) {
    const key = JSON.stringify(entry.normalized);
    const group = form === 'pair' ? undefined : groups.find((g) => g.key === key);
    if (group) group.members.push(entry);
    else if (form === 'pair' && groups.length && groups[0]!.key === key) groups[0]!.members.push(entry);
    else groups.push({ members: [entry], key });
  }
  if (form === 'environments') groups.sort((a, b) => b.members.length - a.members.length);
  const reference = groups[0]?.members[0]?.normalized;
  const groupRows = groups.map((group, index) => {
    const differences: Difference[] = index === 0 ? [] : compareValues(reference, group.members[0]!.normalized);
    return {
      group: index,
      environments: group.members.map((m) => m.side.label),
      total: differences.length,
      offset,
      limit,
      differences: differences.slice(offset, offset + limit),
    };
  });
  const items = groups.flatMap((group, index) => group.members.map((m) => ({ environment: m.side.label, id: m.item.id, name: m.item.name, group: index })));
  const identical = groups.length <= 1 && found.length > 0;
  const label = KINDS[kind].label;
  const summary =
    form === 'pair'
      ? identical
        ? `The two ${label}s are identical (after leaving out what differs by nature).`
        : `The two ${label}s differ in ${groupRows[1]?.total ?? 0} place(s)${(groupRows[1]?.total ?? 0) > offset + limit ? ' (use offset for more)' : ''}.`
      : `${label} "${call.args.name ?? label}" in ${found.length} environment(s): ${groups.length} group(s) of identical ones` +
        `${groups.length > 1 ? ` (reference: ${groupRows[0]!.environments.join(', ')})` : ''}` +
        `${missing.length ? `; missing in ${missing.join(', ')}` : ''}${unavailable.length ? `; not read: ${unavailable.map((u) => u.environment).join(', ')}` : ''}.`;
  return {
    summary,
    structured: { form, kind, identical, items, groups: groupRows, missing, unavailable, notes: [COMPARE_NOTE] },
  };
}

// ---------------------------------------------------------------------------------------------
// Search

const matchOutput = z.object({
  environment: z.string(),
  kind: z.string(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  path: z.string().describe('Where (an edit path)'),
  line: z.number().nullable().describe('The line number in a text of several lines (1-based); null for a one-line value'),
  text: z.string().describe('The matching line (trimmed, at most 300 characters)'),
  before: z.string().nullable().describe('The line before (texts of several lines)'),
  after: z.string().nullable().describe('The line after'),
});

/** Keys of the export header: not searched. */
const HEADER_KEYS = new Set(['exportedAt', 'exportedFrom', 'exportedBy', 'contents', 'secretsIncluded']);
const LINE_CHARS = 300;
const cut = (line: string) => {
  const text = line.trim();
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS)}…` : text;
};

type Found = { path: string; line: number | null; text: string; before: string | null; after: string | null };

/** Every value of a document that matches (never a secret: masked values and secret names are skipped). */
export function searchDocument(doc: Any, test: (text: string) => boolean): Found[] {
  const found: Found[] = [];
  const walk = (value: Any, at: Segment[], key: string | undefined) => {
    if (typeof value === 'string') {
      if (value === SECRET_MASK || (key !== undefined && SECRET_NAME.test(key))) return;
      const lines = value.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length === 1) {
        if (test(value)) found.push({ path: formatPath(at), line: null, text: cut(value), before: null, after: null });
        return;
      }
      lines.forEach((line, i) => {
        if (!test(line)) return;
        found.push({
          path: formatPath(at),
          line: i + 1,
          text: cut(line),
          before: i > 0 ? cut(lines[i - 1]!) : null,
          after: i < lines.length - 1 ? cut(lines[i + 1]!) : null,
        });
      });
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      if (key !== undefined && SECRET_NAME.test(key)) return;
      if (test(String(value))) found.push({ path: formatPath(at), line: null, text: String(value), before: null, after: null });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...at, itemSegment(value, i)], key));
    else if (isPlainObject(value)) {
      for (const [k, inner] of Object.entries(value)) {
        if (!at.length && HEADER_KEYS.has(k)) continue;
        if (SECRET_NAME.test(k) && !isPlainObject(inner) && !Array.isArray(inner)) continue;
        walk(inner, [...at, { key: k }], k);
      }
    }
  };
  walk(doc, [], undefined);
  return found;
}

function searchDefinition() {
  return {
    name: 'helloid_search_configuration',
    title: 'Search the configuration',
    description:
      'Searches the configuration of one or more environments: the exports (as the helloid_get_* tools give them, secrets masked) of ' +
      'target systems (scripts, configuration, mappings, fields, permissions, resources), source systems, notification systems, ' +
      'notifications, custom events, business rules, toxic combinations, schedules and the settings pages. Plain text, case-insensitive ' +
      'by default (caseSensitive: true to match case); regex: true for a regular expression. Secret values are never searched or ' +
      'returned. Per match: environment, kind, item ID and name, path (an edit path), the line number in a text of several lines, the ' +
      'line, and the lines before and after. environments: default every logged-in one; kinds: default all. In pages (offset, limit). ' +
      'Reading every export takes a while for many environments. Changes nothing. Works in every mode.',
    access: 'none' as const,
    environment: false as const,
    input: {
      query: z.string().min(1).describe('The text to find (or a regular expression with regex: true)'),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      environments: z.array(z.string().min(1)).optional().describe('Default: every logged-in environment'),
      kinds: z.array(kindInput).optional().describe('Default: every kind'),
      ...pagingInput,
    },
    output: {
      total: z.number(),
      offset: z.number(),
      limit: z.number(),
      matches: z.array(matchOutput),
      searched: z.array(z.object({ environment: z.string(), items: z.number() })).describe('Per environment, the number of items searched'),
      unavailable: z.array(unavailableOutput),
      errors: z.array(z.object({ environment: z.string(), kind: z.string(), item: z.string().nullable(), error: z.string() })).describe('Items or lists that could not be read'),
    },
    annotations: readAnnotations,
  };
}

async function runSearch(call: { args: Any; signal: AbortSignal; progress(p: number, m?: string): Promise<void> }, context: AppContext) {
  const { query, regex, caseSensitive, offset = 0, limit = DEFAULT_LIMIT } = call.args;
  let test: (text: string) => boolean;
  if (regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (error) {
      throw new Error(`query is not a valid regular expression: ${errorMessage(error)}`);
    }
    test = (text) => pattern.test(text);
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    test = (text) => (caseSensitive ? text : text.toLowerCase()).includes(needle);
  }
  const kinds: CanonicalKind[] = call.args.kinds?.length ? [...new Set((call.args.kinds as ItemKind[]).map(canonicalKind))] : [...CANONICAL_KINDS];
  const { ready, unavailable } = environmentsToRead(context, call.args.environments);
  if (!ready.length) throw new Error(`No environment to search${unavailable.length ? `: ${unavailable.map((u) => `${u.environment} (${u.reason})`).join(', ')}` : ' (log in first)'}.`);
  const matches: Array<z.infer<typeof matchOutput>> = [];
  const searched: Array<{ environment: string; items: number }> = [];
  const errors: Array<{ environment: string; kind: string; item: string | null; error: string }> = [];
  let done = 0;
  await inBatches(
    ready,
    async (environment) => {
      const reader = new ItemReader(exporterForEnvironment(environment, context, call.signal, true));
      let items = 0;
      for (const kind of kinds) {
        let refs;
        try {
          refs = await reader.list(kind);
        } catch (error) {
          call.signal.throwIfAborted();
          errors.push({ environment: environment.name, kind, item: null, error: errorMessage(error) });
          continue;
        }
        await inBatches(refs, async (ref) => {
          try {
            const doc = await reader.read(kind, ref);
            items++;
            for (const hit of searchDocument(doc, test)) matches.push({ environment: environment.name, kind, id: ref.id, name: ref.name, ...hit });
          } catch (error) {
            call.signal.throwIfAborted();
            errors.push({ environment: environment.name, kind, item: ref.name ?? ref.id, error: errorMessage(error) });
          }
        });
      }
      searched.push({ environment: environment.name, items });
      await call.progress(++done, `searched ${environment.name}`);
    },
    ENVIRONMENT_BATCH,
  );
  const order = (name: string) => ready.findIndex((e) => e.name === name);
  matches.sort(
    (a, b) =>
      order(a.environment) - order(b.environment) ||
      kinds.indexOf(a.kind as CanonicalKind) - kinds.indexOf(b.kind as CanonicalKind) ||
      String(a.name).localeCompare(String(b.name)) ||
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  searched.sort((a, b) => order(a.environment) - order(b.environment));
  const shown = matches.slice(offset, offset + limit);
  const summary =
    `${matches.length} match(es) of ${JSON.stringify(query)} in ${searched.length} environment(s)` +
    `${matches.length > offset + shown.length ? `; showing ${offset + 1}-${offset + shown.length} (use offset for more)` : ''}` +
    `${unavailable.length ? `; not searched: ${unavailable.map((u) => u.environment).join(', ')}` : ''}${errors.length ? `; ${errors.length} could not be read` : ''}.`;
  return { summary, structured: { total: matches.length, offset, limit, matches: shown, searched, unavailable, errors } };
}


export const helloidCompare = defineTool({ ...compareDefinition(), handler: (call, context) => runCompare(call, context) });
export const helloidSearch = defineTool({ ...searchDefinition(), handler: (call, context) => runSearch(call, context) });

export const compareTools: ToolGroup = [helloidCompare, helloidSearch];
