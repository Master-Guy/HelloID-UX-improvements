#Requires -Version 7.5
<#
.SYNOPSIS
    Exports HelloID target systems to JSON files: the same files as the Export button of
    "HelloID UX improvements", which its Import button can read.

.DESCRIPTION
    Logs in to the HelloID admin portal with a local admin account (/authentication/admlogin,
    without MFA), gets the portal's Bearer token, and exports every target system, or only the
    ones named in -SystemName. Per system:
      - its configuration, and what its type adds (PowerShell: default scripts and resources)
      - the agents that run its on-premises actions
      - the business rules that have an entitlement for it, in full
      - its notifications, and those of other systems that use its data
      - the other systems that use it (depend on it, or name its accounts)
    Secrets are written as "***", unless -IncludeSecrets is given.

.PARAMETER Domain
    The HelloID environment, e.g. "customer.helloid.com" (with or without https://).

.PARAMETER Credential
    The local admin account. Asked for when left out.

.PARAMETER SystemName
    Only these target systems (by name). Without it: all target systems.

.PARAMETER OutputFolder
    Where the files go. Default: the current folder.

.PARAMETER IncludeSecrets
    Also write the values of secrets (passwords, client secrets, ...) to the files.

.PARAMETER GatewayUrl
    HelloID's provisioning API server, e.g. "https://provisioning-gateway-xx.helloid.cloud".
    Found by the script itself; only needed when that fails.

.EXAMPLE
    ./Export-HelloIDTargetSystems.ps1 -Domain customer.helloid.com -OutputFolder D:\Exports

.EXAMPLE
    ./Export-HelloIDTargetSystems.ps1 -Domain customer.helloid.com -SystemName 'Microsoft Entra ID', 'Active Directory'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Domain,

    [pscredential] $Credential,

    [string[]] $SystemName,

    [string] $OutputFolder = (Get-Location).Path,

    [switch] $IncludeSecrets,

    [string] $GatewayUrl,

    # Rows asked for in one go from lists that come in pages
    [int] $Take = 999999
)

$ErrorActionPreference = 'Stop'
$ScriptVersion = '2026-10-21.1'

#region Settings
# What else to export per type of target system (templateIdentifier): name in the export -> path.
# "configuration" replaces the system's entry of the list of systems (it has the same, and more).
function Get-ConnectorPaths([string] $Type, [string] $Id) {
    switch ($Type) {
        { $_ -in 'powershell-onpremise', 'powershell-target' } {
            return [ordered]@{
                configuration  = "/connector/powershell-target/api/configuration/$Id"
                defaultScripts = "/connector/powershell-target/api/configuration/$Id/default"
                resources      = "/connector/powershell-target/api/resources/$Id"
            }
        }
        'azuread' { return [ordered]@{ configuration = "/connector/azure-active-directory/api/configuration/$Id" } }
        'activedirectory' { return [ordered]@{ configuration = "/connector/active-directory/api/configuration/$Id" } }
        default { return [ordered]@{} }
    }
}

# Parts that may fail to load without stopping the export of a system: the file then says which
# ones are missing (couldNotRead)
$OptionalExports = @('resources')

# The flags of a business rule's entitlements overview that mean "has an entitlement for this system"
$RuleEntitlementFields = @('accountEntitlementForSystem', 'accountAccessEntitlementForSystem', 'permissionEntitlementForSystem')

# Values that are secrets: the password fields of the configuration form, and any value whose name
# says so
$SecretName = 'secret|passw|pwd|token|api[-_]?key|private[-_]?key|certificate|credential'
$ExportMask = '***'
#endregion Settings

#region Helpers
function Test-PlainObject($Value) { $Value -is [System.Management.Automation.PSCustomObject] }

function Test-Filled($Value) { $Value -is [string] -and $Value -ne '' }

# A property of an object from HelloID, or $null
function Get-Value($Object, [string] $Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return , $property.Value }
    return $null
}

# Dates stay text and lists stay lists, so the file is as HelloID sent it
function ConvertFrom-HelloIDJson([string] $Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    return , (ConvertFrom-Json -InputObject $Text -DateKind String -NoEnumerate)
}

function Copy-Json($Value) { ConvertFrom-HelloIDJson (ConvertTo-Json -InputObject $Value -Depth 100 -Compress) }

function ConvertTo-Ordered($Object) {
    $ordered = [ordered]@{}
    foreach ($property in $Object.PSObject.Properties) { $ordered[$property.Name] = $property.Value }
    return $ordered
}

function New-List { return , [System.Collections.Generic.List[object]]::new() }

# The claims of a JWT, or $null
function Get-JwtClaims([string] $Jwt) {
    try {
        $payload = $Jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
        $payload += '=' * ((4 - $payload.Length % 4) % 4)
        return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    }
    catch { return $null }
}
#endregion Helpers

#region Login
# The login of the admin portal: the anti-forgery token of the login page and its cookie, then the
# user name and password. The session keeps the cookies.
function Connect-HelloID {
    $loginUrl = "$script:BaseUrl/authentication/admlogin?returnUrl=%2F"
    $page = Invoke-WebRequest -Uri $loginUrl -SessionVariable session
    $script:Session = $session

    $field = [regex]::Match($page.Content, '(?is)<input\b[^>]*\bname\s*=\s*["'']__RequestVerificationToken["''][^>]*>')
    if (-not $field.Success) {
        throw "The login page $loginUrl has no __RequestVerificationToken. Is $script:BaseUrl a HelloID environment?"
    }
    $verificationToken = [System.Net.WebUtility]::HtmlDecode(
        [regex]::Match($field.Value, '(?is)\bvalue\s*=\s*["'']([^"'']*)["'']').Groups[1].Value)

    $escape = { param($value) [uri]::EscapeDataString($value) }
    $body = "__RequestVerificationToken=$(& $escape $verificationToken)&PwdResetEnabled=True&loginFromPage=admlogin" +
            "&UserName=$(& $escape $Credential.UserName)&Password=$(& $escape $Credential.GetNetworkCredential().Password)"
    $response = Invoke-WebRequest -Uri $loginUrl -Method Post -Body $body -ContentType 'application/x-www-form-urlencoded' `
        -WebSession $script:Session -Headers @{ Origin = $script:BaseUrl; Referer = $loginUrl }

    # Logged in: the redirects lead away from the login page (to /admin)
    $landedOn = $response.BaseResponse.RequestMessage.RequestUri
    if ($landedOn.AbsolutePath -like '/authentication/*') {
        throw "The login of $($Credential.UserName) at $script:BaseUrl failed: wrong user name or password, a locked " +
              'account, or MFA is on for it.'
    }
    Write-Verbose "Logged in; landed on $landedOn"

    Update-Token
    $script:Gateway = Find-Gateway
    Write-Verbose "Provisioning API: $script:Gateway"
}

# The portal's Bearer token (valid for some hours), as the portal itself gets it
function Update-Token {
    $cachebust = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $response = Invoke-WebRequest -Uri "$script:BaseUrl/server/v2/security/token?cachebust=$cachebust" `
        -WebSession $script:Session -Headers @{ Accept = 'application/json, text/plain, */*' } -SkipHttpErrorCheck
    if ($response.StatusCode -ne 200) {
        throw "HelloID answered $($response.StatusCode) for the token. The login may have expired."
    }
    # The token, wherever it is in the answer: the one for HelloID's services, or else the first
    $tokens = @([regex]::Matches([string]$response.Content, 'eyJ[\w-]+\.[\w-]+\.[\w-]+').Value)
    $script:Token = @($tokens | Where-Object { (Get-JwtClaims $_).aud -eq 'helloid.services' })[0] ?? $tokens[0]
    if (-not $script:Token) { throw 'HelloID did not give a Bearer token after the login.' }
    $expires = (Get-JwtClaims $script:Token).exp
    if ($expires) { Write-Verbose "Token valid until $([DateTimeOffset]::FromUnixTimeSeconds($expires).LocalDateTime)" }
}

# HelloID's provisioning API server: given, or named in the portal's bootstrap of Provisioning
function Find-Gateway {
    if ($GatewayUrl) { return ([uri]$GatewayUrl).GetLeftPart([System.UriPartial]::Authority) }
    $response = Invoke-WebRequest -Uri "$script:BaseUrl/server/v2/bootstrap/provisioning" -WebSession $script:Session `
        -Headers @{ Authorization = "Bearer $script:Token"; Accept = 'application/json, text/plain, */*' } -SkipHttpErrorCheck
    $urls = [regex]::Matches(([string]$response.Content).Replace('\/', '/'), 'https://[^"\s\\,]+').Value
    $gateway = $urls | Where-Object { ([uri]$_).Host -match 'gateway' } | Select-Object -First 1
    if (-not $gateway) {
        throw "The provisioning API server was not found (HelloID answered $($response.StatusCode) for the bootstrap). " +
              'Give it with -GatewayUrl, e.g. https://provisioning-gateway-xx.helloid.cloud: the browser''s DevTools show ' +
              'it in the requests of the Target systems page.'
    }
    return ([uri]$gateway).GetLeftPart([System.UriPartial]::Authority)
}
#endregion Login

#region Requests
$script:Cache = @{}

# A request to the provisioning API; the answer as an object. -Cached: a GET that is only done
# once (the same configuration or rule is needed for many systems). A token that expired is
# fetched again once.
function Invoke-HelloIDApi {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [string] $Method = 'GET',
        $Body,
        [switch] $Cached
    )
    if ($Cached -and $script:Cache.ContainsKey($Path)) { return , $script:Cache[$Path] }
    for ($attempt = 1; ; $attempt++) {
        $request = @{
            Uri                = "$script:Gateway$Path"
            Method             = $Method
            Headers            = @{
                Authorization = "Bearer $script:Token"
                Accept        = 'application/json, text/plain, */*'
                Origin        = $script:BaseUrl
            }
            SkipHttpErrorCheck = $true
        }
        if ($PSBoundParameters.ContainsKey('Body')) {
            $request.Body = ConvertTo-Json -InputObject $Body -Depth 100 -Compress
            $request.ContentType = 'application/json'
        }
        $response = Invoke-WebRequest @request
        if ($response.StatusCode -eq 401 -and $attempt -eq 1) {
            Update-Token
            continue
        }
        break
    }
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
        throw "HelloID answered $($response.StatusCode) for $Method $Path"
    }
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [System.Text.Encoding]::UTF8.GetString($content) }
    $answer = ConvertFrom-HelloIDJson $content
    if ($Cached) { $script:Cache[$Path] = $answer }
    return , $answer
}

$escapeId = { param($id) [uri]::EscapeDataString([string]$id) }
#endregion Requests

#region Secrets
# The names of the values in scriptConfiguration that are secrets
function Get-SecretKeys($Configuration) {
    $values = Get-Value $Configuration 'scriptConfiguration'
    $keys = New-List
    if (-not (Test-PlainObject $values)) { return , $keys }
    $passwordKeys = @((Get-Value (Get-Value $Configuration 'scriptConfigurationForm') 'fields') |
        Where-Object { (Get-Value (Get-Value $_ 'templateOptions') 'type') -eq 'password' } |
        ForEach-Object { Get-Value $_ 'key' })
    foreach ($key in $values.PSObject.Properties.Name) {
        if ($key -cin $passwordKeys -or $key -match $SecretName) { $keys.Add($key) }
    }
    return , $keys
}

# Built-in types (e.g. Azure AD) have their settings in the configuration itself, or in a group in
# it: there, the texts (or empty values) whose name says they are secrets. As (group, key) pairs;
# group is $null for the configuration itself.
function Get-SettingSecretKeys($Configuration) {
    $pairs = New-List
    $secretsOf = {
        param($values)
        $values.PSObject.Properties |
            Where-Object { $_.Name -match $SecretName -and ($null -eq $_.Value -or $_.Value -is [string]) } |
            ForEach-Object Name
    }
    foreach ($key in & $secretsOf $Configuration) { $pairs.Add(@($null, $key)) }
    foreach ($group in $Configuration.PSObject.Properties) {
        if ($group.Name -eq 'scriptConfiguration' -or -not (Test-PlainObject $group.Value)) { continue }
        foreach ($key in & $secretsOf $group.Value) { $pairs.Add(@($group.Name, $key)) }
    }
    return , $pairs
}

function Get-MaskedConfiguration($Configuration) {
    $masked = Copy-Json $Configuration
    foreach ($pair in (Get-SettingSecretKeys $Configuration)) {
        $group, $key = $pair
        $target = if ($null -ne $group) { $masked.$group } else { $masked }
        if (Test-Filled $target.$key) { $target.$key = $ExportMask }
    }
    $values = Get-Value $masked 'scriptConfiguration'
    foreach ($key in (Get-SecretKeys $Configuration)) {
        if (Test-Filled $values.$key) { $values.$key = $ExportMask }
    }
    return $masked
}

# Which values are secrets, and whether HelloID returned one: also in a file without the secrets
function Get-SecretList($Configuration) {
    $list = New-List
    foreach ($pair in (Get-SettingSecretKeys $Configuration)) {
        $group, $key = $pair
        if ($null -ne $group) { $list.Add([ordered]@{ key = "$group.$key"; hasValue = (Test-Filled $Configuration.$group.$key) }) }
        else { $list.Add([ordered]@{ key = $key; hasValue = (Test-Filled $Configuration.$key) }) }
    }
    foreach ($key in (Get-SecretKeys $Configuration)) {
        $list.Add([ordered]@{ key = $key; hasValue = (Test-Filled $Configuration.scriptConfiguration.$key) })
    }
    return , $list
}
#endregion Secrets

#region Parts of an export
# Where a text is found in a configuration, as paths; list items by their name, when they have one
# ("mappingConfiguration.fields[mail]")
function Find-Text($Value, [string] $Text, [string] $Path, [System.Collections.Generic.List[string]] $Found) {
    if ($Value -is [string]) {
        if ($Value.ToLowerInvariant().Contains($Text)) { $Found.Add($Path) }
    }
    elseif ($Value -is [array]) {
        for ($i = 0; $i -lt $Value.Count; $i++) {
            $item = $Value[$i]
            $label = (Get-Value $item 'name') ?? (Get-Value $item 'displayName') ?? $i
            Find-Text $item $Text "$($Path)[$label]" $Found
        }
    }
    elseif (Test-PlainObject $Value) {
        foreach ($property in $Value.PSObject.Properties) {
            Find-Text $property.Value $Text $(if ($Path) { "$Path.$($property.Name)" } else { $property.Name }) $Found
        }
    }
}

# How the system's accounts are named in mappings and scripts
function Get-AccountsReference([string] $SystemId) { "_$($SystemId -replace '-', '')" }

# The tags and agent pools whose agents run the system's on-premises actions, and the agents that
# stands for right now. Not all systems may have this.
function Get-Agents([string] $Id) {
    try {
        $agents = [ordered]@{
            selected = (Invoke-HelloIDApi "/service/agent-repository/api/agents/selected-agents/$Id")
            summary  = (Invoke-HelloIDApi "/service/agent-repository/api/agents/selections/summary/$Id")
        }
        # HelloID answers with all agents, marking the selected ones (a POST, but it only looks them up)
        if ($agents.selected -is [array] -and $agents.selected.Count) {
            $all = Invoke-HelloIDApi '/service/agent-repository/api/agents' -Method POST -Body $agents.selected
            if ($all -is [array]) { $agents.selectedAgents = @($all | Where-Object { (Get-Value $_ 'selected') -eq $true }) }
        }
        return $agents
    }
    catch {
        Write-Verbose "Could not read the agents: $_"
        return [ordered]@{ couldNotRead = $true }
    }
}

# The business rules with an entitlement for the system, in full, with only their entitlements
# for this system
function Get-Rules($System, [string] $Id) {
    $overview = Invoke-HelloIDApi "/api/connectors/shared/rules/published/$Id/entitlements-overview?skip=0&take=$Take"
    $rules = New-List
    foreach ($row in (Get-Value $overview 'pageData')) {
        if ($null -eq $row -or -not ($RuleEntitlementFields | Where-Object { (Get-Value $row $_) -eq $true })) { continue }
        $rule = ConvertTo-Ordered $row
        try {
            $read = Invoke-HelloIDApi "/service/rules/api/rules/$(& $escapeId $row.ruleId)" -Cached
            foreach ($name in 'description', 'categories', 'published', 'hasDraft', 'condition') { $rule[$name] = Get-Value $read $name }
            $rule.entitlements = @((Get-Value $read 'entitlements') |
                Where-Object { $null -ne $_ -and (Get-Value $_ 'systemIdentifier') -eq $System.systemId })
        }
        catch {
            Write-Warning "Could not read business rule ""$($row.ruleName)"": $_"
            $rule.couldNotRead = $true
        }
        $rules.Add($rule)
    }
    return , $rules
}

# What sends the notifications (e.g. "Email"), in full; their settings may hold secrets
function Get-NotificationSystems($Notifications) {
    $systems = New-List
    $ids = @($Notifications | ForEach-Object { Get-Value $_ 'notificationSystemId' } | Where-Object { $_ } | Select-Object -Unique)
    foreach ($id in $ids) {
        try {
            $read = Copy-Json (Invoke-HelloIDApi "/service/notifications/api/notification/systems/$(& $escapeId $id)" -Cached)
            $settings = Get-Value $read 'systemConfiguration'
            if (-not $IncludeSecrets -and (Test-PlainObject $settings)) {
                foreach ($property in $settings.PSObject.Properties) {
                    if ($property.Name -match $SecretName -and (Test-Filled $property.Value)) { $property.Value = $ExportMask }
                }
            }
            $systems.Add($read)
        }
        catch {
            Write-Warning "Could not read notification system ${id}: $_"
            $systems.Add([ordered]@{ systemId = $id; couldNotRead = $true })
        }
    }
    return , $systems
}

# The system's own notifications in full, and those of other systems that use its data (their
# dataReferences name it). Which ones use it is only in the notification itself, so all of them
# are read (once, for all systems).
function Get-Notifications($System) {
    $list = Invoke-HelloIDApi "/service/notifications/api/notifications?skip=0&take=$Take&enabled=false&disabled=false" -Cached
    $own = New-List
    $using = New-List
    foreach ($row in (Get-Value $list 'pageData')) {
        if ($null -eq $row) { continue }
        $isOwn = $row.systemId -eq $System.systemId
        try {
            $notification = Invoke-HelloIDApi "/service/notifications/api/notifications/$(& $escapeId $row.identifier)" -Cached
        }
        catch {
            Write-Warning "Could not read notification ""$($row.name)"": $_"
            $failed = ConvertTo-Ordered $row
            $failed.couldNotRead = $true
            if ($isOwn) { $own.Add($failed) } else { $using.Add($failed) }
            continue
        }
        if ($isOwn) {
            $own.Add($notification)
            continue
        }
        $references = @((Get-Value $notification 'dataReferences') |
            Where-Object { $null -ne $_ -and (Get-Value $_ 'systemId') -eq $System.systemId })
        if (-not $references.Count) { continue }
        $using.Add([ordered]@{
                identifier     = $notification.identifier
                systemId       = $notification.systemId
                event          = $notification.event
                name           = $notification.name
                enabled        = $notification.enabled
                dataReferences = $references
            })
    }
    $byName = { [string]$(if ($_ -is [System.Collections.IDictionary]) { $_['name'] } else { Get-Value $_ 'name' }) }
    return [ordered]@{
        notifications                = @($own | Sort-Object $byName)
        notificationSystems          = (Get-NotificationSystems $own)
        notificationsUsingThisSystem = @($using | Sort-Object $byName)
    }
}

# The other systems that use this one: that depend on it, or name its accounts in a mapping or a
# script. Systems of a type with a configuration of its own are read in full.
function Get-UsedBy($System, $Systems) {
    $text = (Get-AccountsReference $System.systemId).ToLowerInvariant()
    $usedBy = New-List
    foreach ($other in $Systems) {
        if (-not $other.systemId -or $other.systemId -eq $System.systemId) { continue }
        $path = (Get-ConnectorPaths $other.templateIdentifier (& $escapeId $other.systemId)).configuration
        $configuration = $other
        $couldNotRead = $false
        if ($path) {
            try { $configuration = Invoke-HelloIDApi $path -Cached }
            catch {
                Write-Warning "Could not read ""$($other.displayName)"" to see whether it uses this system: $_"
                $couldNotRead = $true
            }
        }
        $dependencies = (Get-Value $configuration 'dependOnSystems') ?? (Get-Value $other 'dependOnSystems')
        $dependsOnThisSystem = [bool](@($dependencies) | Where-Object { $null -ne $_ -and (Get-Value $_ 'systemId') -eq $System.systemId })
        $references = [System.Collections.Generic.List[string]]::new()
        Find-Text $configuration $text '' $references
        if (-not $dependsOnThisSystem -and -not $references.Count -and -not $couldNotRead) { continue }
        $entry = [ordered]@{
            systemId            = $other.systemId
            displayName         = $other.displayName
            templateIdentifier  = $other.templateIdentifier
            dependsOnThisSystem = $dependsOnThisSystem
            references          = $references
        }
        if ($couldNotRead) { $entry.couldNotRead = $true }
        $usedBy.Add($entry)
    }
    return , @($usedBy | Sort-Object { [string]$_['displayName'] })
}

# Everything about one system, as the Export button saves it
function Get-SystemExport($System, $Systems) {
    $id = & $escapeId $System.systemId
    $paths = Get-ConnectorPaths $System.templateIdentifier $id
    $couldNotRead = New-List

    $answers = [ordered]@{}
    foreach ($name in $paths.Keys) {
        try { $answers[$name] = Invoke-HelloIDApi $paths[$name] -Cached:($name -eq 'configuration') }
        catch {
            if ($name -notin $OptionalExports) { throw }
            Write-Warning "Could not read ""$name"" of ""$($System.displayName)"": $_"
            $couldNotRead.Add($name)
        }
    }
    $agents = Get-Agents $id
    try { $notifications = Get-Notifications $System }
    catch {
        Write-Warning "Could not read the notifications: $_"
        $couldNotRead.Add('notifications')
        $notifications = [ordered]@{}
    }
    $rules = Get-Rules $System $id
    $usedBy = Get-UsedBy $System $Systems

    $read = if ($answers.Contains('configuration')) { $answers['configuration'] } else { $System }
    # The systems it depends on, with their names: HelloID only gives their IDs, which mean nothing
    # in another environment
    $configuration = Copy-Json $read
    foreach ($dependency in (Get-Value $configuration 'dependOnSystems')) {
        if ($null -eq $dependency) { continue }
        $name = ($Systems | Where-Object { $_.systemId -eq $dependency.systemId } | Select-Object -First 1).displayName
        if ($null -ne $name) { $dependency | Add-Member -NotePropertyName displayName -NotePropertyValue $name -Force }
    }
    # What the list of systems has about it that the configuration of its type doesn't
    $listEntry = [ordered]@{}
    foreach ($property in $System.PSObject.Properties) {
        if (-not $read.PSObject.Properties[$property.Name]) { $listEntry[$property.Name] = $property.Value }
    }

    $export = [ordered]@{
        exportedAt         = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        exportedFrom       = $script:BaseUrl
        exportedBy         = "Export-HelloIDTargetSystems.ps1 $ScriptVersion"
        secretsIncluded    = [bool]$IncludeSecrets
        systemId           = $System.systemId
        displayName        = $System.displayName
        templateIdentifier = $System.templateIdentifier
    }
    $export.configuration = if ($IncludeSecrets) { $configuration } else { Get-MaskedConfiguration $configuration }
    $export.secrets = Get-SecretList $configuration
    if ($listEntry.Count) { $export.listEntry = $listEntry }
    $export.agents = $agents
    foreach ($name in $answers.Keys) {
        if ($name -ne 'configuration') { $export[$name] = $answers[$name] }
    }
    $export.accountsReference = "Person.Accounts.$(Get-AccountsReference $System.systemId)"
    $export.usedBy = $usedBy
    foreach ($name in $notifications.Keys) { $export[$name] = $notifications[$name] }
    if ($couldNotRead.Count) { $export.couldNotRead = $couldNotRead }
    $export.rules = $rules
    return $export
}

# <name> - <system ID> - <date>.json, like the Export button
function Get-ExportFileName($System) {
    $name = ([string]$System.displayName).Trim() -replace '[\\/:*?"<>|]+', '_'
    return "$($name.Trim()) - $($System.systemId) - $([DateTime]::UtcNow.ToString('yyyy-MM-dd')).json"
}
#endregion Parts of an export

#region Main
$script:BaseUrl = 'https://' + ($Domain.Trim() -replace '^https?://', '').TrimEnd('/')
if (-not $Credential) { $Credential = Get-Credential -Message "Local admin account of $script:BaseUrl" }
if (-not (Test-Path -LiteralPath $OutputFolder)) { New-Item -ItemType Directory -Path $OutputFolder | Out-Null }
$OutputFolder = (Resolve-Path -LiteralPath $OutputFolder).Path

Connect-HelloID

# (A function's list in parentheses: piped item by item)
$systems = @((Invoke-HelloIDApi '/service/provisioning-api/api/target-systems?showReferenceSystems=true') |
    Where-Object { $_ -and $_.systemId -and $_.displayName -is [string] })
$selected = if ($SystemName) {
    $missing = @($SystemName | Where-Object { $name = $_.Trim(); -not ($systems | Where-Object { $_.displayName.Trim() -eq $name }) })
    if ($missing.Count) { throw "Not found in HelloID's list of target systems: $($missing -join ', ')" }
    @($systems | Where-Object { $_.displayName.Trim() -in @($SystemName | ForEach-Object Trim) })
}
else { @($systems) }
if ($IncludeSecrets) { Write-Warning 'The files will have the SECRETS of the systems in them.' }

$failed = 0
for ($i = 0; $i -lt $selected.Count; $i++) {
    $system = $selected[$i]
    Write-Progress -Activity "Export from $script:BaseUrl" -Status "$($i + 1)/$($selected.Count): $($system.displayName)" `
        -PercentComplete (100 * $i / $selected.Count)
    try {
        $export = Get-SystemExport $system $systems
        $file = Join-Path $OutputFolder (Get-ExportFileName $system)
        [System.IO.File]::WriteAllText($file, (ConvertTo-Json -InputObject $export -Depth 100),
            [System.Text.UTF8Encoding]::new($false))
        [PSCustomObject]@{
            System       = $system.displayName
            Type         = $system.templateIdentifier
            File         = $file
            CouldNotRead = $export.couldNotRead -join ', '
        }
    }
    catch {
        $failed++
        Write-Error "Export of ""$($system.displayName)"" failed: $_" -ErrorAction Continue
    }
}
Write-Progress -Activity "Export from $script:BaseUrl" -Completed

if ($failed) {
    Write-Error "$failed of $($selected.Count) systems could not be exported." -ErrorAction Continue
    exit 1
}
#endregion Main
