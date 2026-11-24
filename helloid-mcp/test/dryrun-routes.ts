// The gateway routes of the script tools (helloid_list_dryrun_persons, helloid_preview_field_mapping,
// helloid_dryrun_*) on the fake HelloID, in the response shapes of the recordings of HelloID's script
// editors. All data, scripts and secrets are made up.

import type { FakeHelloId, FakeRequest, FakeResponse } from './fake-helloid.ts';
import { type Fixture, IDS } from './fixture-routes.ts';

const ok = (body: unknown = ''): FakeResponse => ({ body });
const ID = '([^/]+)';
const exact = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\(ID\\)', ID)}$`);
const idOf = (request: FakeRequest, pattern: RegExp, group = 1) => decodeURIComponent(pattern.exec(request.path)?.[group] ?? '');

export const DRYRUN_IDS = {
  groups: 'c1000000-0000-4000-8000-000000000001',
  mailboxes: 'c1000000-0000-4000-8000-000000000002',
  sales: 'c2000000-0000-4000-8000-000000000001',
  finance: 'c2000000-0000-4000-8000-000000000002',
  shared: 'c2000000-0000-4000-8000-000000000003',
  fieldMail: 'c3000000-0000-4000-8000-000000000001',
  fieldName: 'c3000000-0000-4000-8000-000000000002',
  fieldBroken: 'c3000000-0000-4000-8000-000000000003',
} as const;

/** An account script in the Tools4ever connector style: the writes are guarded (one inside a function called under the guard). */
export const GOOD_CREATE = [
  '#################################################',
  '# HelloID-Conn-Prov-Target-Example-Create',
  '#################################################',
  '$outputContext.Success = $false',
  'function Invoke-ExampleRequest {',
  '    param($Splat)',
  '    Invoke-RestMethod @Splat -Verbose:$false',
  '}',
  'try {',
  '    $splatGet = @{ Uri = "$($actionContext.Configuration.BaseUrl)/users?filter={0}" -f $actionContext.Data.mail; Method = \'GET\' }',
  '    $existing = Invoke-RestMethod @splatGet',
  '    if (-not($actionContext.DryRun -eq $true)) {',
  '        $splatCreate = @{',
  '            Uri    = "$($actionContext.Configuration.BaseUrl)/users"',
  "            Method = 'POST'",
  '            Body   = ($actionContext.Data | ConvertTo-Json)',
  '        }',
  '        $created = Invoke-ExampleRequest -Splat $splatCreate',
  '        $outputContext.AccountReference = $created.id',
  '    } else {',
  "        Write-Information '[DryRun] Would create the account { not really }'",
  '    }',
  '    $outputContext.Success = $true',
  '} catch {',
  '    Write-Warning "Error: $($_.Exception.Message)"',
  '}',
].join('\r\n');

/** A script with a write outside the dry-run check (line 3). */
export const UNGUARDED_UPDATE = [
  '$outputContext.Success = $false',
  '$body = $actionContext.Data | ConvertTo-Json',
  'Invoke-RestMethod -Uri "$($actionContext.Configuration.BaseUrl)/users/$($actionContext.References.Account)" -Method Patch -Body $body',
  '$outputContext.Success = $true',
].join('\n');

export const GOOD_GRANT = [
  'if (-not($actionContext.DryRun -eq $true)) {',
  '    Add-ExampleGroupMember -Group $actionContext.References.Permission.Reference -User $actionContext.References.Account',
  '}',
  '$outputContext.Success = $true',
].join('\n');
export const GOOD_REVOKE = GOOD_GRANT.replace('Add-ExampleGroupMember', 'Remove-ExampleGroupMember');
export const OVERRIDE_UPDATE_PERMISSION = ['$actionContext.DryRun = $false', 'Set-ExampleGroup -Identity $actionContext.References.Permission.Reference'].join('\n');
export const GOOD_IMPORT = [
  '$groups = Invoke-RestMethod -Uri "$($actionContext.Configuration.BaseUrl)/groups" -Method Get',
  'foreach ($group in $groups) {',
  '    $outputContext.Permissions.Add(@{ DisplayName = $group.name; PermissionReference = @{ Reference = $group.id } })',
  '}',
].join('\n');
export const GOOD_UNIQUENESS = [
  '$outputContext.Success = $true',
  '$found = Invoke-RestMethod -Uri "$($actionContext.Configuration.BaseUrl)/users?mail=$($actionContext.Data.mail)"',
  'if ($found) { $outputContext.NonUniqueFields.Add("mail"); $outputContext.Success = $false }',
].join('\n');

/** The made-up secrets of the Alpha system; never in a tool output or the audit. */
export const ALPHA_SECRETS = ['alpha-client-secret-value', 'alpha-hidden-password'];

/** Gives the Alpha system scripts, permission sets and a mapping, and installs the script routes. */
export function installDryRunRoutes(fake: FakeHelloId, data: Fixture): Fixture {
  const route = (method: string, path: string | RegExp, handler: (request: FakeRequest) => FakeResponse) => fake.route(method, path, handler);
  const alpha = data.powershellConfigurations[IDS.alpha];
  alpha.executeOnPremises = false;
  alpha.scripts = { accountCreate: GOOD_CREATE, accountUpdate: UNGUARDED_UPDATE, accountEnable: '', accountDisable: null, accountDelete: GOOD_CREATE.replace("Method = 'POST'", "Method = 'DELETE'") };
  alpha.permissions = [
    {
      identification: DRYRUN_IDS.groups,
      displayName: 'Groups',
      hasSubPermissions: false,
      useSeparateScriptForEachAction: true,
      useScriptToRetrievePermissions: false,
      retrievePermissionsScript: null,
      grantPermissionScript: GOOD_GRANT,
      revokePermissionScript: GOOD_REVOKE,
      updatePermissionScript: OVERRIDE_UPDATE_PERMISSION,
      permissionActionScript: null,
      permissionImportScript: GOOD_IMPORT,
    },
    {
      identification: DRYRUN_IDS.mailboxes,
      displayName: 'Mailboxes',
      hasSubPermissions: true,
      useSeparateScriptForEachAction: false,
      permissionActionScript: GOOD_GRANT,
      grantPermissionScript: 'Remove-Everything',
      permissionImportScript: null,
    },
  ];
  alpha.mappingConfiguration = {
    fields: [
      {
        identifier: DRYRUN_IDS.fieldMail,
        name: 'mail',
        description: 'The e-mail address',
        type: 1,
        mappingActions: [
          { mappingActionId: 'c4000000-0000-4000-8000-000000000001', entitlementActions: [1, 3], mode: 1, value: '"Person.Contact.Business.Email"', usedInNotifications: true, storeInAccountData: true },
          { mappingActionId: 'c4000000-0000-4000-8000-000000000002', entitlementActions: [2, 4, 5], mode: 0, value: 'null', usedInNotifications: false, storeInAccountData: true },
        ],
      },
      {
        identifier: DRYRUN_IDS.fieldName,
        name: 'displayName',
        description: '',
        type: 1,
        mappingActions: [{ mappingActionId: 'c4000000-0000-4000-8000-000000000003', entitlementActions: [1], mode: 1, value: '"Person.DisplayName"', usedInNotifications: false, storeInAccountData: false }],
      },
      {
        identifier: DRYRUN_IDS.fieldBroken,
        name: 'broken',
        description: 'Fails for every person',
        type: 1,
        mappingActions: [{ mappingActionId: 'c4000000-0000-4000-8000-000000000004', entitlementActions: [1], mode: 3, value: 'function x {', usedInNotifications: false, storeInAccountData: false }],
      },
    ],
    uniquenessConfiguration: { script: GOOD_UNIQUENESS, mappingEntitlementActions: [1], selectedUniqueFields: [DRYRUN_IDS.fieldMail] },
  };
  data.permissionRows = {
    [DRYRUN_IDS.groups]: [
      { displayName: 'Sales', entitlementId: DRYRUN_IDS.sales, reference: { Id: 'grp-sales', Name: 'Sales', Type: 'Group' } },
      { displayName: 'Finance', entitlementId: DRYRUN_IDS.finance, reference: { Id: 'grp-finance', Name: 'Finance', Type: 'Group' } },
      { displayName: 'Shared', entitlementId: DRYRUN_IDS.shared, reference: { Id: 'grp-shared', Name: 'Shared', Type: 'Group' } },
    ],
    [DRYRUN_IDS.mailboxes]: [{ displayName: 'Shared', entitlementId: 'c2000000-0000-4000-8000-000000000009', reference: { Id: 'mbx-shared' } }],
  };
  data.dryRunRequests = [] as FakeRequest[];
  data.accountReferences ??= {};
  /** What the script "answers" (a test may change it); its log echoes a secret, as a careless script could. */
  data.dryRunAnswer ??= {
    resultData: {
      Data: { mail: 'anna@example.test', password: 'generated-password-value', note: 'uses alpha-client-secret-value' },
      PreviousData: null,
      AccountReference: 'acc-0001',
      AuditLogs: [{ Message: 'Account would be created', Action: 'CreateAccount', IsError: false }],
      Success: true,
      AccountCorrelated: false,
    },
    resultDataCount: 0,
    dataLimited: false,
    logMessages: [
      { messageTimeUtc: '2026-11-20T10:00:00.0000000Z', message: '[DryRun] Would create the account', level: 3 },
      { messageTimeUtc: '2026-11-20T10:00:01.0000000Z', message: 'Connected with secret alpha-client-secret-value', level: 3 },
    ],
    scriptExecutionSuccessful: true,
    errorMessage: null,
  };

  // The persons to pick
  route('GET', '/service/provisioning-integration/api/vault/latest/selection-persons', (r) => {
    const search = (r.query.get('search') ?? '').toLowerCase();
    const rows = data.persons.filter((p: any) => !search || String(p.displayName).toLowerCase().includes(search)).map((p: any) => ({ personId: p.personId, displayName: p.displayName }));
    const skip = Number(r.query.get('skip') ?? 0);
    const take = Number(r.query.get('take') ?? rows.length);
    return ok({ pageData: rows.slice(skip, skip + take), totalRowCount: rows.length });
  });
  // The person as the scripts see it
  const preview = exact('/service/rule-enforcement/api/entitlements/(ID)/(ID)/actions/data/preview');
  route('GET', preview, (r) => {
    const systemId = idOf(r, preview);
    const person = data.persons.find((p: any) => p.personId === idOf(r, preview, 2));
    if (!person) return { status: 404, body: { message: 'Not found' } };
    const accountKey = `_${systemId.replace(/-/g, '')}`;
    return ok({
      person: {
        accounts: data.accountReferences[person.personId] ? { [accountKey]: { mail: 'anna@example.test' } } : {},
        personId: person.personId,
        displayName: person.displayName,
        externalId: person.externalId ?? null,
        contact: { business: { email: 'person-private-mail@example.test' } },
        contracts: [],
      },
      accountReference: data.accountReferences[person.personId] ?? null,
      manager: null,
      managerAccountReference: null,
    });
  });
  // The field mapping and its preview
  const mapping = exact('/connector/powershell-target/api/mapping/(ID)');
  route('GET', mapping, (r) => {
    const configuration = data.powershellConfigurations[idOf(r, mapping)];
    return ok({ fields: configuration?.mappingConfiguration?.fields ?? [], fieldsNotInFilter: { count: 0, fieldNames: [] } });
  });
  const mappingPreview = exact('/connector/powershell-target/api/mapping/(ID)/preview');
  route('POST', mappingPreview, (r) => {
    data.dryRunRequests.push(r);
    const body = r.json as any;
    const answer: Record<string, unknown> = {};
    for (const field of body.fields) {
      if (!field.configuredForActions.includes(body.action)) continue;
      const broken = field.name === 'broken';
      answer[field.identifier] = {
        field: { identifier: field.identifier, name: field.name, type: field.type, mode: field.mappingActions[0]?.mode, value: field.mappingActions[0]?.value },
        currentIteration: 1,
        checkPerFieldUnique: false,
        isPerFieldUnique: false,
        isBulkUnique: false,
        value: broken ? null : `${field.name}-of-${body.personId.slice(-1)}`,
        hasError: broken,
        error: broken ? 'Unexpected end of script' : null,
      };
    }
    return ok(answer);
  });
  const uniqueness = exact('/connector/powershell-target/api/mapping/(ID)/uniqueness');
  route('GET', uniqueness, (r) => {
    const unique = data.powershellConfigurations[idOf(r, uniqueness)]?.mappingConfiguration?.uniquenessConfiguration ?? {};
    return ok({ script: unique.script ?? null, mappingEntitlementActions: unique.mappingEntitlementActions ?? [], selectedUniqueFields: unique.selectedUniqueFields ?? [] });
  });
  // The permissions of a permission set
  const permissions = exact('/connector/powershell-target/api/configuration/(ID)/permissions/(ID)');
  route('GET', permissions, (r) => {
    const rows = data.permissionRows[idOf(r, permissions, 2)] ?? [];
    const skip = Number(r.query.get('skip') ?? 0);
    const take = Number(r.query.get('take') ?? rows.length);
    return ok({ pageData: rows.slice(skip, skip + take), totalRowCount: rows.length });
  });
  // The dry runs
  route('POST', '/connector/powershell-target/api/preview/entitlement-action', (r) => {
    data.dryRunRequests.push(r);
    return ok(data.dryRunAnswer);
  });
  route('POST', '/connector/powershell-target/api/preview/permission-import', (r) => {
    data.dryRunRequests.push(r);
    return ok({
      resultData: [
        { displayName: 'Sales', permissionReference: { Name: 'Sales', Type: 'Group', Id: 'grp-sales' } },
        { displayName: 'Finance', permissionReference: { Name: 'Finance', Type: 'Group', Id: 'grp-finance' } },
        { displayName: 'Shared', permissionReference: { Name: 'Shared', Type: 'Group', Id: 'grp-shared' } },
      ],
      resultDataCount: 7,
      dataLimited: true,
      logMessages: [{ messageTimeUtc: '2026-11-20T10:00:00Z', message: 'Found 7 groups', level: 2 }],
      scriptExecutionSuccessful: true,
      errorMessage: null,
    });
  });
  route('POST', '/connector/powershell-target/api/preview/uniqueness-check', (r) => {
    data.dryRunRequests.push(r);
    return ok({
      resultData: { Success: false, NonUniqueFields: ['mail'], Iteration: null },
      resultDataCount: 0,
      dataLimited: false,
      logMessages: [{ messageTimeUtc: '2026-11-20T10:00:00Z', message: 'mail is in use', level: 2 }],
      scriptExecutionSuccessful: true,
      errorMessage: null,
    });
  });
  return data;
}
