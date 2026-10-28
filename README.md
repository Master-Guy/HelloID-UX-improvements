# HelloID UX improvements

A userscript that adds a few quality-of-life improvements to the HelloID provisioning interface.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
1. Open the Tampermonkey browser extension and enable "Allow User Scripts" ([Chrome](chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo), [Edge](edge://extensions/?id=iikmkjmpaadaobahmlepeloendndfphd))
1. Open the install link below. Tampermonkey will show an install page; click **Install**.

**[Install HelloID UX improvements](https://raw.githubusercontent.com/Master-Guy/HelloID-UX-improvements/refs/heads/main/HelloID-UX-improvements.user.js)**

Updates are picked up automatically by Tampermonkey.

## Features

### Entitlement filters on target systems

On the **Entitlements** tab of a target system, three filter buttons are added next to the rule search bar: account, account access and permissions. Click a button to cycle it through three states:

| Color | Meaning |
|-------|---------|
| Grey  | No filter |
| Black | Only show rules **with** this entitlement |
| Red   | Only show rules **without** this entitlement |

The filters can be combined. The page reloads shortly after your last click to apply them, and your filter choices are remembered for next time.

### Copy system names

On the **Target systems** overview, each system tile gets a copy button next to the configure button. Clicking it copies the system name to your clipboard.

### Copy rule names

On the **Business rules** overview, each rule name gets a copy button on the right side of the cell. Clicking it copies the rule name to your clipboard.

### Export a target system

On the **Target systems** overview, each system has an export button (download icon). It saves one JSON file, named `<system name> - <system ID> - <date>.json`, with:

- the configuration of the system: scripts, permission sets, mapping, correlation, thresholds, resources and settings. Built-in Active Directory and Azure AD systems are exported with their own settings as well;
- the agent selection (tags and agent pools) for on-premises execution;
- the notifications of the system, and the notification systems they use;
- the business rules that have an entitlement for the system, with their conditions and the entitlements they grant in it;
- the other target systems that depend on this one, or that use its accounts (`Person.Accounts._<system ID>`) in a mapping or a script.

Secrets are replaced by `***` unless the setting **Target system export: include secrets** is on. The file always lists which values are secrets and whether they have a value.

A card shows the progress while the file is collected.

### Export the granted entitlements

The second export button (checklist icon) saves what the persons currently have in the system: per person the account, account access and permissions. Use it to compare a system before and after a change, or against the system that replaces it.

### Export for the migration to PowerShell v2

PowerShell v1 systems have a third export button (magic wand icon). HelloID's own migration to PowerShell v2 leaves the scripts and the mapping to be converted by hand; this button prepares that work for a Claude agent. It saves three files:

- the export of the system, the same as the normal export;
- `HelloID PowerShell v2 migration - handoff for Claude - <version>.md`, which tells the agent how to convert the scripts and the mapping, and what to answer with. It has the agent write the scripts like the supplier's own PowerShell v2 scripts (Tools4ever's connectors on GitHub; for Microsoft Entra ID it names them), with their naming and functions, while the system keeps doing what it did and keeps its own settings. It is the same for every system, so one copy is enough for any number of exports;
- `HelloID-Migration-Tool-<version>.ps1`, which the agent uses to take the scripts out of an export, put the converted ones into an import file, and check that file. It needs PowerShell 7.2 or later, and is also the same for every system.

<version> is the version of this script, which is also at the top of both files, so you can tell whether you have the newest ones. They are downloaded once per visit of the Target Systems page: exporting more systems in a row saves only their exports. Go to another page and back to get them again.

Give the exports, the handoff and the tool to a Claude agent. It answers with one file per system for the import button, and with what it wasn't sure of.

Then import the file of the agent. When the system is still a PowerShell v1 system, the import asks whether to start HelloID's migration of it, with the same warning as HelloID's own button: it can't be undone, and the system is disabled until the migration is completed. A backup of the v1 configuration is downloaded before it starts. After the import, test the scripts before you enable the system. Make the export before the migration is started: that also keeps the time the system is disabled short.

Importing the file of the agent overwrites the scripts and the mapping of the existing system, found by the system ID in the file; such a file never makes a new system. After the import, the tasks of HelloID's migration checklist are ticked off for what the file converts: the agent says so in the file, the scripts in the file have no PowerShell v1 variables left, and HelloID has them as they are in the file. What is left open is listed. When no task is left open and every request of the import succeeded, the import completes the migration, which can't be undone, and then disables the system, also when it was enabled before: nothing runs until you have tested the scripts and enabled it yourself. When a task is left open, the migration stays open for you to finish in HelloID.

The button is only shown for PowerShell v1 systems (type `powershell-onpremise`). Once the migration of a system is started it is a PowerShell v2 system (`powershell-target`), so make the export before you start the migration.

### Import a target system

The import button (upload icon, next to **Add new system**) reads an exported file. It works for PowerShell and Active Directory systems.

- **The system of the file exists:** you choose whether to overwrite it or to import the file as a new system (with a name of its own), and which parts and links to import. The differences are then listed, and written after you confirm. A backup of the current configuration is downloaded first.
- **The system of the file doesn't exist:** you choose the name of the new system and what to import, and a new system is created with it. A new system always starts **disabled**.

Every import (target systems, notifications, notification systems, source systems) starts with this step: new or overwrite, which parts of the file, and which links to other things (depends-on systems, agents, notifications, business rules, the data of target systems in notifications). When there is a choice between overwrite and new, that comes first; **Next** then shows the parts and links to overwrite. Importing as a new system skips that page and asks for the parts of the new system instead.

A part you leave out keeps what the system has: a new system keeps what HelloID gave it, and an existing one keeps its own. This also holds when another part's request carries it along (the account scripts of a PowerShell system are saved together with the configuration values, for example). When the configuration form is imported without its values, a field that has no value gets the form's default. Correlation and the uniqueness check that you leave out are set again on the fields of the same name when the mapping is replaced. A new system always gets its general settings, which hold its name and keep it disabled.

Besides the configuration, the import sets the agent selection, creates or updates the notifications, and links the business rules:

- Business rules are only ever saved as a **draft**. Publish them yourself in HelloID, which shows what publishing would do.
- Entitlements are added next to what a rule already has. Entitlements that a rule has for the system but the file doesn't are only taken out when you choose so.
- Permissions can only be linked once HelloID has retrieved them from the system. The import asks HelloID to do so and waits for them. A new system that was imported without its secrets can't retrieve anything yet: set the secrets and import the same file again.

Secrets that were left out of the file keep the value the system already has; in a new system they are empty.

### Export and import notifications

**Notification Configurations** has an export button in each row (next to the copy button), and **Export all** and **Import** next to HelloID's **+**. **Notification Systems** has an export button on each tile, and **Import** next to the **+**.

The files work like those of target systems. A notification is saved with the names of the target systems, the notification system and the template it uses, so the import finds them again in another environment, by ID or else by name (the built-in Email system: the built-in one there). The import:

- goes to the notification it was exported from, or else the one with the same event and name; otherwise it makes a new one, which starts **disabled**;
- leaves out the data of target systems the environment doesn't have, and says so;
- shows what will be new and what will be overwritten, downloads a backup of what it overwrites, and writes after you confirm.

A notification system goes to the one it was exported from, or the one with the same name, or else a new (PowerShell) one is made. Its name, description, icon, on-premises setting, agents, configuration form and values, scripts and templates are imported. Scripts and templates are matched by ID or else by name; the system's own scripts and templates that the file doesn't have stay. Passwords in the configuration and in template values are written as `***` (see the setting **Target system export: include secrets**), and keep the value they have when imported.

### Export and import source systems

On **Source systems**, each tile has an export button and a template button (info icon), and **Import** is next to HelloID's **+**.

- **Export:** the system's general settings, configuration form and values, scripts, person and contract mappings, thresholds, agents, and the catalog template it was made from. Secrets are written as `***` unless the setting **Target system export: include secrets** is on.
- **Template:** shows which catalog template the system was made from, its release, and whether the catalog has a newer one. HelloID sets this when the system is made, and it can't be changed afterwards.
- **Import:** goes to the system it was exported from, or the one with the same name; you can also import the file as a new system. HelloID only makes a source system from a catalog template. The import uses the latest release of the file's template, found by name; if that fails, the catalog ID in the file; and otherwise the latest **Source Template**. The parts of the file then replace what the template brought.

### Clone business rules in a new tab

The Clone button of a business rule is a link: Ctrl+click or the middle mouse button makes the copy in a new tab, and opens it there.

### Show what is typed in password fields

Every password field gets an eye button on its right edge. Click it to see what you typed, and click it again to hide it.

### Create a target system from GitHub

The GitHub button (next to the import button) lists Tools4ever's target connectors on GitHub (repositories `HelloID-Conn-Prov-Target-*`, without archived ones), like HelloID's own **Create System** for source systems. Pick one to see its README, its latest release and which files it has. **Create** then shows what will be made, where you choose:

- the name of the new system;
- which file goes to which part: each account script, the configuration form, the field mapping and the uniqueness check has a dropdown with the repository's `.ps1`, `.psm1` and `.json` files. They start at what was found by name, so you only change what doesn't fit;
- a variant, when the repository has one in a folder of its own (e.g. `correlateOnly`, `guestInvite`). It fills in the dropdowns again, optionally with what the variant doesn't have from the main connector (its README says which);
- the permission sets: one per folder with permission scripts, each with its name, its kind (a script per action, or one script for all actions with subpermissions) and a dropdown per script. A folder with both separate grant/revoke scripts and a `subPermissions.ps1` gives two sets, of which the dynamic one starts unticked. **Add permission set** adds one the matching didn't find.

The files that are left are listed as you go; those the matching found no part for are marked **not recognized**. Before anything is created, the chosen JSON files are checked (the form must be a list of fields, the mapping a HelloID mapping export), as are the permission sets (a name of their own, and a grant or revoke script, or a script for all actions).

The new system is created **disabled**, through the import, with the account scripts, the configuration form (with its defaults), the field mapping, the uniqueness check script, the permission sets, and the repository's icon. Correlation, thresholds and the values of the configuration are up to you. Resources aren't imported yet: they, and any other files the repository has (support scripts, examples, notification templates), are listed, both before you create and in the closing message.

GitHub allows 60 requests an hour without a token, and a connector takes 2. For more, set a GitHub token (one without any scopes is enough) in the Tampermonkey menu: **GitHub: token**. It is only sent to `api.github.com`, and the menu never shows it.

### Microsoft Entra ID: from a client secret to a certificate

A second script, which needs this one, moves PowerShell v2 systems for Microsoft Entra ID (Tools4ever's connector) from a client secret to a certificate:

**[Install HelloID Entra ID certificates](https://raw.githubusercontent.com/Master-Guy/HelloID-UX-improvements/refs/heads/main/HelloID-Entra-certificates.user.js)**

- **🔐** (on systems whose scripts get their token with the client secret): checks first that every step can be done, then saves a backup and adds the fields Organization, App Registration Certificate Base 64 String and App Registration Certificate Password. Organization is filled in with the tenant's initial `.onmicrosoft.com` domain, looked up in Microsoft Graph with the client secret (this needs `Directory.Read.All` or `Organization.Read.All`). If that fails, the dialog links to the tenant's **Custom domain names** page instead. Next it makes a certificate in the browser (valid for 1 year) and saves the `.cer` and `.pfx` files in your downloads. You can also use a certificate you made yourself. The certificate and its password are stored in the system. It then opens PIM, so you can activate the role Application Administrator, and the app registration, so you can upload the `.cer`. It tests the certificate by getting a token from Microsoft, and only then changes the scripts that use the client secret. The client secret itself stays for now.
- **🚧**: the system has the certificate fields, but its scripts don't use them yet. Click 🔐 to continue where it stopped.
- **🧪**: the scripts use the certificate, and the client secret field is still there. Test the scripts with dry runs, then click the 🧪 button: after a backup and your confirmation, it removes the client secret field and its value.

🔐, 🚧 and 🧪 are also shown next to the system's name, with filter buttons in the list, like 🏁.

### Export without a browser (PowerShell)

`Export-HelloIDTargetSystems.ps1` makes the same files as the Export button, for automation. It needs PowerShell 7.5 or later. It logs in with a local admin account through `/authentication/admlogin`, which must not have MFA, and uses the portal's own Bearer token. Then it exports all target systems, or only the ones you name:

```powershell
./Export-HelloIDTargetSystems.ps1 -Domain customer.helloid.com -OutputFolder D:\Exports
./Export-HelloIDTargetSystems.ps1 -Domain customer.helloid.com -SystemName 'Microsoft Entra ID' -Credential $credential
```

Secrets are written as `***`, unless you add `-IncludeSecrets`. The script finds HelloID's provisioning API server itself; if that fails, give it with `-GatewayUrl`. It lists each file it wrote, and ends with exit code 1 when a system could not be exported.

### Settings

Settings can be changed from the Tampermonkey toolbar menu while on a HelloID page. Each setting has its own menu entry showing its current value; leave a value empty to use the default. **Reset all settings to defaults** restores everything at once. Your settings are kept when the script updates.
