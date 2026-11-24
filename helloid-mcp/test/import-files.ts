// Synthetic export files for the import tests, in the userscript's export formats, built from the
// synthetic fixture (another environment's IDs where the test needs matching by name).

import { IDS, type Fixture } from './fixture-routes.ts';

export const EMPTY_ID = '00000000-0000-0000-0000-000000000000';
/** IDs of another environment: not in the fixture. */
export const OTHER = {
  delta: 'd0000000-0000-4000-8000-000000000001',
  alphaThere: 'd0000000-0000-4000-8000-000000000002',
  teams: 'd0000000-0000-4000-8000-000000000003',
  deltaRule: 'd0000000-0000-4000-8000-000000000004',
  deltaAccount: 'd0000000-0000-4000-8000-000000000005',
  hrThere: 'd0000000-0000-4000-8000-000000000006',
  newEvent: 'd0000000-0000-4000-8000-000000000007',
  newSchedule: (n: number) => `d0000000-0000-4000-8000-00000000010${n}`,
};

const header = (contents?: string) => ({
  exportedAt: '2026-11-01T10:00:00.000Z',
  exportedFrom: 'https://other.example.test',
  exportedBy: 'test',
  ...(contents ? { contents } : {}),
});

/** Alpha Directory as exported, changed: a new URL, its secrets masked, a new mapping field. */
export function alphaFile(data: Fixture): any {
  const configuration = structuredClone(data.powershellConfigurations[IDS.alpha]);
  configuration.scriptConfiguration = {
    ...configuration.scriptConfiguration,
    baseUrl: 'https://alpha-new.example.test',
    clientSecret: '***',
    hiddenValue: '***',
  };
  // (the fixture's fields as a full export has them: with their type, mode and actions)
  configuration.mappingConfiguration.fields = configuration.mappingConfiguration.fields.map((field: any) => ({
    identifier: `file-field-${field.name}`,
    ...field,
    type: 1,
    mappingActions: field.mappingActions.map((action: any) => ({ entitlementActions: [1], mode: 2, ...action })),
  }));
  configuration.mappingConfiguration.fields.push({
    identifier: 'file-field-mail',
    name: 'mail',
    type: 1,
    mappingActions: [{ mappingActionId: 'a1', entitlementActions: [1, 3], mode: 2, value: 'Person.Contact.Business.Email' }],
  });
  configuration.dependOnSystems = [{ systemId: IDS.beta, displayName: 'Beta Cloud' }];
  return {
    ...header(),
    secretsIncluded: false,
    systemId: IDS.alpha,
    displayName: 'Alpha Directory',
    templateIdentifier: 'powershell-target',
    configuration,
    agents: { selected: [{ type: 'tag', value: 'onprem' }] },
  };
}

/**
 * Alpha with the rules that grant on it: "Sales get Alpha" gets a permission that is not there yet
 * (retrieved on apply), "Empty rule" gets "Group Sales"; "Employees get Alpha" is not in the file.
 */
export function alphaWithRulesFile(data: Fixture): any {
  return {
    ...alphaFile(data),
    usedBy: [],
    rules: [
      {
        ruleId: IDS.r2,
        ruleName: 'Sales get Alpha',
        entitlements: [
          { entitlementId: IDS.e1, systemIdentifier: IDS.alpha, type: 'Account', displayName: 'Account', permissionDefinitionDisplayName: null },
          { entitlementId: 'd0000000-0000-4000-8000-0000000000e3', systemIdentifier: IDS.alpha, type: 'Permission', displayName: 'Group Finance', permissionDefinitionDisplayName: 'Groups' },
        ],
      },
      {
        ruleId: IDS.r3,
        ruleName: 'Empty rule',
        entitlements: [{ entitlementId: IDS.e3, systemIdentifier: IDS.alpha, type: 'Permission', displayName: 'Group Sales', permissionDefinitionDisplayName: 'Groups' }],
      },
    ],
  };
}

/** A target system of another environment: new here. Depends on "Alpha Directory" (by name only). */
export function deltaFile(): any {
  return {
    ...header(),
    secretsIncluded: false,
    systemId: OTHER.delta,
    displayName: 'Delta Directory',
    templateIdentifier: 'powershell-target',
    configuration: {
      systemId: OTHER.delta,
      displayName: 'Delta Directory',
      description: 'From elsewhere',
      templateIdentifier: 'powershell-target',
      isDisabled: false,
      scriptConfiguration: { url: 'https://delta.example.test' },
      scriptConfigurationForm: { fields: [] },
      scripts: { accountCreate: 'Write-Output "create"' },
      permissions: [],
      thresholds: [],
      mappingConfiguration: {
        fields: [{ identifier: 'df-1', name: 'userName', type: 1, mappingActions: [{ entitlementActions: [1], mode: 2, value: 'Person.ExternalId' }] }],
      },
      dependOnSystems: [{ systemId: OTHER.alphaThere, displayName: 'Alpha Directory', templateIdentifier: 'powershell-target' }],
    },
    resources: [],
    agents: { selected: [] },
  };
}

/** Notifications: one on Delta (made in the same run), one with data of Delta. */
export function deltaNotificationsFile(): any {
  return {
    ...header('notifications'),
    secretsIncluded: false,
    notifications: [
      {
        identifier: 'd0000000-0000-4000-8000-0000000000a1',
        systemId: OTHER.delta,
        systemName: 'Delta Directory',
        event: 'Account create',
        name: 'Delta created',
        enabled: true,
        notificationSystemId: IDS.email,
        notificationSystemName: 'Email',
        notificationSystemBuiltin: true,
        notificationTemplateId: 'tpl-email',
        notificationTemplateName: 'Mail template',
        notificationTemplateData: { subject: 'Welcome to Delta' },
        dataReferences: [{ systemId: OTHER.delta, displayName: 'Delta Directory', key: 'DeltaDirectory', type: 1 }],
        configuration: {},
      },
    ],
  };
}

/** The existing "Alpha account created", with its template secret masked, and its subject changed. */
export function alphaNotificationFile(data: Fixture): any {
  const current = structuredClone(data.notificationDetails[IDS.n1]);
  return {
    ...header('notifications'),
    secretsIncluded: false,
    notifications: [
      {
        ...current,
        notificationTemplateData: { secretWord: '***', subject: 'Welcome again' },
        systemName: 'Alpha Directory',
        notificationSystemName: 'PowerShell Notify',
        notificationSystemBuiltin: false,
        notificationTemplateName: 'Template 1',
        customEventName: 'Manager changed',
      },
    ],
  };
}

/** A new notification system, and a notification of it (made in the same run). */
export function teamsFiles(): any[] {
  return [
    {
      ...header('notificationSystem'),
      secretsIncluded: false,
      systemId: OTHER.teams,
      displayName: 'Teams Notify',
      system: {
        systemId: OTHER.teams,
        displayName: 'Teams Notify',
        description: 'Posts to Teams',
        icon: 'Teams.png',
        executeOnPremise: false,
        isBuiltin: false,
        systemConfiguration: { fields: [{ key: 'webhook', defaultValue: 'https://teams.example.test' }], data: { webhook: 'https://teams.example.test/hook' } },
        notificationScripts: [{ scriptId: 'teams-script', displayName: 'Post', script: 'Invoke-RestMethod' }],
        notificationTemplates: [{ templateId: 'teams-template', displayName: 'Card', scriptId: 'teams-script', fields: [] }],
      },
      agents: { selected: [] },
    },
    {
      ...header('notifications'),
      secretsIncluded: false,
      notifications: [
        {
          identifier: 'd0000000-0000-4000-8000-0000000000a2',
          systemId: null,
          event: 'Person created',
          name: 'Teams card',
          enabled: true,
          notificationSystemId: OTHER.teams,
          notificationSystemName: 'Teams Notify',
          notificationSystemBuiltin: false,
          notificationTemplateId: 'teams-template',
          notificationTemplateName: 'Card',
          notificationTemplateData: {},
          dataReferences: [],
          configuration: {},
        },
      ],
    },
  ];
}

/** Rule r1 as it is, plus the account of Delta (made in the same run). */
export function ruleWithDeltaFile(data: Fixture): any {
  const rule = structuredClone(data.rules[IDS.r1]);
  rule.entitlements.push({ entitlementId: OTHER.deltaAccount, systemIdentifier: OTHER.delta, type: 'Account', displayName: 'Account', permissionDefinitionDisplayName: null });
  return {
    ...header('businessRule'),
    ruleId: rule.ruleId,
    name: rule.name,
    rule,
    systems: [
      { systemId: IDS.alpha, displayName: 'Alpha Directory' },
      { systemId: IDS.beta, displayName: 'Beta Cloud' },
      { systemId: OTHER.delta, displayName: 'Delta Directory' },
    ],
  };
}

/** Rule r1 exactly as it is (its condition has a department without source system: the empty ID). */
export function sameRuleFile(data: Fixture): any {
  const rule = structuredClone(data.rules[IDS.r1]);
  return {
    ...header('businessRule'),
    ruleId: rule.ruleId,
    name: rule.name,
    rule,
    systems: [
      { systemId: IDS.alpha, displayName: 'Alpha Directory' },
      { systemId: IDS.beta, displayName: 'Beta Cloud' },
    ],
  };
}

/** A new rule of another environment, with an entitlement that is nowhere: left out. */
export function newRuleFile(): any {
  return {
    ...header('businessRule'),
    ruleId: OTHER.deltaRule,
    name: 'Contractors',
    rule: {
      ruleId: OTHER.deltaRule,
      name: 'Contractors',
      description: 'From elsewhere',
      categories: [],
      condition: { hasActiveContract: true, titleCondition: { invert: false, titles: [{ externalId: 'T-9', name: 'Temp', source: { systemId: OTHER.hrThere, displayName: 'HR Source' } }] } },
      entitlements: [
        { entitlementId: 'd0000000-0000-4000-8000-0000000000e1', systemIdentifier: IDS.alpha, type: 'Account', displayName: 'Account', permissionDefinitionDisplayName: null },
        { entitlementId: 'd0000000-0000-4000-8000-0000000000e2', systemIdentifier: 'd0000000-0000-4000-8000-0000000000f9', type: 'Permission', displayName: 'Nowhere', permissionDefinitionDisplayName: null },
      ],
    },
    systems: [
      { systemId: IDS.alpha, displayName: 'Alpha Directory' },
      { systemId: 'd0000000-0000-4000-8000-0000000000f9', displayName: 'Gone System' },
    ],
  };
}

/** The reconciliation configuration with Delta (made in the same run) instead of Alpha. */
export function reconciliationFile(data: Fixture): any {
  return {
    ...header('reconciliationConfiguration'),
    schedule: { ...data.reconciliationSchedule, scheduledOnHour: 5 },
    systemConfiguration: [{ systemId: OTHER.delta, automaticAccountCreate: true, automaticAccountEnable: true, automaticPermissionAdd: false }],
    exclusions: { pageData: [{ id: 'x' }], totalRowCount: 1 },
    systems: [{ systemId: OTHER.delta, displayName: 'Delta Directory' }],
  };
}

/** HR Source as exported elsewhere: another script, its secrets masked. */
export function sourceFile(data: Fixture): any {
  const { repositoryMetaData, ...system } = structuredClone(data.sourceSystemDetails[IDS.hr]);
  const values = JSON.parse(system.scriptConfiguration);
  return {
    ...header('sourceSystem'),
    secretsIncluded: false,
    systemId: OTHER.hrThere,
    displayName: 'HR Source',
    system: {
      ...system,
      systemId: OTHER.hrThere,
      personsScript: "Write-Output '[1]'",
      scriptConfiguration: JSON.stringify({ ...values, apiKey: '***', passphrase: '***' }),
      repositoryMetaData: { name: repositoryMetaData.name, repositoryId: 5 },
    },
    agents: { selected: [] },
  };
}

export function customEventFile(): any {
  return {
    ...header('customEvent'),
    customEventId: OTHER.newEvent,
    name: 'Title changed',
    systemName: 'Alpha Directory',
    customEvent: { customEventId: OTHER.newEvent, name: 'Title changed', systemId: OTHER.alphaThere, action: 3, conditions: [] },
  };
}

export function toxicFile(data: Fixture): any {
  const policy = { ...structuredClone(data.toxicCombinations[0]), description: 'Changed' };
  return {
    ...header('toxicPolicy'),
    toxicCombinationId: policy.toxicCombinationId,
    name: policy.name,
    policy,
    entitlements: data.entitlements.filter((e: any) => [...policy.inputObjectIds, ...policy.outputObjectIds].includes(e.entitlementId)),
    systems: [{ systemId: IDS.alpha, displayName: 'Alpha Directory' }],
  };
}

export function scheduleFile(n: number): any {
  const id = OTHER.newSchedule(n);
  return {
    ...header('schedule'),
    scheduleId: id,
    name: `Extra ${n}`,
    timeZone: 'UTC',
    schedule: { scheduleId: id, name: `Extra ${n}`, enabled: true, useSpecificTimeZone: false, selectedTimeZone: null, observeDst: false, hourOfDayUtc: n, tasks: [{ type: 1, systemId: IDS.hr }] },
    systems: [{ systemId: IDS.hr, displayName: 'HR Source' }],
  };
}

export function settingFiles(data: Fixture): any[] {
  return [
    {
      ...header('sourceConfiguration'),
      calculatedLayers: { ...data.calculatedLayers, displayNameConfiguration: { format: 2 } },
      customFields: [{ customFieldIdentifier: 'x', name: 'badge', displayName: 'Badge', type: 0, selected: false }],
    },
    { ...header('aggregationConfiguration'), configuration: { configuration: { enabled: false, suggestions: true }, redetermineSuggestionsStatus: null } },
    { ...header('personLifecycle'), configuration: [{ eventType: 1, daysBefore: 14 }] },
    {
      ...header('excludedPersons'),
      persons: [
        { personId: 'elsewhere-1', displayName: 'Anna Example (E001)', externalId: 'E001' },
        { personId: 'elsewhere-9', displayName: 'Nobody Here', externalId: 'E999' },
      ],
    },
  ];
}

/** Files as the tools take them. */
export const asInput = (files: any[]) => files.map((content, i) => ({ name: `file ${i + 1}.json`, content }));

/** A partial file (made by hand): only some configuration values of Alpha, one of them masked. */
export function partialAlphaFile(): any {
  return {
    partial: true,
    systemId: IDS.alpha,
    displayName: 'Alpha Directory',
    templateIdentifier: 'powershell-target',
    configuration: { scriptConfiguration: { serviceUser: 'svc-alpha-2', clientSecret: '***' } },
  };
}
