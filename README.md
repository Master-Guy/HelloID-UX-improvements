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
