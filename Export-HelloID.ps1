#Requires -Version 7.5
<#
.SYNOPSIS
    Exports the configuration of a HelloID Provisioning environment to JSON files: target and
    source systems, business rules, notifications and the settings pages. Where "HelloID UX
    improvements" has an Export button, the file is the same, so its Import button can read it.

.DESCRIPTION
    Logs in to the HelloID admin portal with a local admin account (/authentication/admlogin,
    without MFA), gets the portal's Bearer token, and exports what the parameters name. Each type
    goes to a subfolder of its own in -OutputFolder, one file per item: "<name> - <ID> - <date>.json".

    Types with names take one or more patterns: "*" for all, "*customer*" for those whose name
    has "customer" in it, or an exact name. A pattern without * or ? is an exact name.
      -TargetSystems               TargetSystems\       as the Export button: the configuration,
                                                        agents, business rules, notifications and
                                                        the systems that use it
      -SourceSystems               SourceSystems\       as the Export button of a source system
      -BusinessRules               BusinessRules\       each rule in full (published and drafts)
      -ToxicPolicies               ToxicPolicies\       each policy, with the names of its entitlements
      -CustomEvents                CustomEvents\        each custom event of the notifications
      -NotificationConfigurations  NotificationConfigurations\  as the Export button of a notification
      -NotificationSystems         NotificationSystems\ as the Export button of a notification system
      -Schedules                   Schedules\           each schedule of the snapshots, with its tasks

    The settings pages are switches, one file each:
      -SourceConfiguration         SourceConfiguration\ primary contract, primary manager, display
                                                        name, custom fields
      -AggregationConfiguration    AggregationConfiguration\  automatic aggregation and suggestions
      -PersonLifecycle             PersonLifecycle\     the days before the lifecycle events
      -ExcludedPersons             ExcludedPersons\     the persons excluded from provisioning
                                                        (personal data!)
      -ReconciliationConfiguration ReconciliationConfiguration\  the schedule, the settings per
                                                        system and the exclusions
    -All exports everything. Without any of these, nothing is exported.
    Secrets are written as "***", unless -IncludeSecrets is given.

.PARAMETER Domain
    The HelloID environment, e.g. "customer.helloid.com" (with or without https://).

.PARAMETER Credential
    The local admin account. Asked for when left out.

.PARAMETER All
    Everything: all items of every type, and every settings page.

.PARAMETER OutputFolder
    Where the subfolders go. Default: the current folder.

.PARAMETER IncludeSecrets
    Also write the values of secrets (passwords, client secrets, ...) to the files.

.PARAMETER GatewayUrl
    HelloID's provisioning API server, e.g. "https://provisioning-gateway-xx.helloid.cloud".
    Found by the script itself; only needed when that fails.

.EXAMPLE
    ./Export-HelloID.ps1 -Domain customer.helloid.com -All -OutputFolder D:\Exports

.EXAMPLE
    ./Export-HelloID.ps1 -Domain customer.helloid.com -TargetSystems 'Microsoft Entra ID', *AFAS* -BusinessRules *

.EXAMPLE
    ./Export-HelloID.ps1 -Domain customer.helloid.com -SourceSystems * -SourceConfiguration -PersonLifecycle
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Domain,

    [pscredential] $Credential,

    # Items by name: patterns ("*", "*customer*") or exact names
    [string[]] $TargetSystems,
    [string[]] $SourceSystems,
    [string[]] $BusinessRules,
    [string[]] $ToxicPolicies,
    [string[]] $CustomEvents,
    [string[]] $NotificationConfigurations,
    [string[]] $NotificationSystems,
    [string[]] $Schedules,

    # Settings pages
    [switch] $SourceConfiguration,
    [switch] $AggregationConfiguration,
    [switch] $PersonLifecycle,
    [switch] $ExcludedPersons,
    [switch] $ReconciliationConfiguration,

    [switch] $All,

    [string] $OutputFolder = (Get-Location).Path,

    [switch] $IncludeSecrets,

    [string] $GatewayUrl,

    # Rows asked for in one go from lists that come in pages
    [int] $Take = 999999
)

$ErrorActionPreference = 'Stop'
$ScriptVersion = '2026-11-12.1'
$ExportedBy = "Export-HelloID.ps1 $ScriptVersion"

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

# The values of a form with their secrets as "***", as the Export buttons do: any value whose name
# says so (also within groups), and the password fields of the form (by a dotted key, "a.b")
function Get-MaskedValues($Values, $Fields) {
    if ($IncludeSecrets -or -not (Test-PlainObject $Values)) { return $Values }
    $copy = Copy-Json $Values
    $byName = {
        param($object)
        foreach ($property in $object.PSObject.Properties) {
            if (Test-PlainObject $property.Value) { & $byName $property.Value }
            elseif ($property.Name -match $SecretName -and (Test-Filled $property.Value)) { $property.Value = $ExportMask }
        }
    }
    & $byName $copy
    foreach ($field in @($Fields)) {
        $key = [string](Get-Value $field 'key')
        if (-not $key -or (Get-Value (Get-Value $field 'templateOptions') 'type') -ne 'password') { continue }
        $parts = $key.Split('.')
        $parent = $copy
        for ($i = 0; $i -lt $parts.Count - 1 -and (Test-PlainObject $parent); $i++) { $parent = Get-Value $parent $parts[$i] }
        $last = $parts[-1]
        if ((Test-PlainObject $parent) -and (Test-Filled (Get-Value $parent $last))) { $parent.$last = $ExportMask }
    }
    return $copy
}

# A notification system with the secrets of its settings as "***"
function Get-MaskedNotificationSystem($System) {
    $settings = Get-Value $System 'systemConfiguration'
    if ($IncludeSecrets -or -not (Test-PlainObject $settings)) { return $System }
    $copy = Copy-Json $System
    $copy.systemConfiguration.data = Get-MaskedValues (Get-Value $settings 'data') (Get-Value $settings 'fields')
    return $copy
}

# A source system with the secrets of its configuration as "***". Its values and form are JSON in a text.
function Get-MaskedSourceSystem($System) {
    $values = try { ConvertFrom-HelloIDJson ([string](Get-Value $System 'scriptConfiguration')) } catch { $null }
    if ($IncludeSecrets -or -not (Test-PlainObject $values)) { return $System }
    $form = try { ConvertFrom-HelloIDJson ([string](Get-Value $System 'scriptConfigurationForm')) } catch { $null }
    $copy = Copy-Json $System
    $copy.scriptConfiguration = ConvertTo-Json -InputObject (Get-MaskedValues $values @($form)) -Depth 100 -Compress
    return $copy
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
            $read = Invoke-HelloIDApi "/service/notifications/api/notification/systems/$(& $escapeId $id)" -Cached
            $systems.Add((Get-MaskedNotificationSystem $read))
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
        exportedBy         = $ExportedBy
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

#endregion Parts of an export

#region Lists and files
# The rows of a list from HelloID: the list itself, or the rows in it (pageData, ...)
function Get-Rows($Answer) {
    if ($null -eq $Answer) { return }
    if ($Answer -is [array]) { $Answer | Where-Object { $null -ne $_ }; return }
    foreach ($name in 'pageData', 'data', 'items', 'results', 'value') {
        $rows = Get-Value $Answer $name
        if ($rows -is [array]) { $rows | Where-Object { $null -ne $_ }; return }
    }
    $Answer
}

# The first of these properties that has a value
function Get-First($Object, [string[]] $Names) {
    foreach ($name in $Names) {
        $value = Get-Value $Object $name
        if ($null -ne $value -and $value -ne '') { return $value }
    }
    return $null
}

# Does a name match one of the patterns? A pattern with * or ? is a wildcard ([ and ] are plain
# characters), one without is an exact name. Both ignore case and the spaces around the name.
function Test-NameMatch([string] $Name, [string[]] $Patterns) {
    $Name = $Name.Trim()
    foreach ($pattern in $Patterns) {
        $pattern = ([string]$pattern).Trim()
        if ($pattern -match '[*?]') { if ($Name -like ($pattern -replace '([\[\]])', '`$1')) { return $true } }
        elseif ($Name -eq $pattern) { return $true }
    }
    return $false
}

# The items whose name matches; an exact name that matches nothing is a warning
function Select-ByName($Items, [string[]] $Patterns, [scriptblock] $NameOf, [string] $Type) {
    $Items = @($Items)
    foreach ($pattern in $Patterns) {
        if ($pattern -notmatch '[*?]' -and -not ($Items | Where-Object { Test-NameMatch (& $NameOf $_) @($pattern) })) {
            Write-Warning "${Type}: there is none named ""$($pattern.Trim())""."
        }
    }
    $Items | Where-Object { Test-NameMatch (& $NameOf $_) $Patterns } | Sort-Object { [string](& $NameOf $_) }
}

# What every file starts with
function New-ExportHeader([string] $Contents, [switch] $Secrets) {
    $header = [ordered]@{
        exportedAt   = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        exportedFrom = $script:BaseUrl
        exportedBy   = $ExportedBy
        contents     = $Contents
    }
    if ($Secrets) { $header.secretsIncluded = [bool]$IncludeSecrets }
    return $header
}

# Writes the file "<name> - <ID> - <date>.json" (without an ID: "<name> - <date>.json") in the
# type's subfolder; returns its path
function Save-Export([string] $Folder, [string] $Name, [string] $Id, $Data) {
    $directory = Join-Path $OutputFolder $Folder
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
    $safe = (([string]$Name).Trim() -replace '[\\/:*?"<>|]+', '_').Trim()
    if (-not $safe) { $safe = 'unnamed' }
    $date = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
    $file = Join-Path $directory $(if ($Id) { "$safe - $Id - $date.json" } else { "$safe - $date.json" })
    [System.IO.File]::WriteAllText($file, (ConvertTo-Json -InputObject $Data -Depth 100), [System.Text.UTF8Encoding]::new($false))
    return $file
}

# Exports each item to a file of its own; one that fails doesn't stop the others
function Export-Items {
    param([string] $Type, [string] $Folder, $Items, [scriptblock] $NameOf, [scriptblock] $IdOf, [scriptblock] $Build)
    $Items = @($Items | Where-Object { $null -ne $_ })
    if (-not $Items.Count) { Write-Warning "${Type}: nothing to export."; return }
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $item = $Items[$i]
        $name = [string](& $NameOf $item)
        Write-Progress -Activity "Export from $script:BaseUrl" -Status "${Type} $($i + 1)/$($Items.Count): $name" `
            -PercentComplete (100 * $i / $Items.Count)
        try {
            $export = & $Build $item
            $file = Save-Export $Folder $name ([string](& $IdOf $item)) $export
            [PSCustomObject]@{ Type = $Type; Name = $name; File = $file; CouldNotRead = @($export['couldNotRead']) -join ', ' }
        }
        catch {
            $script:Failed++
            Write-Error "Export of ${Type} ""$name"" failed: $_" -ErrorAction Continue
        }
    }
}

# Exports a settings page to its file
function Export-Setting([string] $Type, [string] $Folder, [scriptblock] $Build) {
    Write-Progress -Activity "Export from $script:BaseUrl" -Status $Type
    try {
        $export = & $Build
        $file = Save-Export $Folder $Type '' $export
        [PSCustomObject]@{ Type = $Type; Name = $Type; File = $file; CouldNotRead = @($export['couldNotRead']) -join ', ' }
    }
    catch {
        $script:Failed++
        Write-Error "Export of ${Type} failed: $_" -ErrorAction Continue
    }
}

# Target and source systems by ID, for the names next to the IDs in the files: IDs mean nothing in
# another environment
function Get-SystemList {
    if (-not $script:SystemList) {
        $list = [System.Collections.Generic.List[object]]::new()
        foreach ($path in '/service/provisioning-api/api/target-systems?showReferenceSystems=true',
                          '/service/provisioning-api/api/source-systems') {
            try { foreach ($row in (Get-Rows (Invoke-HelloIDApi $path -Cached))) { $list.Add($row) } }
            catch { Write-Warning "Could not read $path for the names of systems: $_" }
        }
        $script:SystemList = $list
    }
    return , $script:SystemList
}

function Get-SystemName($Id) {
    if (-not $Id) { return $null }
    return ((Get-SystemList) | Where-Object { (Get-Value $_ 'systemId') -eq $Id } | Select-Object -First 1 |
        ForEach-Object { Get-Value $_ 'displayName' })
}

# The systems these IDs are, with their names
function Get-SystemNames($Ids) {
    return , @(@($Ids) | Where-Object { $_ } | Select-Object -Unique | ForEach-Object {
            [ordered]@{ systemId = $_; displayName = (Get-SystemName $_) }
        })
}
#endregion Lists and files

#region Types
# <name> - <system ID> - <date>.json, like the Export button
function Export-TargetSystems([string[]] $Patterns) {
    # (A function's list in parentheses: piped item by item)
    $systems = @((Invoke-HelloIDApi '/service/provisioning-api/api/target-systems?showReferenceSystems=true' -Cached) |
        Where-Object { $_ -and $_.systemId -and $_.displayName -is [string] })
    Export-Items 'Target system' 'TargetSystems' (Select-ByName $systems $Patterns { param($s) $s.displayName } 'Target systems') `
        { param($s) $s.displayName } { param($s) $s.systemId } { param($s) Get-SystemExport $s $systems }
}

# As the Export button of a source system: the system, its template (without the README, with its
# catalog ID) and its agents
function Export-SourceSystems([string[]] $Patterns) {
    $systems = @(Get-Rows (Invoke-HelloIDApi '/service/provisioning-api/api/source-systems' -Cached))
    $build = {
        param($row)
        $read = Copy-Json (Invoke-HelloIDApi "/service/provisioning-api/api/source-systems/$(& $escapeId $row.systemId)")
        $meta = Get-Value $read 'repositoryMetaData'
        $template = $null
        if (Test-PlainObject $meta) {
            if ($null -eq $script:SourceCatalog) {
                # (an empty list when it can't be read: tried once)
                $script:SourceCatalog = @(try { Get-Rows (Invoke-HelloIDApi "/service/provisioning-api/api/systems-catalog/source?take=$Take") }
                    catch { Write-Warning "Could not read the catalog of source templates: $_" })
            }
            $template = ConvertTo-Ordered $meta
            $template.Remove('readmeHtml')
            $template.repositoryId = ($script:SourceCatalog | Where-Object { (Get-Value $_ 'name') -eq $meta.name } | Select-Object -First 1 |
                ForEach-Object { Get-Value $_ 'id' })
        }
        $read | Add-Member -NotePropertyName repositoryMetaData -NotePropertyValue $template -Force
        $export = New-ExportHeader 'sourceSystem' -Secrets
        $export.systemId = $read.systemId
        $export.displayName = $read.displayName
        $export.system = Get-MaskedSourceSystem $read
        $export.agents = Get-Agents (& $escapeId $read.systemId)
        $export
    }
    Export-Items 'Source system' 'SourceSystems' (Select-ByName $systems $Patterns { param($s) $s.displayName } 'Source systems') `
        { param($s) $s.displayName } { param($s) $s.systemId } $build
}

# Each business rule in full, published or draft, with the names of the systems of its entitlements
function Export-BusinessRules([string[]] $Patterns) {
    $overview = Invoke-HelloIDApi '/service/rules/api/rules/overview' -Method POST `
        -Body ([ordered]@{ search = ''; skip = 0; take = $Take; published = $true; draft = $true })
    $nameOf = { param($r) Get-First $r 'name', 'ruleName', 'displayName' }
    $idOf = { param($r) Get-First $r 'ruleId', 'identifier', 'id' }
    $build = {
        param($row)
        $rule = Invoke-HelloIDApi "/service/rules/api/rules/$(& $escapeId (& $idOf $row))"
        $export = New-ExportHeader 'businessRule'
        $export.ruleId = & $idOf $row
        $export.name = & $nameOf $row
        $export.rule = $rule
        $export.systems = Get-SystemNames @((Get-Value $rule 'entitlements') | ForEach-Object { Get-Value $_ 'systemIdentifier' })
        $export
    }
    Export-Items 'Business rule' 'BusinessRules' (Select-ByName @(Get-Rows $overview) $Patterns $nameOf 'Business rules') `
        $nameOf $idOf $build
}

# Each toxic policy, with the entitlements it names (by their IDs in this environment, so with
# their names and systems)
function Export-ToxicPolicies([string[]] $Patterns) {
    $policies = @(Get-Rows (Invoke-HelloIDApi "/service/rules/api/toxic-combinations?take=$Take"))
    $build = {
        param($policy)
        $export = New-ExportHeader 'toxicPolicy'
        $export.toxicCombinationId = Get-Value $policy 'toxicCombinationId'
        $export.name = Get-Value $policy 'name'
        $export.policy = $policy
        $ids = @('inputObjectIds', 'outputObjectIds' | ForEach-Object { (Get-Value $policy $_) | Where-Object { $_ } } | Select-Object -Unique)
        if ($ids.Count) {
            $query = ($ids | ForEach-Object { "entitlementIds=$(& $escapeId $_)" }) -join '&'
            try {
                $export.entitlements = @(Get-Rows (Invoke-HelloIDApi "/service/rules/api/toxic-combinations/entitlements/by-ids?$query"))
                $export.systems = Get-SystemNames @($export.entitlements | ForEach-Object { Get-Value $_ 'systemIdentifier' })
            }
            catch {
                Write-Warning "Could not read the entitlements of toxic policy ""$($export.name)"": $_"
                $export.couldNotRead = @('entitlements')
            }
        }
        $export
    }
    Export-Items 'Toxic policy' 'ToxicPolicies' (Select-ByName $policies $Patterns { param($p) $p.name } 'Toxic policies') `
        { param($p) $p.name } { param($p) $p.toxicCombinationId } $build
}

# Each custom event of the notifications, with the name of its system
function Export-CustomEvents([string[]] $Patterns) {
    $events = @(Get-Rows (Invoke-HelloIDApi "/service/notifications/api/custom-events?take=$Take"))
    $build = {
        param($customEvent)
        $export = New-ExportHeader 'customEvent'
        $export.customEventId = Get-Value $customEvent 'customEventId'
        $export.name = Get-Value $customEvent 'name'
        $export.systemName = Get-SystemName (Get-Value $customEvent 'systemId')
        $export.customEvent = $customEvent
        $export
    }
    Export-Items 'Custom event' 'CustomEvents' (Select-ByName $events $Patterns { param($e) $e.name } 'Custom events') `
        { param($e) $e.name } { param($e) $e.customEventId } $build
}

# As the Export button of a notification: in full, with the names of what it refers to, and the
# secrets of its template data as "***". One notification per file.
function Export-NotificationConfigurations([string[]] $Patterns) {
    $list = Invoke-HelloIDApi "/service/notifications/api/notifications?skip=0&take=$Take&enabled=false&disabled=false" -Cached
    $senders = @(Get-Rows (Invoke-HelloIDApi '/service/notifications/api/notification/systems' -Cached))
    $build = {
        param($row)
        $read = Copy-Json (Invoke-HelloIDApi "/service/notifications/api/notifications/$(& $escapeId $row.identifier)" -Cached)
        $notificationSystem = $senders | Where-Object { (Get-Value $_ 'systemId') -eq $read.notificationSystemId } | Select-Object -First 1
        $template = $null
        if ($read.notificationSystemId) {
            $detail = try { Invoke-HelloIDApi "/service/notifications/api/notification/systems/$(& $escapeId $read.notificationSystemId)" -Cached }
            catch { $null }
            $template = (Get-Value $detail 'notificationTemplates') |
                Where-Object { $null -ne $_ -and (Get-Value $_ 'templateId') -eq $read.notificationTemplateId } | Select-Object -First 1
        }
        $notification = ConvertTo-Ordered $read
        $notification.notificationTemplateData = Get-MaskedValues (Get-Value $read 'notificationTemplateData') (Get-Value $template 'fields')
        $notification.dataReferences = @((Get-Value $read 'dataReferences') | Where-Object { $null -ne $_ } | ForEach-Object {
                $reference = ConvertTo-Ordered $_
                $reference.displayName = Get-SystemName $reference['systemId']
                $reference
            })
        $notification.systemName = Get-SystemName $read.systemId
        $notification.notificationSystemName = Get-Value $notificationSystem 'displayName'
        $notification.notificationSystemBuiltin = (Get-Value $notificationSystem 'isBuiltin') -eq $true
        $notification.notificationTemplateName = Get-Value $template 'displayName'
        $export = New-ExportHeader 'notifications' -Secrets
        $export.notifications = @($notification)
        $export
    }
    Export-Items 'Notification' 'NotificationConfigurations' `
        (Select-ByName @(Get-Rows $list) $Patterns { param($n) $n.name } 'Notification configurations') `
        { param($n) $n.name } { param($n) $n.identifier } $build
}

# As the Export button of a notification system: the system, secrets as "***", and its agents
function Export-NotificationSystems([string[]] $Patterns) {
    $systems = @(Get-Rows (Invoke-HelloIDApi '/service/notifications/api/notification/systems' -Cached))
    $build = {
        param($row)
        $read = Invoke-HelloIDApi "/service/notifications/api/notification/systems/$(& $escapeId $row.systemId)" -Cached
        $export = New-ExportHeader 'notificationSystem' -Secrets
        $export.systemId = $read.systemId
        $export.displayName = $read.displayName
        $export.system = Get-MaskedNotificationSystem $read
        $export.agents = Get-Agents (& $escapeId $read.systemId)
        $export
    }
    Export-Items 'Notification system' 'NotificationSystems' `
        (Select-ByName $systems $Patterns { param($s) $s.displayName } 'Notification systems') `
        { param($s) $s.displayName } { param($s) $s.systemId } $build
}

# Each schedule of the snapshots, with the names of the systems of its tasks. HelloID gives the
# hours in the time zone that is asked for: this computer's.
function Export-Schedules([string[]] $Patterns) {
    $zone = [TimeZoneInfo]::Local
    $iana = $null
    if ($zone.HasIanaId) { $iana = $zone.Id }
    elseif (-not [TimeZoneInfo]::TryConvertWindowsIdToIanaId($zone.Id, [ref]$iana)) { $iana = 'UTC' }
    $schedules = @(Get-Rows (Invoke-HelloIDApi "/service/scheduler/api/schedule?timeZone=$(& $escapeId $iana)"))
    $build = {
        param($schedule)
        $export = New-ExportHeader 'schedule'
        $export.scheduleId = Get-Value $schedule 'scheduleId'
        $export.name = Get-Value $schedule 'name'
        $export.timeZone = $iana
        $export.schedule = $schedule
        $export.systems = Get-SystemNames @((Get-Value $schedule 'tasks') | ForEach-Object { Get-Value $_ 'systemId' })
        $export
    }
    Export-Items 'Schedule' 'Schedules' (Select-ByName $schedules $Patterns { param($s) $s.name } 'Schedules') `
        { param($s) $s.name } { param($s) $s.scheduleId } $build
}

# Source > Configuration: primary contract, primary manager and display name, and the custom fields
function Export-SourceConfiguration {
    Export-Setting 'Source configuration' 'SourceConfiguration' {
        $export = New-ExportHeader 'sourceConfiguration'
        $export.calculatedLayers = Invoke-HelloIDApi '/service/provisioning-integration/api/calculatedlayers/config'
        $export.customFields = Invoke-HelloIDApi '/service/provisioning-integration/api/customfields'
        $export
    }
}

# Source > Aggregation: the settings of the automatic aggregation and the suggestions
function Export-AggregationConfiguration {
    Export-Setting 'Aggregation configuration' 'AggregationConfiguration' {
        $export = New-ExportHeader 'aggregationConfiguration'
        $export.configuration = Invoke-HelloIDApi '/service/provisioning-pipeline/api/aggregation/automatic/configuration'
        $export
    }
}

# The person lifecycle: how many days before each event
function Export-PersonLifecycle {
    Export-Setting 'Person lifecycle' 'PersonLifecycle' {
        $export = New-ExportHeader 'personLifecycle'
        $export.configuration = Invoke-HelloIDApi '/service/provisioning-pipeline/api/person-lifecycle'
        $export
    }
}

# The persons that are excluded from provisioning. This is personal data.
function Export-ExcludedPersons {
    Export-Setting 'Excluded persons' 'ExcludedPersons' {
        $export = New-ExportHeader 'excludedPersons'
        $export.persons = @(Get-Rows (Invoke-HelloIDApi (
            "/service/provisioning-integration/api/vault/latest/persons?skip=0&take=$Take&search=&includedOnly=false&excludedOnly=true")))
        $export
    }
}

# Reconciliation: its schedule, the automatic actions per system, and the exclusions
function Export-ReconciliationConfiguration {
    Export-Setting 'Reconciliation configuration' 'ReconciliationConfiguration' {
        $export = New-ExportHeader 'reconciliationConfiguration'
        $export.schedule = Invoke-HelloIDApi '/service/scheduler/api/schedule/reconciliation/configuration'
        $export.systemConfiguration = Invoke-HelloIDApi '/service/reconciliation/api/report/system-configuration'
        $export.exclusions = Invoke-HelloIDApi '/service/reconciliation/api/exclusions?forBulkActions=false' -Method POST `
            -Body ([ordered]@{ search = ''; filters = @(); skip = 0; take = $Take })
        $export.systems = Get-SystemNames @(
            @((Get-Value $export.schedule 'selectedSystems') | Where-Object { $_ }) +
            @(Get-Rows $export.systemConfiguration | ForEach-Object { Get-Value $_ 'systemId' }))
        $export
    }
}
#endregion Types

#region Main
$named = [ordered]@{
    TargetSystems              = 'Export-TargetSystems'
    SourceSystems              = 'Export-SourceSystems'
    BusinessRules              = 'Export-BusinessRules'
    ToxicPolicies              = 'Export-ToxicPolicies'
    CustomEvents               = 'Export-CustomEvents'
    NotificationConfigurations = 'Export-NotificationConfigurations'
    NotificationSystems        = 'Export-NotificationSystems'
    Schedules                  = 'Export-Schedules'
}
$settings = [ordered]@{
    SourceConfiguration         = 'Export-SourceConfiguration'
    AggregationConfiguration    = 'Export-AggregationConfiguration'
    PersonLifecycle             = 'Export-PersonLifecycle'
    ExcludedPersons             = 'Export-ExcludedPersons'
    ReconciliationConfiguration = 'Export-ReconciliationConfiguration'
}
# What to export: what the parameters name, or with -All everything (a type that is given keeps
# its own patterns)
$patterns = [ordered]@{}
foreach ($name in $named.Keys) {
    $given = Get-Variable -Name $name -ValueOnly
    if ($given) { $patterns[$name] = $given } elseif ($All) { $patterns[$name] = @('*') }
}
$pages = @($settings.Keys | Where-Object { $All -or (Get-Variable -Name $_ -ValueOnly) })
if (-not $patterns.Count -and -not $pages.Count) {
    throw 'Nothing to export. Name what to export, e.g. -TargetSystems * -BusinessRules *customer*, or give -All. ' +
          "Types by name: $(($named.Keys | ForEach-Object { "-$_" }) -join ', '). " +
          "Settings pages: $(($settings.Keys | ForEach-Object { "-$_" }) -join ', ')."
}

$script:BaseUrl = 'https://' + ($Domain.Trim() -replace '^https?://', '').TrimEnd('/')
if (-not $Credential) { $Credential = Get-Credential -Message "Local admin account of $script:BaseUrl" }
if (-not (Test-Path -LiteralPath $OutputFolder)) { New-Item -ItemType Directory -Path $OutputFolder | Out-Null }
$OutputFolder = (Resolve-Path -LiteralPath $OutputFolder).Path
if ($IncludeSecrets) { Write-Warning 'The files will have the SECRETS in them.' }
if ($pages -contains 'ExcludedPersons') { Write-Warning 'The file of the excluded persons has PERSONAL DATA in it.' }

Connect-HelloID

$script:Failed = 0
foreach ($name in $patterns.Keys) {
    try { & $named[$name] $patterns[$name] }
    catch {
        $script:Failed++
        Write-Error "Export of $name failed: $_" -ErrorAction Continue
    }
}
foreach ($name in $pages) { & $settings[$name] }
Write-Progress -Activity "Export from $script:BaseUrl" -Completed

if ($script:Failed) {
    Write-Error "$script:Failed export(s) failed; see the errors above." -ErrorAction Continue
    exit 1
}
#endregion Main
