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

### Settings

Settings can be changed from the Tampermonkey toolbar menu while on a HelloID page. Each setting has its own menu entry showing its current value; leave a value empty to use the default. **Reset all settings to defaults** restores everything at once. Your settings are kept when the script updates.
