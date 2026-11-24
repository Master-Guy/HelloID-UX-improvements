// The static DryRun check of PowerShell target system scripts: empty scripts, changes of DryRun,
// writes outside a dry-run check (cmdlets, REST calls with splatting, .NET methods), the guards
// (if / elseif / else, nested blocks, functions), and what must not confuse it (strings with braces,
// here-strings, comments, line continuations). Made-up scripts only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedScriptFindings, checkDryRun, DRYRUN_LIMITATIONS, findingText, targetScripts } from '../src/changes/dryrun-check.ts';
import { GOOD_CREATE } from './dryrun-routes.ts';

const lines = (...text: string[]) => text.join('\n');
const findings = (script: string, variant: 'v1' | 'v2' = 'v2') => checkDryRun(script, { variant }).findings;
const kinds = (script: string, variant: 'v1' | 'v2' = 'v2') => findings(script, variant).map((f) => `${f.line}:${f.kind}`);

describe('the DryRun check: empty scripts', () => {
  it('null, undefined, empty and whitespace-only scripts are empty-script', () => {
    for (const script of [null, undefined, '', '   \r\n\t  \n']) {
      const result = checkDryRun(script);
      assert.deepEqual(result.findings.map((f) => f.kind), ['empty-script']);
      assert.equal(result.findings[0]!.line, 1);
      assert.equal(result.limitations, DRYRUN_LIMITATIONS);
    }
  });

  it('a script that only reads has no findings', () => {
    assert.deepEqual(kinds(lines('$outputContext.Success = $true', 'Write-Information "Nothing to do"')), []);
  });

  it('says what it cannot see', () => {
    assert.match(DRYRUN_LIMITATIONS, /static check/);
    assert.match(DRYRUN_LIMITATIONS, /MISS/);
    assert.match(DRYRUN_LIMITATIONS, /FLAG/);
  });
});

describe('the DryRun check: a script in the Tools4ever connector style', () => {
  it('guarded splatted POST inside a function called under the guard, a GET outside: no findings (CRLF)', () => {
    assert.ok(GOOD_CREATE.includes('\r\n'));
    assert.deepEqual(findings(GOOD_CREATE), []);
  });

  it('the same function called outside the guard as well: the write in it is flagged, with the call line', () => {
    const script = `${GOOD_CREATE}\r\nInvoke-ExampleRequest -Splat $splatCreate`;
    const found = findings(script);
    assert.deepEqual(found.map((f) => `${f.line}:${f.kind}`), ['7:unguarded-write']);
    assert.match(found[0]!.detail, /function invoke-examplerequest/);
    assert.match(found[0]!.detail, /line 27/);
  });

  it('guarded splatted POST and PATCH', () => {
    const script = lines(
      'try {',
      '    if (-not($actionContext.DryRun -eq $true)) {',
      '        $splatParams = @{',
      '            Uri    = "$($actionContext.Configuration.BaseUrl)/users"',
      "            Method = 'POST'",
      '        }',
      '        $created = Invoke-RestMethod @splatParams -Verbose:$false',
      '        $splatParams = @{ Uri = "x/$($created.id)"; Headers = @{ a = "{" } }',
      "        $splatParams['Method'] = 'PATCH'",
      '        $null = Invoke-RestMethod @splatParams',
      '    }',
      '} catch { throw }',
    );
    assert.deepEqual(kinds(script), []);
  });
});

describe('the DryRun check: writes outside a dry-run check', () => {
  it('Invoke-RestMethod / Invoke-WebRequest / irm with a writing method, in any case', () => {
    const script = lines(
      'Invoke-RestMethod -Uri $u -Method Post -Body $b',
      'Invoke-WebRequest -Uri $u -Method "PUT"',
      'irm -Uri $u -method delete',
      'iwr $u -Method:Patch',
      'Invoke-RestMethod -Uri $u -Method Get',
      'Invoke-RestMethod -Uri $u',
    );
    assert.deepEqual(kinds(script), ['1:unguarded-write', '2:unguarded-write', '3:unguarded-write', '4:unguarded-write']);
  });

  it('a method in a variable is resolved; a method that cannot be told is flagged as possibly writing', () => {
    assert.deepEqual(kinds(lines("$method = 'POST'", 'Invoke-RestMethod -Uri $u -Method $method')), ['2:unguarded-write']);
    assert.deepEqual(kinds(lines("$method = 'GET'", 'Invoke-RestMethod -Uri $u -Method $method')), []);
    const unknown = findings(lines('param($Verb)', 'Invoke-RestMethod -Uri $u -Method $Verb'));
    assert.deepEqual(unknown.map((f) => f.kind), ['unguarded-write']);
    assert.match(unknown[0]!.detail, /not a fixed value/);
  });

  it('splatting: Method from the hashtable (the nearest assignment before the call), and later changes of it', () => {
    assert.deepEqual(kinds(lines("$s = @{ Uri = 'x'; Method = 'PATCH' }", 'Invoke-RestMethod @s')), ['2:unguarded-write']);
    assert.deepEqual(kinds(lines("$s = @{ Uri = 'x'; Method = 'GET' }", 'Invoke-RestMethod @s')), []);
    assert.deepEqual(kinds(lines("$s = @{ Uri = 'x' }", 'Invoke-RestMethod @s')), []);
    assert.deepEqual(kinds(lines("$s = [ordered]@{ Uri = 'x' }", "$s['Method'] = 'DELETE'", 'Invoke-RestMethod @s')), ['3:unguarded-write']);
    assert.deepEqual(kinds(lines("$s = @{ Uri = 'x' }", "$s.Method = 'Put'", 'Invoke-RestMethod @s')), ['3:unguarded-write']);
    assert.deepEqual(kinds(lines("$s = @{ Uri = 'x' }", "$s.Add('Method', 'Post')", 'Invoke-RestMethod @s')), ['3:unguarded-write']);
    // (reused name: the GET outside, the POST inside the guard)
    const reused = lines(
      "$s = @{ Uri = 'x'; Method = 'GET' }",
      'Invoke-RestMethod @s',
      'if (-not($actionContext.DryRun -eq $true)) {',
      "    $s = @{ Uri = 'x'; Method = 'POST' }",
      '    Invoke-RestMethod @s',
      '}',
    );
    assert.deepEqual(kinds(reused), []);
  });

  it('cmdlets with a writing verb; harmless ones are not flagged', () => {
    const script = lines(
      'Set-ADUser -Identity $id -Replace @{ mail = $m }',
      'New-MgUser -BodyParameter $p',
      'Remove-Item -Path $file',
      'Send-MailMessage -To x',
      'ActiveDirectory\\Unlock-ADAccount -Identity $id',
      '$o = New-Object System.Collections.Generic.List[object]',
      '$t = New-TimeSpan -Minutes 5',
      'Set-StrictMode -Version Latest',
      '$x | Add-Member -NotePropertyName Extra -NotePropertyValue 1',
      'Add-Type -AssemblyName System.Web',
      '$g = New-Guid',
      'Remove-PSSession $session',
      'Get-ADUser -Identity $id',
    );
    assert.deepEqual(kinds(script), ['1:unguarded-write', '2:unguarded-write', '3:unguarded-write', '4:unguarded-write', '5:unguarded-write']);
  });

  it('.NET writes: ExecuteNonQuery, [System.IO.File]::WriteAllText', () => {
    const script = lines('$cmd.CommandText = $sql', '$null = $cmd.ExecuteNonQuery()', '[System.IO.File]::WriteAllText($path, $text)', '$r = $cmd.ExecuteReader()');
    assert.deepEqual(kinds(script), ['2:unguarded-write', '3:unguarded-write']);
  });

  it('the finding has the line, its text and why', () => {
    const [finding] = findings(lines('$a = 1', '   Remove-ADGroupMember -Identity g -Members u   '));
    assert.deepEqual(finding, {
      line: 2,
      kind: 'unguarded-write',
      text: 'Remove-ADGroupMember -Identity g -Members u',
      detail: 'Remove-ADGroupMember (a cmdlet with a writing verb) outside a dry-run check: it would run in a dry run too.',
    });
    assert.match(findingText(finding!), /^line 2: unguarded-write: /);
  });
});

describe('the DryRun check: guards', () => {
  it('the forms of "not a dry run", in any case', () => {
    for (const condition of [
      '-not($actionContext.DryRun -eq $true)',
      '-not $actionContext.DryRun',
      '!$actionContext.DryRun',
      '!($actionContext.DryRun)',
      '$actionContext.DryRun -eq $false',
      '$false -eq $actionContext.DryRun',
      '$actionContext.DryRun -ne $true',
      '$ACTIONCONTEXT.dryrun -EQ $FALSE',
      '-not [bool]$actionContext.DryRun',
      '(-not($actionContext.DryRun -eq $true)) -and $create',
      '$create -and -not $actionContext.DryRun',
    ]) {
      assert.deepEqual(kinds(lines(`if (${condition}) {`, '    Set-ADUser -Identity x', '}')), [], condition);
    }
  });

  it('conditions that do not keep a dry run out are not guards', () => {
    for (const condition of ['$actionContext.DryRun', '$actionContext.DryRun -eq $true', '-not $actionContext.DryRun -or $force', '$create', '$actionContext.DryRun -xor $x', '-not $dryRun']) {
      assert.deepEqual(kinds(lines(`if (${condition}) {`, '    Set-ADUser -Identity x', '}')), ['2:unguarded-write'], condition);
    }
  });

  it('else of a dry-run check, and elseif after one, are guarded; else of a "not dry run" check is not', () => {
    assert.deepEqual(kinds(lines('if ($actionContext.DryRun -eq $true) {', "    Write-Information '[DryRun]'", '} else {', '    Set-ADUser -Identity x', '}')), []);
    assert.deepEqual(kinds(lines('if ($actionContext.DryRun) { Write-Host "dry" }', 'elseif ($exists) {', '    Remove-ADUser -Identity x', '}', 'else { New-ADUser -Name x }')), []);
    assert.deepEqual(kinds(lines('if (-not $actionContext.DryRun) {', '    Write-Host "real"', '}', 'else {', '    Remove-ADUser -Identity x', '}')), ['5:unguarded-write']);
    assert.deepEqual(kinds(lines('if ($x) { Write-Host 1 } else { Remove-ADUser -Identity x }')), ['1:unguarded-write']);
  });

  it('nested blocks inside the guard are guarded; a write after the guard is not', () => {
    const script = lines(
      'foreach ($group in $groups) {',
      '    if (-not($actionContext.DryRun -eq $true)) {',
      '        try {',
      '            foreach ($member in $group.members) {',
      '                if ($member.enabled) { Add-ADGroupMember -Identity $group.id -Members $member.id }',
      '            }',
      '        } catch { Write-Warning $_ }',
      '    }',
      '    Remove-ADGroupMember -Identity $group.id -Members $old',
      '}',
    );
    assert.deepEqual(kinds(script), ['9:unguarded-write']);
  });

  it('an alias of the dry-run value is a guard: $dryRun = $actionContext.DryRun', () => {
    assert.deepEqual(kinds(lines('$dryRun = $actionContext.DryRun', 'if (-not $dryRun) {', '    Remove-ADUser -Identity x', '}')), []);
    assert.deepEqual(kinds(lines('$isTest = ($actionContext.DryRun)', 'if ($isTest -eq $false) { Remove-ADUser -Identity x }')), []);
  });

  it('PowerShell v1 scripts guard on $dryRun', () => {
    const script = lines('if (-not($dryRun -eq $true)) {', '    Set-ADUser -Identity x', '}');
    assert.deepEqual(kinds(script, 'v1'), []);
    assert.deepEqual(kinds(script, 'v2'), ['2:unguarded-write']);
    assert.deepEqual(kinds(lines('$dryRun = $false', 'Write-Host x'), 'v1'), ['1:dryrun-override']);
  });
});

describe('the DryRun check: changes of DryRun', () => {
  it('assignments, Set-Variable, Add-Member, [ref], property setters', () => {
    const cases: Array<[string, number]> = [
      ['$actionContext.DryRun = $false', 1],
      ['$ActionContext.dryRun=$false', 1],
      ["$actionContext['DryRun'] = $false", 1],
      ["$actionContext.PSObject.Properties['DryRun'].Value = $false", 1],
      ['$actionContext = [PSCustomObject]@{ DryRun = $false }', 1],
      ['$actionContext | Add-Member -NotePropertyName DryRun -NotePropertyValue $false -Force', 1],
      ['Add-Member -InputObject $actionContext -MemberType NoteProperty -Name DryRun -Value $false -Force', 1],
      ['Set-Variable -Name dryRun -Value $false', 1],
      ["Set-Variable -Name 'actionContext' -Value $null", 1],
      ['Invoke-Flag -Value ([ref]$actionContext.DryRun)', 1],
      ['$actionContext.set_DryRun($false)', 1],
    ];
    for (const [script, line] of cases) {
      assert.deepEqual(kinds(script), [`${line}:dryrun-override`], script);
    }
  });

  it('a variable that shadows the dry-run value: $dryRun = $false later used in the guard', () => {
    const script = lines('$dryRun = $false', 'if (-not($dryRun -eq $true)) {', '    Remove-ADUser -Identity x', '}');
    assert.deepEqual(kinds(script), ['1:dryrun-override', '3:unguarded-write']);
    // (an alias assigned something else later)
    assert.deepEqual(kinds(lines('$test = $actionContext.DryRun', '$test = $false', 'if (-not $test) { Write-Host x }')), ['2:dryrun-override']);
  });

  it('names that only contain "dryrun", hashtable keys and reading the value are not changes', () => {
    const script = lines(
      "$dryRunMessage = '[DryRun] would update'",
      '$splat = @{ DryRun = $true; Name = "x" }',
      'Write-Information "DryRun: $($actionContext.DryRun)"',
      '$params.DryRun = $actionContext.DryRun',
      'if ($actionContext.DryRun -eq $true) { Write-Information $dryRunMessage }',
    );
    assert.deepEqual(kinds(script), []);
  });
});

describe('the DryRun check: what must not confuse it', () => {
  it('strings with braces and commands in them', () => {
    const script = lines(
      'Write-Information "a { b"',
      "Write-Information 'c } d'",
      '$s = "Remove-Item $($path) and } more"',
      "$t = 'it''s { Set-ADUser }'",
      'if (-not($actionContext.DryRun -eq $true)) {',
      '    Set-ADUser -Identity x -Description "}{"',
      '}',
      'Remove-ADUser -Identity y',
    );
    assert.deepEqual(kinds(script), ['8:unguarded-write']);
  });

  it('here-strings (braces, quotes and commands in them) keep the lines right', () => {
    const script = lines(
      '$body = @"',
      '{ "name": "x", "remove": "Remove-Item" }',
      '}}} "quoted" \'single\'',
      '"@',
      "$query = @'",
      'DELETE FROM users WHERE id = 1; Set-ADUser {',
      "'@",
      'if (-not($actionContext.DryRun -eq $true)) { Invoke-RestMethod -Uri $u -Method Post -Body $body }',
      'Invoke-RestMethod -Uri $u -Method Delete',
    );
    assert.deepEqual(kinds(script), ['9:unguarded-write']);
  });

  it('comments (line and block) are ignored, with braces in them', () => {
    const script = lines(
      '# Remove-ADUser -Identity x {',
      '<# Invoke-RestMethod -Method Post',
      '   } } Set-ADUser #>',
      'if (-not($actionContext.DryRun -eq $true)) { # the guard {',
      '    Set-ADUser -Identity x',
      '}',
      'Write-Host "done" # Remove-Item x',
    );
    assert.deepEqual(kinds(script), []);
  });

  it('line continuations: the command starts on the line of the finding', () => {
    const script = lines('$a = 1', 'Invoke-RestMethod -Uri $u `', '    -Method Post `', '    -Body $b');
    assert.deepEqual(kinds(script), ['2:unguarded-write']);
  });

  it('functions: never called are ignored; guarded transitively; unguarded calls are named', () => {
    const script = lines(
      'function Set-Remote { param($id) Invoke-RestMethod -Uri "x/$id" -Method Put }',
      'function Update-All { foreach ($i in $ids) { Set-Remote -id $i } }',
      'function Unused { Remove-ADUser -Identity x }',
      'if (-not($actionContext.DryRun -eq $true)) {',
      '    Update-All',
      '}',
    );
    assert.deepEqual(kinds(script), []);
    const unguarded = findings(`${script}\nUpdate-All`);
    assert.deepEqual(unguarded.map((f) => `${f.line}:${f.kind}`), ['1:unguarded-write']);
    assert.match(unguarded[0]!.detail, /function set-remote/);
    assert.match(unguarded[0]!.detail, /line 2/);
  });

  it('a guard inside the function itself is enough', () => {
    const script = lines('function Set-Remote {', '    if (-not $actionContext.DryRun) { Invoke-RestMethod -Uri x -Method Post }', '}', 'Set-Remote');
    assert.deepEqual(kinds(script), []);
  });
});

describe('the DryRun check: OAuth token requests and -WhatIf are not writes', () => {
  it('a splatted token POST to oauth2/token (Entra ID v2 style)', () => {
    const script = lines(
      '$createEntraAccessTokenBody = @{',
      "    grant_type    = 'client_credentials'",
      '    client_id     = $actionContext.Configuration.AppId',
      '    client_secret = $actionContext.Configuration.AppSecret',
      "    resource      = 'https://graph.microsoft.com'",
      '}',
      '$createEntraAccessTokenSplatParams = @{ Uri = "https://login.microsoftonline.com/$($actionContext.Configuration.TenantID)/oauth2/token"; Body = $createEntraAccessTokenBody; Method = \'POST\'; ContentType = \'application/x-www-form-urlencoded\' }',
      '$createEntraAccessTokenResponse = Invoke-RestMethod @createEntraAccessTokenSplatParams',
    );
    assert.deepEqual(kinds(script), []);
  });

  it('an inline token POST with the Uri built in a variable (v1 Azure AD B2B style), and v2.0 endpoints', () => {
    const script = lines(
      '$baseUri = "https://login.microsoftonline.com/"',
      '$authUri = $baseUri + "$TenantId/oauth2/token"',
      '$body = @{ grant_type = "client_credentials"; client_id = "$AADAppId"; client_secret = "$AADAppSecret"; resource = "https://graph.microsoft.com" }',
      "$Response = Invoke-RestMethod -Method POST -Uri $authUri -Body $body -ContentType 'application/x-www-form-urlencoded'",
      "$t2 = Invoke-RestMethod -Uri 'https://login.microsoftonline.com/x/oauth2/v2.0/token' -Method Post -Body $form",
      "$t3 = Invoke-RestMethod -Uri $tokenEndpoint -Method Post -Body @{ client_assertion = $jwt; client_assertion_type = 'urn:x' }",
      "$t4 = Invoke-RestMethod -Uri 'https://idp.example.test/connect/token' -Method Post -Body $form",
    );
    assert.deepEqual(kinds(script, 'v1'), []);
  });

  it('conservative: other POSTs, and a PATCH to a token-like Uri, are still writes', () => {
    const script = lines(
      "Invoke-RestMethod -Uri 'https://graph.microsoft.com/v1.0/users' -Method Post -Body $user",
      "Invoke-RestMethod -Uri 'https://api.example.test/tokens/revoke' -Method Post",
      "Invoke-RestMethod -Uri 'https://login.example.test/oauth2/token' -Method Patch",
      "$s = @{ Uri = 'https://api.example.test/users'; Method = 'POST'; Body = $userBody }",
      'Invoke-RestMethod @s',
    );
    assert.deepEqual(kinds(script), ['1:unguarded-write', '2:unguarded-write', '3:unguarded-write', '5:unguarded-write']);
  });

  it('-WhatIf in the else branch (Exchange Online style), -WhatIf:$true, -WhatIf:$actionContext.DryRun; -WhatIf:$false still writes', () => {
    const script = lines(
      'if (-not($actionContext.DryRun -eq $true)) {',
      '    Set-Mailbox @splatSetMailbox',
      '} else {',
      '    Set-Mailbox @splatSetMailbox -WhatIf',
      '}',
      'Add-MailboxPermission -Identity $m -User $u -AccessRights FullAccess -WhatIf:$true',
      'Remove-MailboxPermission -Identity $m -User $u -WhatIf:$actionContext.DryRun -Confirm:$false',
      'Set-Mailbox -Identity $m -WhatIf:$false',
    );
    assert.deepEqual(kinds(script), ['8:unguarded-write']);
  });

  it('v1: -WhatIf:$dryRun', () => {
    assert.deepEqual(kinds('Set-Mailbox -Identity $m -HiddenFromAddressListsEnabled $true -WhatIf:$dryRun', 'v1'), []);
    assert.deepEqual(kinds('Set-Mailbox -Identity $m -WhatIf:$dryRun', 'v2'), ['1:unguarded-write']);
  });
});

describe('the scripts of a target system export', () => {
  const doc = {
    templateIdentifier: 'powershell-target',
    configuration: {
      scripts: { accountCreate: GOOD_CREATE, accountUpdate: 'Set-ADUser -Identity x', accountEnable: null, accountImport: '' },
      permissions: [
        { identification: 'p1', displayName: 'Groups', useSeparateScriptForEachAction: true, grantPermissionScript: 'Add-ADGroupMember -Identity g -Members u', permissionActionScript: null },
        { identification: 'p2', displayName: 'Dynamic', useSeparateScriptForEachAction: false, permissionActionScript: 'Write-Host x', grantPermissionScript: 'Remove-Item x' },
      ],
      mappingConfiguration: { uniquenessConfiguration: { script: 'Write-Host u' } },
    },
    resources: [{ displayName: 'Folders', resourceDefinitionId: 'r1', script: 'New-Item -Path x' }],
  };

  it('account, permission, resource and uniqueness scripts, with paths and unused ones', () => {
    const refs = targetScripts(doc);
    assert.deepEqual(
      refs.map((r) => [r.name, r.path, r.unused]),
      [
        ['accountCreate', 'configuration.scripts.accountCreate', false],
        ['accountUpdate', 'configuration.scripts.accountUpdate', false],
        ['accountEnable', 'configuration.scripts.accountEnable', false],
        ['accountImport', 'configuration.scripts.accountImport', false],
        ['permission "Groups" grantPermissionScript', 'configuration.permissions[displayName=Groups].grantPermissionScript', false],
        ['permission "Groups" permissionActionScript', 'configuration.permissions[displayName=Groups].permissionActionScript', true],
        ['permission "Dynamic" permissionActionScript', 'configuration.permissions[displayName=Dynamic].permissionActionScript', false],
        ['permission "Dynamic" grantPermissionScript', 'configuration.permissions[displayName=Dynamic].grantPermissionScript', true],
        ['resource "Folders" script', 'resources[displayName=Folders].script', false],
        ['uniqueness script', 'configuration.mappingConfiguration.uniquenessConfiguration.script', false],
      ],
    );
    assert.equal(refs[4]!.concrete, 'configuration.permissions[0].grantPermissionScript');
  });

  it('changed scripts only, with their findings; every script of a new system', () => {
    const after = structuredClone(doc);
    after.configuration.scripts.accountCreate = 'Remove-ADUser -Identity x';
    const changed = changedScriptFindings(doc, after, 'v2');
    assert.deepEqual(changed.map((c) => c.ref.name), ['accountCreate']);
    const all = changedScriptFindings(null, doc, 'v2');
    assert.deepEqual(all.map((c) => c.ref.name), ['accountUpdate', 'permission "Groups" grantPermissionScript', 'permission "Dynamic" grantPermissionScript', 'resource "Folders" script']);
  });
});
