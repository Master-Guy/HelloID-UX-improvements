// Masking of secrets as the userscript's export does it (exportSecrets: false).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listTargetSecrets,
  maskFormValues,
  maskNotificationSystem,
  maskSourceSystem,
  maskTargetConfiguration,
  SECRET_MASK,
} from '../src/safety.ts';

describe('maskTargetConfiguration and listTargetSecrets', () => {
  const configuration = {
    displayName: 'Example',
    apiToken: 'top-level-token',
    nullPassword: null,
    tokenCount: 3,
    scriptConfiguration: { url: 'https://x.example.test', userPassword: 'pw', plain: 'shown', formHidden: 'hidden', blankSecret: '' },
    scriptConfigurationForm: { fields: [{ key: 'formHidden', templateOptions: { type: 'password' } }, { key: 'plain', templateOptions: {} }] },
    exchangeConfiguration: { privateKey: 'pk', server: 'mail' },
    mappingConfiguration: { fields: [{ name: 'password', value: 'not a setting' }] },
  };

  it('masks filled secrets of the configuration, its groups and its script configuration', () => {
    const masked = maskTargetConfiguration(configuration);
    assert.equal(masked.apiToken, SECRET_MASK);
    assert.equal(masked.nullPassword, null);
    assert.equal(masked.tokenCount, 3, 'numbers are not secrets');
    assert.deepEqual(masked.scriptConfiguration, {
      url: 'https://x.example.test',
      userPassword: SECRET_MASK,
      plain: 'shown',
      formHidden: SECRET_MASK,
      blankSecret: '',
    });
    assert.deepEqual(masked.exchangeConfiguration, { privateKey: SECRET_MASK, server: 'mail' });
    assert.deepEqual(masked.mappingConfiguration, configuration.mappingConfiguration, 'lists are left alone');
    assert.equal(configuration.scriptConfiguration.userPassword, 'pw', 'the original is not changed');
  });

  it('lists the secrets and whether HelloID returned a value', () => {
    assert.deepEqual(listTargetSecrets(configuration), [
      { key: 'apiToken', hasValue: true },
      { key: 'nullPassword', hasValue: false },
      { key: 'exchangeConfiguration.privateKey', hasValue: true },
      { key: 'userPassword', hasValue: true },
      { key: 'formHidden', hasValue: true },
      { key: 'blankSecret', hasValue: false },
    ]);
  });
});

describe('maskFormValues', () => {
  it('masks secret names at any depth and password fields by their dotted key', () => {
    const values = { text: { required: 'a', secretPart: 'b' }, nested: { login: { pass: 'c' } }, other: 'd' };
    const fields = [{ key: 'nested.login.pass', templateOptions: { type: 'password' } }, { key: 'missing.key', templateOptions: { type: 'password' } }];
    assert.deepEqual(maskFormValues(values, fields), {
      text: { required: 'a', secretPart: SECRET_MASK },
      nested: { login: { pass: SECRET_MASK } },
      other: 'd',
    });
    assert.equal(values.nested.login.pass, 'c');
    assert.equal(maskFormValues(null, fields), null);
  });
});

describe('maskNotificationSystem and maskSourceSystem', () => {
  it('masks the data of a notification system\'s configuration', () => {
    const system = { displayName: 'N', systemConfiguration: { fields: [{ key: 'hidden', templateOptions: { type: 'password' } }], data: { hidden: 'x', shown: 'y' } } };
    assert.deepEqual(maskNotificationSystem(system).systemConfiguration.data, { hidden: SECRET_MASK, shown: 'y' });
    assert.deepEqual(maskNotificationSystem({ displayName: 'no configuration' }), { displayName: 'no configuration' });
  });

  it('masks the JSON text of a source system\'s configuration with its form', () => {
    const system = {
      displayName: 'S',
      scriptConfiguration: JSON.stringify({ clientSecret: 'cs', hiddenOne: 'h', url: 'u' }),
      scriptConfigurationForm: JSON.stringify([{ key: 'hiddenOne', templateOptions: { type: 'password' } }]),
    };
    assert.deepEqual(JSON.parse(maskSourceSystem(system).scriptConfiguration), { clientSecret: SECRET_MASK, hiddenOne: SECRET_MASK, url: 'u' });
    const notJson = { scriptConfiguration: 'not json' };
    assert.equal(maskSourceSystem(notJson), notJson);
  });
});
