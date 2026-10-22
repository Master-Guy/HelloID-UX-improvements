// ==UserScript==
// @name         HelloID Entra ID certificates
// @version      2026-10-21.3
// @description  Moves HelloID target systems for Microsoft Entra ID from a client secret to a certificate. Needs "HelloID UX improvements".
// @updateURL    https://raw.githubusercontent.com/Master-Guy/HelloID-UX-improvements/refs/heads/main/HelloID-Entra-certificates.user.js
// @downloadURL  https://raw.githubusercontent.com/Master-Guy/HelloID-UX-improvements/refs/heads/main/HelloID-Entra-certificates.user.js
// @author       Master-Guy
// @homepageURL  https://github.com/Master-Guy/HelloID-UX-improvements
// @match        https://*.helloid.com/*
// @match        https://*.helloid.training/*
// @include      /^https:\/\/[^\/]*helloid[^\/]*\//
// @require      https://cdnjs.cloudflare.com/ajax/libs/forge/1.4.0/forge.min.js#sha256=d9b9074e6861200d676e25dcfe97889db5e8f4150bb766d29c491ad709a51b58
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      login.microsoftonline.com
// @connect      graph.microsoft.com
// @sandbox      JavaScript
// ==/UserScript==

(function () {
    'use strict';

    // What this script adds to the target systems page of "HelloID UX
    // improvements" (it uses that script's list, dialogs and requests):
    //   🔐 symbol and button: a system that gets its token from Microsoft with a
    //       client secret moves to a certificate: backup, configuration
    //       fields, certificate, PIM role, upload to Azure, test, scripts.
    //       Also continues a move that was stopped halfway.
    //   🚧 symbol: the system has the certificate fields, but its scripts
    //       don't use them yet (click 🔐 to continue)
    //   🧪 symbol and button: the scripts use the certificate, and the
    //       client secret is still in the configuration. Once the scripts
    //       are tested with dry runs, the button removes the secret field.

    // =====================================================================
    // Settings
    // =====================================================================

    // The certificate: its name is this, then the name of the system
    const CERTIFICATE_NAME_PREFIX = 'Sogeti_HelloID';
    const CERTIFICATE_VALIDITY_YEARS = 1;
    const PASSWORD_LENGTH = 32;

    // Azure portal pages; {tenant} and {appId} are the system's TenantID
    // and AppId
    const PIM_ROLE = 'Application Administrator';
    const PIM_URL = 'https://portal.azure.com/@{tenant}#view/Microsoft_Azure_PIMCommon/ResourceMenuBlade/~/' +
                    'MyActions/resourceId//resourceType/tenant/provider/aadroles';
    const DOMAINS_URL = 'https://portal.azure.com/@{tenant}#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/Domains';
    const CREDENTIALS_URL = 'https://portal.azure.com/@{tenant}#view/Microsoft_AAD_RegisteredApps/' +
                            'ApplicationMenuBlade/~/Credentials/appId/{appId}/isMSAApp~/false';

    // =====================================================================
    // Configuration fields
    // =====================================================================

    const POWERSHELL_V2 = 'powershell-target';
    const TENANT_KEY = 'TenantID';
    const APP_ID_KEY = 'AppId';
    const SECRET_KEY = 'AppSecret';
    const ORGANIZATION_KEY = 'Organization';
    const CERTIFICATE_KEY = 'AppCertificateBase64String';
    const PASSWORD_KEY = 'AppCertificatePassword';

    // Goes above TenantID
    const ORGANIZATION_FIELD = {
        defaultValue: '',
        key: ORGANIZATION_KEY,
        templateOptions: {
            description: 'You must use the primary .onmicrosoft.com domain of the organization. ' +
                         'Using anything else may lead to inconsistent results.',
            label: 'Organization',
            placeholder: '<tenant>.onmicrosoft.com',
            required: true,
        },
        type: 'input',
    };
    const ORGANIZATION_FORMAT = /^[a-z0-9][a-z0-9-]*\.onmicrosoft\.com$/i;

    // Go after the last text field, before the first checkbox
    const CERTIFICATE_FIELDS = [
        {
            defaultValue: '',
            key: CERTIFICATE_KEY,
            templateOptions: {
                label: 'App Registration Certificate Base 64 String',
                placeholder: 'WFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFg==',
                required: true,
                type: 'password',
            },
            type: 'input',
        },
        {
            defaultValue: '',
            key: PASSWORD_KEY,
            templateOptions: {
                label: 'App Registration Certificate Password',
                placeholder: 'P@ssw0rd!',
                required: true,
                type: 'password',
            },
            type: 'input',
        },
    ];

    const clone = (value) => JSON.parse(JSON.stringify(value));
    const fieldIndex = (fields, key) => fields.findIndex(f => String(f?.key).toLowerCase() === key.toLowerCase());
    const isFilled = (value) => typeof value === 'string' && value.trim() !== '';

    // The form with the fields for the certificate (and Organization)
    // added where they are missing
    function withCertificateFields(form) {
        const result = clone(form ?? {});
        const fields = result.fields = result.fields ?? [];
        if (fieldIndex(fields, ORGANIZATION_KEY) < 0) {
            fields.splice(Math.max(0, fieldIndex(fields, TENANT_KEY)), 0, clone(ORGANIZATION_FIELD));
        }
        const missing = CERTIFICATE_FIELDS.filter(f => fieldIndex(fields, f.key) < 0);
        if (missing.length) {
            const firstCheckbox = fields.findIndex(f => f?.type === 'checkbox');
            fields.splice(firstCheckbox < 0 ? fields.length : firstCheckbox, 0, ...clone(missing));
        }
        return result;
    }

    // =====================================================================
    // Script conversion
    // =====================================================================
    // Only the authentication changes: everything else in a script stays
    // as it is, including its variable names and line ends. Two shapes of
    // scripts (those of Tools4ever's Microsoft Entra ID connector) are
    // known:
    //   A: account scripts, with a "#region Create access token" that
    //      requests the token with client_secret
    //   B: permission scripts, with a function New-AuthorizationHeaders
    //      that takes -ClientSecret
    // A script that uses the client secret in another way is not changed,
    // and stops the move before anything is changed.

    const USES_SECRET = /client_secret|Configuration\.AppSecret\b/i;
    const USES_CERTIFICATE = /Configuration\.AppCertificateBase64String\b/i;
    const ENTRA_TOKEN = /login\.microsoftonline\.com/i;
    const AUTHENTICATION_COMMENT = '# Authentication: certificate-based (JWT client assertion)';

    const CERTIFICATE_FUNCTION = String.raw`
function Get-MSEntraCertificate {
    [CmdletBinding()]
    param()
    try {
        $rawCertificate = [system.convert]::FromBase64String($actionContext.Configuration.AppCertificateBase64String)
        $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($rawCertificate, $actionContext.Configuration.AppCertificatePassword, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
        Write-Output $certificate
    }
    catch {
        $PSCmdlet.ThrowTerminatingError($_)
    }
}
`;

    // Shape A: returns the whole answer, so expires_in can still be logged
    const ACCESS_TOKEN_FUNCTION = String.raw`
function Get-MSEntraAccessToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        $Certificate
    )
    try {
        # Ensure the certificate has a private key
        if (-not $Certificate.HasPrivateKey -or -not $Certificate.PrivateKey) {
            throw "The certificate does not have a private key."
        }

        # Get the DER encoded bytes of the certificate
        $derBytes = $Certificate.RawData

        # Compute the SHA-256 hash of the DER encoded bytes
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        $hashBytes = $sha256.ComputeHash($derBytes)
        $base64Thumbprint = [System.Convert]::ToBase64String($hashBytes).Replace('+', '-').Replace('/', '_').Replace('=', '')

        # Create a JWT (JSON Web Token) header
        $header = @{
            'alg'      = 'RS256'
            'typ'      = 'JWT'
            'x5t#S256' = $base64Thumbprint
        } | ConvertTo-Json
        $base64Header = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($header))

        # Calculate the Unix timestamp (seconds since 1970-01-01T00:00:00Z) for 'exp', 'nbf' and 'iat'
        $currentUnixTimestamp = [math]::Round(((Get-Date).ToUniversalTime() - ([datetime]'1970-01-01T00:00:00Z').ToUniversalTime()).TotalSeconds)

        # Create a JWT payload
        $payload = [Ordered]@{
            'iss' = "$($actionContext.Configuration.AppId)"
            'sub' = "$($actionContext.Configuration.AppId)"
            'aud' = "https://login.microsoftonline.com/$($actionContext.Configuration.TenantID)/oauth2/token"
            'exp' = ($currentUnixTimestamp + 3600) # Expires in 1 hour
            'nbf' = ($currentUnixTimestamp - 300) # Not before 5 minutes ago
            'iat' = $currentUnixTimestamp
            'jti' = [Guid]::NewGuid().ToString()
        } | ConvertTo-Json
        $base64Payload = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payload)).Replace('+', '-').Replace('/', '_').Replace('=', '')

        # Extract the private key from the certificate
        $rsaPrivate = $Certificate.PrivateKey
        $rsa = [System.Security.Cryptography.RSACryptoServiceProvider]::new()
        $rsa.ImportParameters($rsaPrivate.ExportParameters($true))

        # Sign the JWT
        $signatureInput = "$base64Header.$base64Payload"
        $signature = $rsa.SignData([Text.Encoding]::UTF8.GetBytes($signatureInput), 'SHA256')
        $base64Signature = [System.Convert]::ToBase64String($signature).Replace('+', '-').Replace('/', '_').Replace('=', '')

        # Create the JWT token
        $jwtToken = "$($base64Header).$($base64Payload).$($base64Signature)"

        $createAccessTokenBody = @{
            grant_type            = "client_credentials"
            client_id             = $actionContext.Configuration.AppId
            client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
            client_assertion      = $jwtToken
            resource              = "https://graph.microsoft.com"
        }

        $createAccessTokenSplatParams = @{
            Uri         = "https://login.microsoftonline.com/$($actionContext.Configuration.TenantID)/oauth2/token"
            Body        = $createAccessTokenBody
            Method      = "POST"
            ContentType = "application/x-www-form-urlencoded"
            Verbose     = $false
            ErrorAction = "Stop"
        }

        # Return the full token response so expires_in stays available for logging
        $createAccessTokenResponse = Invoke-RestMethod @createAccessTokenSplatParams
        Write-Output $createAccessTokenResponse
    }
    catch {
        $PSCmdlet.ThrowTerminatingError($_)
    }
}
`;

    // Shape A: the region's new content. $createAccessTokenResonse
    // becomes the script's own name for the answer.
    const ACCESS_TOKEN_REGION = String.raw`
#region Create access token
$actionMessage = "loading certificate"

$certificate = Get-MSEntraCertificate

Write-Verbose "Loaded certificate. Thumbprint: $($certificate.Thumbprint). Expires: $($certificate.NotAfter)"

$actionMessage = "creating access token"

$createAccessTokenResonse = Get-MSEntraAccessToken -Certificate $certificate

Write-Verbose "Created access token. Expires in: $($createAccessTokenResonse.expires_in | ConvertTo-Json)"
#endregion Create access token
`;

    // Shape B: replaces the request body with client_secret in
    // New-AuthorizationHeaders; the rest of the function stays
    const CLIENT_ASSERTION_BODY = String.raw`
# Ensure the certificate has a private key
if (-not $Certificate.HasPrivateKey -or -not $Certificate.PrivateKey) {
    throw "The certificate does not have a private key."
}

# Get the DER encoded bytes of the certificate
$derBytes = $Certificate.RawData

# Compute the SHA-256 hash of the DER encoded bytes
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$hashBytes = $sha256.ComputeHash($derBytes)
$base64Thumbprint = [System.Convert]::ToBase64String($hashBytes).Replace('+', '-').Replace('/', '_').Replace('=', '')

# Create a JWT (JSON Web Token) header
$jwtHeader = @{
    'alg'      = 'RS256'
    'typ'      = 'JWT'
    'x5t#S256' = $base64Thumbprint
} | ConvertTo-Json
$base64Header = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($jwtHeader))

# Calculate the Unix timestamp (seconds since 1970-01-01T00:00:00Z) for 'exp', 'nbf' and 'iat'
$currentUnixTimestamp = [math]::Round(((Get-Date).ToUniversalTime() - ([datetime]'1970-01-01T00:00:00Z').ToUniversalTime()).TotalSeconds)

# Create a JWT payload
$jwtPayload = [Ordered]@{
    'iss' = "$ClientId"
    'sub' = "$ClientId"
    'aud' = $authUri
    'exp' = ($currentUnixTimestamp + 3600) # Expires in 1 hour
    'nbf' = ($currentUnixTimestamp - 300) # Not before 5 minutes ago
    'iat' = $currentUnixTimestamp
    'jti' = [Guid]::NewGuid().ToString()
} | ConvertTo-Json
$base64Payload = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($jwtPayload)).Replace('+', '-').Replace('/', '_').Replace('=', '')

# Extract the private key from the certificate
$rsaPrivate = $Certificate.PrivateKey
$rsa = [System.Security.Cryptography.RSACryptoServiceProvider]::new()
$rsa.ImportParameters($rsaPrivate.ExportParameters($true))

# Sign the JWT
$signatureInput = "$base64Header.$base64Payload"
$signature = $rsa.SignData([Text.Encoding]::UTF8.GetBytes($signatureInput), 'SHA256')
$base64Signature = [System.Convert]::ToBase64String($signature).Replace('+', '-').Replace('/', '_').Replace('=', '')

# Create the JWT token
$jwtToken = "$($base64Header).$($base64Payload).$($base64Signature)"

$body = @{
    grant_type            = "client_credentials"
    client_id             = "$ClientId"
    client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
    client_assertion      = $jwtToken
    resource              = "https://graph.microsoft.com"
}
`;

    // Shape B: the region's new content. $headers becomes the script's
    // own name for the headers.
    const AUTHORIZATION_HEADERS_REGION = String.raw`
#region Create authorization headers
$actionMessage = "loading certificate"

$certificate = Get-MSEntraCertificate

Write-Verbose "Loaded certificate. Thumbprint: $($certificate.Thumbprint). Expires: $($certificate.NotAfter)"

$actionMessage = "creating authorization headers"

$authorizationHeadersSplatParams = @{
    TenantId    = $actionContext.Configuration.TenantID
    ClientId    = $actionContext.Configuration.AppId
    Certificate = $certificate
}

$headers = New-AuthorizationHeaders @authorizationHeadersSplatParams

Write-Verbose "Created authorization headers. Result: $($headers | ConvertTo-Json)"
#endregion Create authorization headers
`;

    const ACCESS_TOKEN_REGION_RE =
        /^([ \t]*)#region Create access token\b[^\r\n]*\r?\n[\s\S]*?^[ \t]*#endregion Create access token\b[^\r\n]*/gm;
    const HEADERS_REGION_RE =
        /^([ \t]*)#region Create authorization headers\b[^\r\n]*\r?\n[\s\S]*?^[ \t]*#endregion Create authorization headers\b[^\r\n]*/gm;
    const FUNCTIONS_END_RE = /^#endregion functions\b/gm;
    const HEADERS_FUNCTION_RE = /^function\s+New-AuthorizationHeaders\b/gmi;

    const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

    // A template with the script's line ends, each line indented
    const lines = (template, eol, indent = '') => template.replace(/^\n|\n$/g, '').split('\n')
        .map(line => (line ? indent + line : line)).join(eol);

    const countOf = (text, re) => (text.match(re) ?? []).length;

    // The closing brace of the block that opens at text[open]
    function closingBrace(text, open) {
        let depth = 0;
        for (let i = open; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}' && --depth === 0) return i;
        }
        return -1;
    }

    // Shape A
    function convertAccessTokenRegion(text, eol) {
        const regions = [...text.matchAll(ACCESS_TOKEN_REGION_RE)];
        if (regions.length !== 1) return { problem: `has ${regions.length} "#region Create access token" blocks` };
        const [region, indent] = regions[0];
        const response = region.match(/\$(\w+)\s*=\s*Invoke-RestMethod\b/)?.[1];
        if (!/client_secret/i.test(region) || !response) {
            return { problem: 'has a "#region Create access token" that does not request the token with client_secret' };
        }
        if (countOf(text, FUNCTIONS_END_RE) !== 1) {
            return { problem: 'has no single "#endregion functions" line to add the functions above' };
        }
        const newRegion = lines(ACCESS_TOKEN_REGION, eol, indent)
            .replaceAll('$createAccessTokenResonse', () => `$${response}`);
        const functions = lines(CERTIFICATE_FUNCTION, eol) + eol + eol + lines(ACCESS_TOKEN_FUNCTION, eol);
        return {
            text: text.replace(region, () => newRegion)
                .replace(new RegExp(FUNCTIONS_END_RE.source, 'm'), (end) => eol + functions + eol + end),
        };
    }

    // Shape B
    function convertAuthorizationHeaders(text, eol) {
        if (countOf(text, HEADERS_FUNCTION_RE) !== 1) {
            return { problem: 'has more than one function New-AuthorizationHeaders' };
        }
        const start = text.search(new RegExp(HEADERS_FUNCTION_RE.source, 'mi'));
        const end = closingBrace(text, text.indexOf('{', start));
        if (end < 0) return { problem: 'has a function New-AuthorizationHeaders without its closing brace' };
        const fn = text.slice(start, end + 1);
        const parameter = /\[string\](\s+)\$ClientSecret\b/i;
        const body = /^([ \t]*)\$body\s*=\s*@\{[^}]*client_secret[^}]*\}/mi;
        if (!parameter.test(fn) || !body.test(fn)) {
            return { problem: 'has a function New-AuthorizationHeaders that is not the known one with -ClientSecret' };
        }
        const newFn = fn.replace(parameter,
            (_, space) => `[System.Security.Cryptography.X509Certificates.X509Certificate2]${space}$Certificate`)
            .replace(body, (_, indent) => lines(CLIENT_ASSERTION_BODY, eol, indent));
        if (/ClientSecret/i.test(newFn)) {
            return { problem: 'uses $ClientSecret in more places of New-AuthorizationHeaders than the known ones' };
        }

        const regions = [...text.matchAll(HEADERS_REGION_RE)];
        if (regions.length !== 1) return { problem: `has ${regions.length} "#region Create authorization headers" blocks` };
        const [region, indent] = regions[0];
        const headers = region.match(/\$(\w+)\s*=\s*New-AuthorizationHeaders\s+@authorizationHeadersSplatParams\b/)?.[1];
        if (!headers || !/ClientSecret\s*=\s*\$actionContext\.Configuration\.AppSecret\b/i.test(region)) {
            return { problem: 'has a "#region Create authorization headers" that is not the known one with ClientSecret' };
        }
        const newRegion = lines(AUTHORIZATION_HEADERS_REGION, eol, indent)
            .replace(/^(\s*)\$headers = /m, (_, space) => `${space}$${headers} = `);

        const withFunctions = text.slice(0, start) + lines(CERTIFICATE_FUNCTION, eol) + eol + eol + newFn +
                              text.slice(end + 1);
        return { text: withFunctions.replace(region, () => newRegion) };
    }

    // { text } with the script changed, or { problem }: why it can't be
    function convertScript(text) {
        if (/function\s+Get-MSEntraCertificate\b/i.test(text)) {
            return { problem: 'already has a function Get-MSEntraCertificate, but still uses the client secret' };
        }
        const eol = eolOf(text);
        const result = countOf(text, ACCESS_TOKEN_REGION_RE) ? convertAccessTokenRegion(text, eol)
            : countOf(text, HEADERS_FUNCTION_RE) ? convertAuthorizationHeaders(text, eol)
            : { problem: 'has neither a "#region Create access token" nor a function New-AuthorizationHeaders' };
        if (result.problem) return result;
        if (USES_SECRET.test(result.text) || /AppSecret|\$ClientSecret\b/i.test(result.text)) {
            return { problem: 'uses the client secret in more places than the known ones' };
        }
        // Under the "# PowerShell V2" line of the header, when there is one
        const marked = result.text.includes(AUTHENTICATION_COMMENT) ? result.text
            : result.text.replace(/^# PowerShell V2\b[^\r\n]*/m, (line) => line + eol + AUTHENTICATION_COMMENT);
        return { text: marked };
    }

    // The scripts of a system: the account scripts, and those of each
    // permission set and resource. Each as { part, label, owner, key }:
    // the script is owner[key].
    function scriptsOf(configuration, resources = []) {
        const found = Object.keys(configuration.scripts ?? {}).map(key =>
            ({ part: 'account', label: `account script "${key}"`, owner: configuration.scripts, key }));
        const scriptsIn = (part, items, what) => (items ?? []).forEach(item => Object.keys(item ?? {})
            .filter(key => /script/i.test(key))
            .forEach(key => found.push({ part, label: `${what} "${item.displayName}": ${key}`, owner: item, key })));
        scriptsIn('permissions', configuration.permissions, 'permission set');
        scriptsIn('resources', resources, 'resource');
        return found.filter(s => isFilled(s.owner[s.key]));
    }

    // Copies of the configuration and resources with every script that
    // uses the client secret changed: { configuration, resources,
    // changed (the scripts), problems (texts) }
    function convertScripts(configuration, resources = []) {
        const copy = { configuration: clone(configuration), resources: clone(resources) };
        const changed = [];
        const problems = [];
        scriptsOf(copy.configuration, copy.resources).forEach(script => {
            const text = script.owner[script.key];
            if (!USES_SECRET.test(text)) return;
            const result = convertScript(text);
            if (result.problem) {
                problems.push(`The ${script.label} ${result.problem}.`);
                return;
            }
            script.owner[script.key] = result.text;
            changed.push(script);
        });
        return { ...copy, changed, problems };
    }

    // =====================================================================
    // Certificates
    // =====================================================================
    // Made in the browser, like GenCert.ps1 makes them: RSA 2048,
    // self-signed, for digital signatures. The key is made by the
    // browser (WebCrypto), the certificate and the .pfx by node-forge.
    // The .pfx is encrypted with 3DES, which every Windows and .NET
    // version can read.

    const forgeLib = () => {
        const lib = window.forge ?? globalThis.forge;
        if (!lib) throw new Error('node-forge did not load. Reload the page and try again.');
        return lib;
    };

    const bytesToBinary = (bytes) => {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return binary;
    };
    const binaryToBytes = (binary) => Uint8Array.from(binary, c => c.charCodeAt(0));
    const base64Url = (binary) => forgeLib().util.encode64(binary)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))]
        .map(b => b.toString(16).padStart(2, '0')).join('');

    // Letters, digits and a few signs that need no escaping anywhere
    const PASSWORD_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!#%+=';

    function randomPassword(length = PASSWORD_LENGTH) {
        const characters = [];
        // No modulo bias: values past the last full set are drawn again
        const limit = 256 - (256 % PASSWORD_CHARACTERS.length);
        while (characters.length < length) {
            crypto.getRandomValues(new Uint8Array(length)).forEach(b => {
                if (b < limit && characters.length < length) characters.push(PASSWORD_CHARACTERS[b % PASSWORD_CHARACTERS.length]);
            });
        }
        return characters.join('');
    }

    // The name in the certificate: at most 64 characters (X.509)
    const certificateName = (systemName) => `${CERTIFICATE_NAME_PREFIX} - ${systemName}`.slice(0, 64).trim();

    // When a certificate made now is valid: from 5 minutes ago (clocks
    // differ), for CERTIFICATE_VALIDITY_YEARS
    function validityFromNow() {
        const notBefore = new Date(Date.now() - 5 * 60 * 1000);
        const notAfter = new Date(notBefore);
        notAfter.setFullYear(notAfter.getFullYear() + CERTIFICATE_VALIDITY_YEARS);
        return { notBefore, notAfter };
    }

    // What a certificate is, for the messages and the test
    function describeCertificate(cert, privateKey) {
        const forge = forgeLib();
        const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
        return {
            cert,
            privateKey,
            der,
            name: cert.subject.getField('CN')?.value ?? '',
            notBefore: cert.validity.notBefore,
            notAfter: cert.validity.notAfter,
            // As Azure shows it
            thumbprint: forge.md.sha1.create().update(der).digest().toHex().toUpperCase(),
        };
    }

    // A new certificate: { ...describeCertificate, password, pfxBase64,
    // pfx and cer (bytes) }
    async function createCertificate(systemName) {
        const forge = forgeLib();
        const keys = await crypto.subtle.generateKey({
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
        }, true, ['sign', 'verify']);
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
        const privateKey = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(bytesToBinary(pkcs8)));

        const cert = forge.pki.createCertificate();
        cert.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
        // Positive: the first bit is 0
        cert.serialNumber = `0${randomHex(16).slice(1)}`;
        const { notBefore, notAfter } = validityFromNow();
        cert.validity.notBefore = notBefore;
        cert.validity.notAfter = notAfter;
        // UTF-8: the name may have characters a PrintableString doesn't
        // allow, like _ and [ ]
        const subject = [{ name: 'commonName', value: certificateName(systemName), valueTagClass: forge.asn1.Type.UTF8 }];
        cert.setSubject(subject);
        cert.setIssuer(subject);
        cert.setExtensions([
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', critical: true, digitalSignature: true },
            { name: 'subjectKeyIdentifier' },
        ]);
        cert.sign(privateKey, forge.md.sha256.create());

        const password = randomPassword();
        const pfx = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(privateKey, [cert], password, {
            algorithm: '3des',
            friendlyName: certificateName(systemName),
        })).getBytes();
        const described = describeCertificate(cert, privateKey);
        return {
            ...described,
            password,
            pfxBase64: forge.util.encode64(pfx),
            pfx: binaryToBytes(pfx),
            cer: binaryToBytes(described.der),
        };
    }

    // The certificate and key in a .pfx (as base64), as describeCertificate
    function readCertificate(base64, password) {
        const forge = forgeLib();
        let p12;
        try {
            p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(base64.replace(/\s+/g, ''))),
                password);
        } catch (e) {
            throw new Error(`The certificate could not be read: ${e?.message ?? e}. Check the base64 string and the password.`);
        }
        const bagsOf = (type) => p12.getBags({ bagType: type })[type] ?? [];
        const key = [...bagsOf(forge.pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(forge.pki.oids.keyBag)]
            .map(bag => bag.key).find(Boolean);
        if (!key) throw new Error('The certificate has no private key.');
        if (!key.n) throw new Error('The private key of the certificate is not an RSA key.');
        const cert = bagsOf(forge.pki.oids.certBag).map(bag => bag.cert)
            .find(c => c?.publicKey?.n?.equals(key.n));
        if (!cert) throw new Error('The certificate that goes with the private key is not in it.');
        return describeCertificate(cert, key);
    }

    // The signed assertion that stands in for the client secret, as the
    // scripts make it (but valid for 10 minutes)
    function clientAssertion(certificate, tenant, appId) {
        const forge = forgeLib();
        const thumbprint = forge.md.sha256.create().update(certificate.der).digest().getBytes();
        const now = Math.round(Date.now() / 1000);
        const part = (value) => base64Url(forge.util.encodeUtf8(JSON.stringify(value)));
        const input = `${part({ alg: 'RS256', typ: 'JWT', 'x5t#S256': base64Url(thumbprint) })}.${part({
            iss: appId,
            sub: appId,
            aud: `https://login.microsoftonline.com/${tenant}/oauth2/token`,
            exp: now + 600,
            nbf: now - 300,
            iat: now,
            jti: crypto.randomUUID(),
        })}`;
        const md = forge.md.sha256.create();
        md.update(input, 'utf8');
        return `${input}.${base64Url(certificate.privateKey.sign(md))}`;
    }

    // A request to Microsoft (outside HelloID, without the browser's
    // Microsoft cookies). Resolves to the answer as JSON; rejects with
    // Microsoft's explanation.
    function requestMicrosoft(details) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            ...details,
            anonymous: true,
            timeout: 30000,
            onload: (response) => {
                let answer = null;
                try { answer = JSON.parse(response.responseText); } catch { /* not JSON */ }
                if (response.status !== 200 || !answer) {
                    reject(new Error(answer?.error_description?.split(/\r?\n/)[0] ?? answer?.error?.message ??
                                     `Microsoft answered ${response.status}.`));
                    return;
                }
                resolve(answer);
            },
            onerror: () => reject(new Error('Microsoft could not be reached.')),
            ontimeout: () => reject(new Error('Microsoft did not answer within 30 seconds.')),
        }));
    }

    // A token for Microsoft Graph, with the certificate or the client
    // secret: { certificate } or { secret }
    async function graphToken({ certificate, secret }, tenant, appId) {
        const answer = await requestMicrosoft({
            method: 'POST',
            url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/token`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: appId,
                ...(certificate ? {
                    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                    client_assertion: clientAssertion(certificate, tenant, appId),
                } : { client_secret: secret }),
                resource: 'https://graph.microsoft.com',
            }).toString(),
        });
        if (!answer.access_token) throw new Error('Microsoft did not give a token.');
        return answer.access_token;
    }

    // Asks Microsoft for a token with the certificate, as the scripts do.
    // Resolves to the application permissions in the token.
    async function requestToken(certificate, tenant, appId) {
        const token = await graphToken({ certificate }, tenant, appId);
        try {
            const claims = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(atob(claims)).roles ?? [];
        } catch {
            return []; // only for the message
        }
    }

    // The tenant's initial .onmicrosoft.com domain (what Organization
    // has to be), from Microsoft Graph, with the client secret. Needs
    // Organization.Read.All or Directory.Read.All.
    async function initialDomain(secret, tenant, appId) {
        const token = await graphToken({ secret }, tenant, appId);
        const answer = await requestMicrosoft({
            method: 'GET',
            url: 'https://graph.microsoft.com/v1.0/organization?$select=verifiedDomains',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        const domain = (answer.value ?? []).flatMap(o => o.verifiedDomains ?? []).find(d => d.isInitial)?.name;
        if (!domain) throw new Error('Microsoft Graph did not name the initial domain.');
        return domain;
    }

    // =====================================================================
    // State of the systems
    // =====================================================================
    // Read from each PowerShell v2 system's configuration, in the
    // background, a few at a time; kept for a few minutes.
    //   start:   gets its token with the client secret        (🔐)
    //   pending: has the certificate fields, but its scripts don't use
    //            them yet, or the certificate isn't filled in  (🚧, 🔐)
    //   testing: uses the certificate, the secret field is
    //            still there                                   (🧪)
    //   null:    nothing to do

    const CONFIGURATION_PATH = (id) => `/connector/powershell-target/api/configuration/${encodeURIComponent(id)}`;
    const RESOURCES_PATH = (id) => `/connector/powershell-target/api/resources/${encodeURIComponent(id)}`;
    const STATE_MAX_AGE_MS = 5 * 60 * 1000;
    const LOAD_BATCH = 6;

    let ux = null; // window.HelloIDUX of "HelloID UX improvements"
    const states = new Map(); // system ID -> { state, time }

    function systemState(configuration) {
        const fields = configuration.scriptConfigurationForm?.fields ?? [];
        const has = (key) => fieldIndex(fields, key) >= 0;
        if (!has(SECRET_KEY)) return null;
        const scripts = scriptsOf(configuration).map(s => s.owner[s.key]);
        const usesSecret = scripts.some(text => USES_SECRET.test(text));
        if (!has(CERTIFICATE_KEY) || !has(PASSWORD_KEY)) {
            return usesSecret && scripts.some(text => ENTRA_TOKEN.test(text)) ? 'start' : null;
        }
        const values = configuration.scriptConfiguration ?? {};
        const ready = !usesSecret && scripts.some(text => USES_CERTIFICATE.test(text)) &&
                      isFilled(values[CERTIFICATE_KEY]) && isFilled(values[PASSWORD_KEY]);
        return ready ? 'testing' : 'pending';
    }

    const stateOf = (name) => states.get(ux?.systemByName(name)?.systemId)?.state ?? null;

    let loading = false;
    let loadAgain = false;

    async function loadStates() {
        if (loading) {
            loadAgain = true;
            return;
        }
        loading = true;
        try {
            do {
                loadAgain = false;
                await loadStatesOnce();
            } while (loadAgain);
        } finally {
            loading = false;
        }
    }

    async function loadStatesOnce() {
        if (!ux.isConnected()) return;
        const old = ux.systems().filter(s => s.templateIdentifier === POWERSHELL_V2 &&
            Date.now() - (states.get(s.systemId)?.time ?? 0) > STATE_MAX_AGE_MS);
        for (let i = 0; i < old.length; i += LOAD_BATCH) {
            await Promise.all(old.slice(i, i + LOAD_BATCH).map(system => loadState(system.systemId)));
            refresh();
        }
    }

    async function loadState(id) {
        try {
            states.set(id, { state: systemState(await ux.fetchFromGateway(CONFIGURATION_PATH(id))), time: Date.now() });
        } catch (e) {
            console.warn(`[HelloID Entra ID certificates] Could not read system ${id}`, e);
            states.set(id, { state: null, time: Date.now() });
        }
    }

    // =====================================================================
    // Symbols and buttons
    // =====================================================================

    const FLAGS = [
        {
            key: 'certificate-start',
            text: '🔐',
            label: 'systems that still get their token with the client secret',
            titleFor: (system) => (states.get(system?.systemId)?.state !== 'start' ? null
                : 'The scripts get their token with the client secret. Click the 🔐 button to move to a certificate.'),
        },
        {
            key: 'certificate-pending',
            text: '🚧',
            label: 'systems with certificate fields that the scripts don\'t use yet',
            titleFor: (system) => (states.get(system?.systemId)?.state !== 'pending' ? null
                : 'The certificate fields are there, but the scripts don\'t use them yet. Click 🔐 to continue.'),
        },
        {
            key: 'certificate-testing',
            text: '🧪',
            label: 'systems that use the certificate and still have the client secret field',
            titleFor: (system) => (states.get(system?.systemId)?.state !== 'testing' ? null
                : 'The scripts use the certificate; the client secret field is still there. Test the scripts with ' +
                  'dry runs, then click the 🧪 button to remove it.'),
        },
    ];

    const BUTTON_CLASS = 'tm-entra-certificate';
    const BUTTONS = [
        {
            key: 'entra-certificate',
            text: '🔐',
            title: (state) => (state === 'pending'
                ? 'Continue moving this system to a certificate'
                : 'Move this system from the client secret to a certificate'),
            states: ['start', 'pending'],
            run: (name) => moveToCertificate(name),
        },
        {
            key: 'entra-tested',
            text: '🧪',
            title: () => 'The scripts are tested with the certificate: remove the client secret field',
            states: ['testing'],
            run: (name) => removeSecretField(name),
        },
    ];
    const buttonInfo = new WeakMap(); // button -> { kind, getName }

    function updateButton(btn) {
        const { kind, getName } = buttonInfo.get(btn) ?? {};
        if (!kind) return;
        const state = stateOf(getName());
        const display = kind.states.includes(state) ? '' : 'none';
        if (btn.style.display !== display) btn.style.display = display;
        const title = kind.title(state);
        if (btn.title !== title) btn.title = title;
    }

    const refreshButtons = () => document.querySelectorAll(`.${BUTTON_CLASS}`).forEach(updateButton);

    // The symbols and buttons follow the states
    function refresh() {
        ux.refreshSystems();
        refreshButtons();
    }

    // getName is called at click time: HelloID may reuse a tile for another system
    function createButton(kind, getName, className) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `${className} ${BUTTON_CLASS}`;
        btn.textContent = kind.text;
        buttonInfo.set(btn, { kind, getName });
        updateButton(btn);
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            const name = getName();
            try {
                await kind.run(name);
            } catch (err) {
                if (!err?.shown) {
                    console.warn('[HelloID Entra ID certificates]', err);
                    await ux.showDialog(`${kind.text} ${name}`, ux.error(String(err?.message ?? err)));
                }
            } finally {
                btn.disabled = false;
                const id = ux.systemByName(name)?.systemId;
                if (id) await loadState(id);
                refresh();
            }
        });
        return btn;
    }

    // =====================================================================
    // Dialogs
    // =====================================================================

    const formatDate = (date) => date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const validityText = (notBefore, notAfter) =>
        `valid for ${CERTIFICATE_VALIDITY_YEARS} year${CERTIFICATE_VALIDITY_YEARS === 1 ? '' : 's'}, ` +
        `from ${formatDate(notBefore)} until ${formatDate(notAfter)}`;
    const portalUrl = (template, values) => template
        .replace('{tenant}', encodeURIComponent(values[TENANT_KEY]))
        .replace('{appId}', encodeURIComponent(values[APP_ID_KEY]));
    const openTab = (url) => GM_openInTab(url, { active: true, insert: true, setParent: true });
    const safeFileName = (name) => name.replace(/[\\/:*?"<>|]+/g, '_').trim();
    const today = () => new Date().toISOString().slice(0, 10);

    function element(tag, props = {}, ...children) {
        const el = Object.assign(document.createElement(tag), props);
        el.append(...children.filter(c => c !== null && c !== undefined));
        return el;
    }

    // The Organization, and (when needed) where the certificate comes
    // from. Resolves to { organization, own: { base64, password } | null }
    // or null when cancelled.
    // lookup: { domain } as found in Microsoft Graph, or { failed: why }
    async function askDetails(title, { organization, needsCertificate, systemName, problem, lookup, values }) {
        const { notBefore, notAfter } = validityFromNow();
        const organizationInput = element('input', {
            type: 'text', className: 'form-control', value: organization || lookup.domain || '',
            placeholder: ORGANIZATION_FIELD.templateOptions.placeholder,
        });
        // Where the value comes from, and where to look it up
        const domainsLink = element('a', { href: portalUrl(DOMAINS_URL, values), target: '_blank', rel: 'noopener' },
            'Custom domain names');
        const lookupNote = lookup.domain
            ? (isFilled(organization) && organization.toLowerCase() !== lookup.domain.toLowerCase()
                ? element('p', { className: 'text-warning' }, element('strong', {},
                    `The configuration has ${organization}, but the initial domain of the tenant is ${lookup.domain}.`))
                : element('p', { className: 'text-muted' },
                    `${isFilled(organization) ? 'Checked' : 'Filled in'} from Microsoft Entra ID: ${lookup.domain}.`))
            : element('p', { className: 'text-muted' },
                `It could not be looked up (${lookup.failed}). Find it under `, domainsLink,
                ' of the tenant: the domain that ends in .onmicrosoft.com.');
        if (lookup.domain) {
            lookupNote.append(' Also under ', domainsLink, ' of the tenant.');
        }
        const generate = element('input', { type: 'radio', name: 'tm-certificate-source', checked: true });
        const own = element('input', { type: 'radio', name: 'tm-certificate-source' });
        const base64Input = element('textarea', { className: 'form-control', rows: 3, placeholder: 'MIIK...' });
        const passwordInput = element('input', { type: 'password', className: 'form-control' });
        const ownFields = element('div', { style: 'display: none; margin: 4px 0 0 20px' },
            element('label', {}, 'Base 64 string of the .pfx (with its private key)'), base64Input,
            element('label', { style: 'margin-top: 6px' }, 'Password of the .pfx'), passwordInput);
        [generate, own].forEach(radio => radio.addEventListener('change', () => {
            ownFields.style.display = own.checked ? '' : 'none';
        }));

        const content = element('div', {},
            problem ? element('p', { className: 'text-danger' }, element('strong', {}, problem)) : null,
            element('label', {}, ORGANIZATION_FIELD.templateOptions.label),
            organizationInput,
            element('small', { className: 'text-muted' }, ORGANIZATION_FIELD.templateOptions.description),
            lookupNote,
            needsCertificate ? element('div', { style: 'margin-top: 12px' },
                element('label', {}, 'Certificate'),
                element('div', {}, element('label', { style: 'font-weight: normal' }, generate,
                    ` Make a new certificate: CN=${certificateName(systemName)}, ` +
                    `${validityText(notBefore, notAfter)}`)),
                element('div', {}, element('label', { style: 'font-weight: normal' }, own,
                    ' Use a certificate I made myself (for example with GenCert.ps1)')),
                ownFields) : null);
        const text = 'Organization: the primary .onmicrosoft.com domain of the organization' +
                     (lookup.domain ? ` (in Microsoft Entra ID: ${lookup.domain}).` : '.') +
                     `\nCustom domain names: ${portalUrl(DOMAINS_URL, values)}` +
                     (needsCertificate ? '\nCertificate: make a new one, or use one you made yourself.' : '');
        if (!await ux.showDialog(title, text, { content, confirm: true })) return null;
        return {
            organization: organizationInput.value.trim(),
            own: needsCertificate && own.checked
                ? { base64: base64Input.value.trim(), password: passwordInput.value }
                : null,
        };
    }

    // The new certificate: what it is, and its password (with a copy button)
    async function showCertificate(title, certificate, files) {
        const copy = element('button', { type: 'button', className: 'btn btn-default btn-xs' }, 'Copy');
        copy.addEventListener('click', async () => {
            copy.textContent = await ux.copyToClipboard(certificate.password) ? 'Copied' : 'Copy failed';
            setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        });
        const facts = [
            `Name: CN=${certificate.name}`,
            `Validity: ${validityText(certificate.notBefore, certificate.notAfter)}`,
            `Thumbprint: ${certificate.thumbprint}`,
            files.length ? `Saved in your downloads: ${files.join(', ')}` : null,
            'The certificate and its password are stored in the configuration of the system.',
        ].filter(Boolean);
        const content = element('div', {},
            element('pre', {}, facts.join('\n')),
            element('p', {}, 'Password of the .pfx file (keep it with the file, e.g. in your password manager):'),
            element('div', { style: 'display: flex; gap: 6px; align-items: center' },
                element('code', { style: 'user-select: all' }, certificate.password), copy));
        await ux.showDialog(title, facts.join('\n'), { content });
    }

    // =====================================================================
    // 🔐 Move to the certificate
    // =====================================================================

    async function readSystem(name) {
        const system = ux.systemByName(name);
        if (!system?.systemId) throw new Error(`"${name}" was not found in HelloID's list of target systems.`);
        const configuration = await ux.fetchFromGateway(CONFIGURATION_PATH(system.systemId));
        let resources = [];
        let resourcesRead = true;
        try {
            const read = await ux.fetchFromGateway(RESOURCES_PATH(system.systemId));
            resources = Array.isArray(read) ? read : [];
        } catch (e) {
            console.warn(`[HelloID Entra ID certificates] Could not read the resources of "${name}"`, e);
            resourcesRead = false;
        }
        return { system, configuration, resources, resourcesRead };
    }

    // Everything that would stop the move halfway: found before any change
    function problemsOf({ system, configuration }, converted) {
        const fields = configuration.scriptConfigurationForm?.fields ?? [];
        const values = configuration.scriptConfiguration ?? {};
        const problems = [];
        if (system.templateIdentifier !== POWERSHELL_V2) {
            problems.push(`It is of type "${system.templateIdentifier}": only PowerShell v2 systems ` +
                          `("${POWERSHELL_V2}") are moved.`);
        }
        [TENANT_KEY, APP_ID_KEY, SECRET_KEY].forEach(key => {
            if (fieldIndex(fields, key) < 0) problems.push(`Its configuration has no field "${key}".`);
        });
        [TENANT_KEY, APP_ID_KEY].forEach(key => {
            if (!isFilled(values[key])) problems.push(`"${key}" is empty in its configuration.`);
        });
        // Every change sends the values along: without the secret, it
        // would be emptied
        if (!isFilled(values[SECRET_KEY]) || /^\*+$/.test(values[SECRET_KEY])) {
            problems.push(`HelloID did not return the value of "${SECRET_KEY}", so a change would empty it.`);
        }
        return [...problems, ...converted.problems];
    }

    const accountScripts = (configuration) => Object.fromEntries(Object.entries(configuration.scripts ?? {})
        .filter(([key]) => key.startsWith('account')));

    // The account scripts, the configuration form and the values go in
    // one request (as HelloID's own page sends them)
    const saveAccount = (id, configuration, form, values) =>
        ux.sendToGateway(`${CONFIGURATION_PATH(id)}/account`, 'POST', {
            scripts: accountScripts(configuration),
            scriptConfigurationForm: form,
            scriptConfiguration: values,
        });

    async function backup(title, name) {
        const progress = ux.showProgress(title, ['Backup of the system (in your downloads)']);
        progress.set(0, 'busy');
        try {
            await ux.downloadBackup(name, 'backup before certificate');
            progress.set(0, 'done');
            progress.close();
        } catch (e) {
            progress.failBusy();
            await progress.finish(ux.error(`The backup failed, so nothing was changed: ${e?.message ?? e}`));
            throw Object.assign(new Error(String(e?.message ?? e)), { shown: true });
        }
    }

    async function moveToCertificate(name) {
        const title = `🔐 ${name}`;
        let read = await readSystem(name);
        const values = read.configuration.scriptConfiguration ?? {};
        const fields = read.configuration.scriptConfigurationForm?.fields ?? [];
        const converted = convertScripts(read.configuration, read.resources);
        const problems = problemsOf(read, converted);
        if (problems.length) {
            await ux.showDialog(title, ux.error('This system cannot be moved to a certificate, so nothing was ' +
                                                'changed:\n\n') + problems.map(p => `- ${p}`).join('\n'));
            return;
        }

        const hasFields = [ORGANIZATION_KEY, CERTIFICATE_KEY, PASSWORD_KEY].every(key => fieldIndex(fields, key) >= 0);
        const hasCertificate = isFilled(values[CERTIFICATE_KEY]) && isFilled(values[PASSWORD_KEY]);
        const needsDetails = !hasFields || !hasCertificate || !isFilled(values[ORGANIZATION_KEY]);
        const { notBefore, notAfter } = validityFromNow();
        const done = (isDone) => (isDone ? ' (done)' : '');
        const scriptList = converted.changed.map(s => `     - ${s.label}`).join('\n');
        const intro = [
            `Moves "${name}" from the client secret to a certificate:`,
            '',
            '1. A backup of the system is saved in your downloads',
            `2. The fields Organization, ${CERTIFICATE_FIELDS.map(f => f.templateOptions.label).join(' and ')} ` +
            `are added to the configuration; the client secret stays for now. Organization is looked up in ` +
            `Microsoft Entra ID (the tenant's .onmicrosoft.com domain)${done(hasFields)}`,
            `3. A certificate is made: CN=${certificateName(name)}, ${validityText(notBefore, notAfter)}. ` +
            'The .cer and .pfx files are saved in your downloads; the certificate and its password are ' +
            `stored in the configuration${done(hasCertificate)}`,
            `4. You activate the PIM role "${PIM_ROLE}" in Azure`,
            `5. You upload the .cer file to the app registration ${values[APP_ID_KEY]}`,
            '6. The certificate is tested: Microsoft has to give a token with it',
            converted.changed.length
                ? `7. The ${converted.changed.length} scripts that use the client secret are changed to use the certificate:\n${scriptList}`
                : '7. The scripts already use the certificate (done)',
            '',
            'You can stop after any step and continue later with 🔐 (the system then shows 🚧).',
            read.resourcesRead ? '' : ux.warn('\nThe resources of this system could not be read, so their scripts ' +
                                              'are not checked or changed.'),
        ].join('\n');
        if (!await ux.showDialog(title, intro, { confirm: true, confirmLabel: 'Start' })) return;

        await backup(title, name);

        // 2 and 3: the fields, the Organization and the certificate
        let certificate = null;
        if (needsDetails) {
            const lookup = await lookUpDomain(title, values);
            let problem = '';
            let details;
            let files = [];
            for (;;) {
                details = await askDetails(title, {
                    organization: values[ORGANIZATION_KEY],
                    needsCertificate: !hasCertificate,
                    systemName: name,
                    problem,
                    lookup,
                    values,
                });
                if (!details) return;
                if (!ORGANIZATION_FORMAT.test(details.organization)) {
                    problem = 'Organization has to be the primary .onmicrosoft.com domain, like contoso.onmicrosoft.com.';
                    continue;
                }
                if (details.own) {
                    try {
                        certificate = { ...readCertificate(details.own.base64, details.own.password), ...details.own };
                        certificate.pfxBase64 = details.own.base64.replace(/\s+/g, '');
                    } catch (e) {
                        problem = String(e?.message ?? e);
                        continue;
                    }
                }
                break;
            }
            if (!hasCertificate && !details.own) {
                certificate = await createCertificate(name);
                const base = `${safeFileName(certificate.name)} - ${today()}`;
                files = [`${base}.cer`, `${base}.pfx`];
                ux.downloadFile(certificate.cer, files[0], 'application/pkix-cert');
                ux.downloadFile(certificate.pfx, files[1], 'application/x-pkcs12');
            }

            const newValues = { ...values, [ORGANIZATION_KEY]: details.organization };
            if (certificate) {
                newValues[CERTIFICATE_KEY] = certificate.pfxBase64;
                newValues[PASSWORD_KEY] = certificate.password;
            }
            await saveValues(title, read.system.systemId, read.configuration, newValues);
            if (certificate && files.length) await showCertificate(title, certificate, files);
            read = await readSystem(name);
        }

        const saved = read.configuration.scriptConfiguration ?? {};
        certificate = readCertificate(saved[CERTIFICATE_KEY], saved[PASSWORD_KEY]);

        // 4 to 6: when continuing, the certificate may be in Azure already
        let roles = hasCertificate ? await tryToken(title, certificate, saved, true) : null;
        if (!roles) {
            roles = await uploadAndTest(title, certificate, saved);
            if (!roles) return;
        }

        // 7: the scripts
        await changeScripts(title, name, roles);
    }

    // The initial .onmicrosoft.com domain, for Organization: { domain }
    // or { failed: why }. With the client secret, which the system still
    // has at this point.
    async function lookUpDomain(title, values) {
        const progress = ux.showProgress(title, ['Look up the .onmicrosoft.com domain in Microsoft Entra ID']);
        progress.set(0, 'busy');
        try {
            const domain = await initialDomain(values[SECRET_KEY], values[TENANT_KEY], values[APP_ID_KEY]);
            progress.set(0, 'done');
            return { domain };
        } catch (e) {
            console.warn('[HelloID Entra ID certificates] Could not look up the initial domain', e);
            progress.set(0, 'failed');
            return { failed: String(e?.message ?? e) };
        } finally {
            progress.close();
        }
    }

    // Stores the fields and values, and checks that HelloID has them
    async function saveValues(title, id, configuration, newValues) {
        const progress = ux.showProgress(title, ['Add the fields and store the values', 'Check the configuration']);
        try {
            progress.set(0, 'busy');
            await saveAccount(id, configuration, withCertificateFields(configuration.scriptConfigurationForm), newValues);
            progress.set(0, 'done');
            progress.set(1, 'busy');
            let check = (await ux.fetchFromGateway(CONFIGURATION_PATH(id))).scriptConfiguration ?? {};
            const differs = () => [ORGANIZATION_KEY, CERTIFICATE_KEY, PASSWORD_KEY, SECRET_KEY]
                .filter(key => key in newValues && check[key] !== newValues[key]);
            if (differs().length) {
                // The values on their own, as the configuration tab sends them
                await ux.sendToGateway(`${CONFIGURATION_PATH(id)}/script-configuration`, 'POST',
                    { scriptConfiguration: newValues });
                check = (await ux.fetchFromGateway(CONFIGURATION_PATH(id))).scriptConfiguration ?? {};
            }
            if (differs().length) throw new Error(`HelloID does not have the new values of: ${differs().join(', ')}.`);
            progress.set(1, 'done');
            progress.close();
        } catch (e) {
            progress.failBusy();
            await progress.finish(ux.error(`Stopped: ${e?.message ?? e}\n\nThe backup in your downloads has the ` +
                                           'system as it was.'));
            throw Object.assign(new Error(String(e?.message ?? e)), { shown: true });
        }
    }

    // The application permissions in the token, or null. quiet: no
    // message when it fails (when trying whether Azure already has it).
    async function tryToken(title, certificate, values, quiet = false) {
        const progress = ux.showProgress(title, ['Get a token from Microsoft with the certificate']);
        progress.set(0, 'busy');
        try {
            const roles = await requestToken(certificate, values[TENANT_KEY], values[APP_ID_KEY]);
            progress.set(0, 'done');
            progress.close();
            return roles;
        } catch (e) {
            progress.set(0, 'failed');
            if (quiet) {
                progress.close();
                return null;
            }
            progress.close();
            return { failed: String(e?.message ?? e) };
        }
    }

    async function uploadAndTest(title, certificate, values) {
        const pim = await ux.showDialog(title, [
            `Activate the PIM role "${PIM_ROLE}" in Azure: you need it to upload the certificate to the app ` +
            'registration.',
            '',
            'Open PIM opens My roles of Privileged Identity Management in a new tab, for tenant ' +
            `${values[TENANT_KEY]}.`,
        ].join('\n'), { confirm: true, confirmLabel: 'Open PIM', alternative: 'I have the role already' });
        if (!pim) return null;
        if (pim === true) {
            openTab(portalUrl(PIM_URL, values));
            if (!await ux.showDialog(title, `Is the role "${PIM_ROLE}" active? The next step is uploading the ` +
                                            'certificate to the app registration in Azure.',
            { confirm: true, confirmLabel: 'Open the app registration' })) return null;
        }

        const upload = () => openTab(portalUrl(CREDENTIALS_URL, values));
        upload();
        const uploadText = [
            `Upload the certificate to the app registration ${values[APP_ID_KEY]} (opened in a new tab):`,
            '',
            '1. Certificates & secrets > Certificates > Upload certificate',
            `2. Pick the .cer file of "${certificate.name}" in your downloads`,
            `3. Description: ${certificate.name}`,
            '4. Add',
            '',
            `Azure then shows the thumbprint ${certificate.thumbprint}.`,
        ].join('\n');
        if (!await ux.showDialog(title, uploadText, { confirm: true, confirmLabel: 'Test the certificate' })) return null;

        for (;;) {
            const roles = await tryToken(title, certificate, values);
            if (Array.isArray(roles)) return roles;
            const again = await ux.showDialog(title, ux.error(`Microsoft did not give a token with the certificate: ` +
                                                              `${roles.failed}`) +
                '\n\nIf you just uploaded it, Azure may need a minute. Check that the thumbprint in Azure is ' +
                `${certificate.thumbprint}.`,
            { confirm: true, confirmLabel: 'Try again', alternative: 'Open the app registration' });
            if (!again) return null;
            if (again === 'alternative') upload();
        }
    }

    async function changeScripts(title, name, roles) {
        const steps = ['Read the system', 'Account scripts', 'Permission scripts', 'Resource scripts', 'Check the result'];
        const progress = ux.showProgress(title, steps);
        const step = (index, state, detail) => progress.set(index, state, detail);
        let changed = [];
        try {
            step(0, 'busy');
            const read = await readSystem(name);
            const id = read.system.systemId;
            const converted = convertScripts(read.configuration, read.resources);
            const problems = problemsOf(read, converted);
            if (problems.length) throw new Error(`The scripts were not changed:\n${problems.join('\n')}`);
            changed = converted.changed;
            step(0, 'done');

            const parts = (part) => changed.filter(s => s.part === part);
            step(1, 'busy');
            if (parts('account').length) {
                await saveAccount(id, converted.configuration, read.configuration.scriptConfigurationForm,
                    read.configuration.scriptConfiguration);
                step(1, 'done', String(parts('account').length));
            } else step(1, 'skipped');

            step(2, 'busy');
            if (parts('permissions').length) {
                await ux.sendToGateway(`${CONFIGURATION_PATH(id)}/permissions`, 'POST',
                    { permissions: converted.configuration.permissions });
                step(2, 'done', String(parts('permissions').length));
            } else step(2, 'skipped');

            step(3, 'busy');
            if (parts('resources').length) {
                await ux.sendToGateway(RESOURCES_PATH(id), 'POST', converted.resources);
                step(3, 'done', String(parts('resources').length));
            } else step(3, 'skipped');

            step(4, 'busy');
            const check = await readSystem(name);
            const left = scriptsOf(check.configuration, check.resources)
                .filter(s => USES_SECRET.test(s.owner[s.key])).map(s => s.label);
            if (left.length) throw new Error(`These scripts still use the client secret: ${left.join(', ')}`);
            if (systemState(check.configuration) !== 'testing') throw new Error('The system is not as expected afterwards.');
            step(4, 'done');
        } catch (e) {
            progress.failBusy();
            await progress.finish(ux.error(`Stopped: ${e?.message ?? e}`) + '\n\nWhat was done stays. Click 🔐 to ' +
                'continue, or restore the backup in your downloads with the Import button.');
            throw Object.assign(new Error(String(e?.message ?? e)), { shown: true });
        }
        await progress.finish([
            `"${name}" now gets its token with the certificate. Changed:`,
            ...changed.map(s => `- ${s.label}`),
            '',
            roles.length ? `The token has these application permissions: ${roles.join(', ')}` : '',
            '',
            ux.strong('Next: test each of the changed scripts with a dry run. Then click 🧪 to remove the client ' +
                      'secret field.'),
        ].join('\n'));
    }

    // =====================================================================
    // 🧪 Remove the client secret
    // =====================================================================

    async function removeSecretField(name) {
        const title = `🧪 ${name}`;
        const read = await readSystem(name);
        const values = read.configuration.scriptConfiguration ?? {};
        // The secret stays as long as anything still uses it
        const users = scriptsOf(read.configuration, read.resources)
            .filter(s => USES_SECRET.test(s.owner[s.key])).map(s => `- ${s.label}`);
        const problems = [
            ...users.length ? [`These scripts still use the client secret:\n${users.join('\n')}`] : [],
            ...!isFilled(values[CERTIFICATE_KEY]) || !isFilled(values[PASSWORD_KEY])
                ? ['The certificate or its password is empty in the configuration.'] : [],
            ...!read.resourcesRead ? ['The resources could not be read, so it is not known whether they use it.'] : [],
        ];
        if (problems.length) {
            await ux.showDialog(title, ux.error('The client secret field was not removed:\n\n') + problems.join('\n\n'));
            return;
        }

        await backup(title, name);
        if (!await ux.showDialog(title, [
            `Have you tested the scripts of "${name}" with dry runs, and do they get their token with the certificate?`,
            '',
            `Yes removes the field "${SECRET_KEY}" and its value from the configuration.`,
        ].join('\n'), { confirm: true, confirmLabel: 'Yes, remove the client secret' })) return;

        const id = read.system.systemId;
        const form = clone(read.configuration.scriptConfigurationForm);
        form.fields = form.fields.filter(f => String(f?.key).toLowerCase() !== SECRET_KEY.toLowerCase());
        const rest = { ...values };
        delete rest[SECRET_KEY];
        const progress = ux.showProgress(title, ['Remove the client secret field', 'Check the configuration']);
        try {
            progress.set(0, 'busy');
            await saveAccount(id, read.configuration, form, rest);
            progress.set(0, 'done');
            progress.set(1, 'busy');
            let check = await ux.fetchFromGateway(CONFIGURATION_PATH(id));
            if (fieldIndex(check.scriptConfigurationForm?.fields ?? [], SECRET_KEY) >= 0) {
                throw new Error('HelloID still has the field.');
            }
            // HelloID may keep the value of a field that is gone: empty it
            if (isFilled(check.scriptConfiguration?.[SECRET_KEY])) {
                await ux.sendToGateway(`${CONFIGURATION_PATH(id)}/script-configuration`, 'POST',
                    { scriptConfiguration: { ...rest, [SECRET_KEY]: '' } });
                check = await ux.fetchFromGateway(CONFIGURATION_PATH(id));
                if (isFilled(check.scriptConfiguration?.[SECRET_KEY])) throw new Error('HelloID still has the value.');
            }
            progress.set(1, 'done');
            progress.close();
        } catch (e) {
            progress.failBusy();
            await progress.finish(ux.error(`Stopped: ${e?.message ?? e}`));
            throw Object.assign(new Error(String(e?.message ?? e)), { shown: true });
        }

        if (await ux.showDialog(title, [
            `The client secret field is removed from "${name}".`,
            '',
            `Delete the client secret in the app registration ${values[APP_ID_KEY]} as well, once no other system ` +
            `uses it (that needs the PIM role "${PIM_ROLE}").`,
        ].join('\n'), { confirm: true, confirmLabel: 'Open the app registration' })) {
            openTab(portalUrl(CREDENTIALS_URL, values));
        }
    }

    // =====================================================================
    // Start
    // =====================================================================

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const API_VERSION = 1;

    function start(api) {
        if (ux || !api) return;
        if (api.version !== API_VERSION) {
            console.warn('[HelloID Entra ID certificates] This version of "HelloID UX improvements" is not supported.');
            return;
        }
        ux = api;
        FLAGS.forEach(flag => ux.registerSystemFlag(flag));
        BUTTONS.forEach(kind => ux.registerSystemButton({
            key: kind.key,
            create: (getName, className) => createButton(kind, getName, className),
            refresh: refreshButtons,
        }));
        ux.onSystems(loadStates);
        loadStates();
    }

    if (pageWindow.HelloIDUX) start(pageWindow.HelloIDUX);
    else pageWindow.addEventListener('helloid-ux-ready', () => start(pageWindow.HelloIDUX), { once: true });
})();
