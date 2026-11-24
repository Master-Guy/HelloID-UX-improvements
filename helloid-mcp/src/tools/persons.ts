// Read tools for persons and granted entitlements.

import { z } from 'zod';
import { cachebust, GATEWAY, TAKE_ALL } from '../helloid/endpoints.ts';
import { NotFoundError, rowsOf } from '../helloid/exports.ts';
import {
  bool,
  defineTool,
  exporterFor,
  num,
  page,
  pageOutput,
  pageText,
  pagingInput,
  readAnnotations,
  type ResolvedEnvironment,
  str,
  type ToolGroup,
} from './helpers.ts';
import { typeName } from './rules.ts';

const personRow = z.object({
  personId: z.string().nullable(),
  displayName: z.string().nullable(),
  externalId: z.string().nullable(),
  excluded: z.boolean().nullable(),
  blocked: z.boolean().nullable(),
  title: z.string().nullable().describe('Title of the primary contract'),
  department: z.string().nullable().describe('Department of the primary contract'),
  source: z.string().nullable().describe('The source system'),
});

const toPersonRow = (p: any) => ({
  personId: str(p?.personId),
  displayName: str(p?.displayName),
  externalId: str(p?.externalId),
  excluded: bool(p?.excluded),
  blocked: bool(p?.status?.blocked),
  title: str(p?.primaryContract?.title?.name),
  department: str(p?.primaryContract?.department?.displayName),
  source: str(p?.source?.displayName),
});

/** The persons overview, as HelloID's Persons page reads it. */
async function personsOverview(environment: ResolvedEnvironment, query: { skip: number; take: number; search: string }, now: () => number, signal?: AbortSignal) {
  return environment.client.gatewayJson<any>({
    path: GATEWAY.personsOverview,
    query: { ...query, cachebust: cachebust(now) },
    signal,
  });
}

export const listPersons = defineTool({
  name: 'helloid_list_persons',
  title: 'List persons',
  description:
    'Lists persons of the vault (ID, name, external ID, excluded, blocked, primary contract title and department, source), ' +
    'with HelloID\'s own search and paging. helloid_get_person gives one person in full. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {
    search: z.string().default('').describe('Text to search for, as in HelloID\'s Persons page (empty: all persons)'),
    ...pagingInput,
  },
  output: pageOutput(personRow, 'The persons'),
  annotations: readAnnotations,
  async handler(call, context) {
    const { offset, limit, search } = call.args;
    const answer = await personsOverview(call.environment, { skip: offset, take: limit, search }, context.now, call.signal);
    const items = rowsOf(answer).map(toPersonRow);
    const result = { total: num(answer?.totalRowCount) ?? offset + items.length, offset, limit, items };
    return { summary: pageText(result, `person(s)${search ? ` matching "${search}"` : ''}`), structured: result };
  },
});

export const getPerson = defineTool({
  name: 'helloid_get_person',
  title: 'Get a person',
  description:
    'Gets one person in full (contracts, accounts, contact details, custom fields), from the persons overview. Give the ' +
    'person\'s name or external ID as search to make it fast; without it, all persons are read to find the ID. ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {
    personId: z.string().min(1).describe('The person ID (helloid_list_persons)'),
    search: z.string().default('').describe('Text the person is found with in HelloID\'s search, e.g. the name or external ID'),
  },
  output: { person: z.record(z.string(), z.unknown()).describe('The person as HelloID gives it') },
  annotations: readAnnotations,
  async handler(call, context) {
    const { personId, search } = call.args;
    const answer = await personsOverview(call.environment, { skip: 0, take: TAKE_ALL, search }, context.now, call.signal);
    const person = rowsOf(answer).find((p) => p?.personId === personId);
    if (!person) {
      throw new NotFoundError(
        `There is no person '${personId}' in '${call.environment.name}'${search ? ` among the persons found with "${search}"` : ''}.`,
      );
    }
    return { summary: `Person "${person.displayName}" (${person.externalId ?? 'no external ID'}).`, structured: { person } };
  },
});

const grantedRow = z.object({
  personId: z.string().nullable(),
  personName: z.string().nullable(),
  systemId: z.string().nullable(),
  systemName: z.string().nullable(),
  entitlementId: z.string().nullable(),
  type: z.string().nullable().describe('Account, AccountAccess or Permission'),
  displayName: z.string().nullable(),
  permissionDefinitionDisplayName: z.string().nullable(),
  subPermissionCount: z.number().nullable(),
  lastChangedOnUtc: z.string().nullable(),
  hasOpenActions: z.boolean().nullable(),
});

/** The granted entitlements (of one person, or of all persons) as HelloID gives them. */
export async function readGranted(environment: ResolvedEnvironment, personId: string | undefined, signal?: AbortSignal) {
  return environment.client.gatewayJson<any>({
    path: GATEWAY.granted,
    query: { take: TAKE_ALL, ...(personId ? { person: personId } : {}), skip: 0 },
    signal,
  });
}

const sortKey = (value: unknown) => String(value ?? '');

export const listGrantedEntitlements = defineTool({
  name: 'helloid_list_granted_entitlements',
  title: 'List granted entitlements',
  description:
    'Lists the entitlements persons have right now (granted): of one person, of one target system, or all, in pages, ' +
    'sorted by person, type and name. HelloID has no request for one system: then all are read and those of the system kept ' +
    '(as the userscript\'s granted export does). Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {
    personId: z.string().min(1).optional().describe('Only this person'),
    systemId: z.string().min(1).optional().describe('Only this target system'),
    ...pagingInput,
  },
  output: {
    ...pageOutput(grantedRow, 'The granted entitlements'),
    complete: z.boolean().describe('false: HelloID returned as many rows as were asked for, so there may be more'),
    exceededTotalRowCountLimit: z.boolean().nullable().describe('What HelloID said about its own limit'),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const { personId, systemId, offset, limit } = call.args;
    const [granted, systems] = await Promise.all([
      readGranted(call.environment, personId, call.signal),
      exporterFor(call, context).fetchSystems().catch(() => []),
    ]);
    const all = rowsOf(granted);
    const rows = all
      .filter((row) => !systemId || row?.systemId === systemId)
      .map((row) => ({
        personId: str(row?.personEntitlementId?.personId),
        personName: str(row?.personName),
        systemId: str(row?.systemId),
        systemName: str(systems.find((s) => s?.systemId === row?.systemId)?.displayName),
        entitlementId: str(row?.entitlement?.entitlementId),
        type: typeName(row?.entitlement?.type),
        displayName: str(row?.entitlement?.displayName ?? row?.entitlementName),
        permissionDefinitionDisplayName: str(row?.entitlement?.permissionDefinitionDisplayName),
        subPermissionCount: num(row?.subPermissionCount),
        lastChangedOnUtc: str(row?.lastChangedOnUtc),
        hasOpenActions: bool(row?.hasOpenActions),
      }))
      .sort(
        (a, b) =>
          sortKey(a.personName).localeCompare(sortKey(b.personName)) ||
          sortKey(a.personId).localeCompare(sortKey(b.personId)) ||
          sortKey(a.type).localeCompare(sortKey(b.type)) ||
          sortKey(a.displayName).localeCompare(sortKey(b.displayName)),
      );
    const result = {
      ...page(rows, offset, limit),
      complete: all.length < TAKE_ALL,
      exceededTotalRowCountLimit: bool(granted?.exceededTotalRowCountLimit),
    };
    return { summary: pageText(result, 'granted entitlement(s)'), structured: result };
  },
});

export const personTools: ToolGroup = [listPersons, getPerson, listGrantedEntitlements];
