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
- `HelloID PowerShell v2 migration - handoff for Claude.md`, which tells the agent how to convert the scripts and the mapping, and what to answer with. It has the agent write the scripts like the supplier's own PowerShell v2 scripts (Tools4ever's connectors on GitHub; for Microsoft Entra ID it names them), with their naming and functions, while the system keeps doing what it did and keeps its own settings. It is the same for every system, so one copy is enough for any number of exports;
- `HelloID-Migration-Tool.ps1`, which the agent uses to take the scripts out of an export, put the converted ones into an import file, and check that file. It needs PowerShell 7.2 or later, and is also the same for every system.

Give the exports, the handoff and the tool to a Claude agent. It answers with one file per system for the import button, and with what it wasn't sure of.

Then import the file of the agent. When the system is still a PowerShell v1 system, the import asks whether to start HelloID's migration of it, with the same warning as HelloID's own button: it can't be undone, and the system is disabled until the migration is completed. A backup of the v1 configuration is downloaded before it starts. After the import, test the scripts before you enable the system. Make the export before the migration is started: that also keeps the time the system is disabled short.

Importing the file of the agent overwrites the scripts and the mapping of the existing system, found by the system ID in the file; such a file never makes a new system. After the import, the tasks of HelloID's migration checklist are ticked off for what the file converts: the agent says so in the file, the scripts in the file have no PowerShell v1 variables left, and HelloID has them as they are in the file. What is left open is listed. When no task is left open and every request of the import succeeded, the import completes the migration, which can't be undone, and then disables the system, also when it was enabled before: nothing runs until you have tested the scripts and enabled it yourself. When a task is left open, the migration stays open for you to finish in HelloID.

The button is only shown for PowerShell v1 systems (type `powershell-onpremise`). Once the migration of a system is started it is a PowerShell v2 system (`powershell-target`), so make the export before you start the migration.

### Import a target system

The import button (upload icon, next to **Add new system**) reads an exported file. It works for PowerShell and Active Directory systems.

- **The system of the file exists:** the differences are listed, and written after you confirm. A backup of the current configuration is downloaded first.
- **The system of the file doesn't exist:** a new system is created (after you confirm) and the file is imported into it. A new system always starts **disabled**. This is also how you copy a system: change the `systemId` and the name in the file.

Besides the configuration, the import sets the agent selection, creates or updates the notifications, and links the business rules:

- Business rules are only ever saved as a **draft**. Publish them yourself in HelloID, which shows what publishing would do.
- Entitlements are added next to what a rule already has. Entitlements that a rule has for the system but the file doesn't are only taken out when you choose so.
- Permissions can only be linked once HelloID has retrieved them from the system. The import asks HelloID to do so and waits for them. A new system that was imported without its secrets can't retrieve anything yet: set the secrets and import the same file again.

Secrets that were left out of the file keep the value the system already has; in a new system they are empty.

### Settings

Settings can be changed from the Tampermonkey toolbar menu while on a HelloID page. Each setting has its own menu entry showing its current value; leave a value empty to use the default. **Reset all settings to defaults** restores everything at once. Your settings are kept when the script updates.
