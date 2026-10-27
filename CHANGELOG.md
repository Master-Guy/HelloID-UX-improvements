# Changelog

Changes to HelloID UX improvements, newest first. Each heading is the script version that Tampermonkey shows. Versions that only changed the script's details (name, address, comments) are not listed.

## 2026-10-27.1

### Source systems: export, import and template

- **Export:** each source system tile has an export button. The file has the system's general settings, configuration form and values, scripts, person and contract mappings, thresholds and agents, plus the catalog template the system was made from. Secrets are written as `***` unless the setting **Target system export: include secrets** is on.
- **Template:** a new info button on each tile shows which catalog template the system was made from, its release, and whether a newer release is available. HelloID sets the template when the system is made, and it can't be changed afterwards, so this button only shows it.
- **Import:** a new button next to HelloID's **+**. The file goes to the system it was exported from, or else the one with the same name. You can also import it as a new system. A new source system is made from the latest release of the file's template. If that fails, the catalog ID in the file is used, and otherwise the latest **Source Template**.

### Every import asks what to do first

Target systems, notifications, notification systems and source systems now all start with a selection step:

1. **What to do:** overwrite the matching item, or import the file as a new one with a name of its own. This choice is also offered when the item already matches the file exactly.
2. **What to import:** after **Next** (when you overwrite), you tick which parts of the file to import and which links to make: depends-on systems, agents, notifications, business rules, and the target system data used in notifications.

A part you leave out keeps what the system has, even when another part is saved in the same request. When you import a configuration form without its values, any field that has no value gets the form's default. A new target system always gets its general settings, because those give it its name and keep it disabled.

### Business rules: Clone opens in a new tab

The Clone button of a business rule is now a link. Ctrl+click or the middle mouse button makes the copy in a new tab and opens it there.

### Fixes

- **Import target system:**
  - unticking "Configuration values" no longer imports the file's values anyway;
  - correlation and the uniqueness check that you leave out are no longer overwritten when the mapping is replaced;
  - checklist tasks of parts you leave out are no longer ticked off in a PowerShell v2 migration.
- **Closing message:**
  - only reports business rules that were actually saved;
  - no longer mentions notifications, business rules or dependencies you chose not to import.

## 2026-10-26.2

### Password fields: show what is typed

Every password field gets an eye button on its right edge. Click it to see what you typed, and click it again to hide it.

## 2026-10-26.1

### Export and import notifications

- **Notification Configurations:**
  - an export button in each row;
  - **Export all** and **Import** buttons next to HelloID's **+**.
- **Notification Systems:**
  - an export button on each tile;
  - an **Import** button next to the **+**.

Files store the target systems, notification systems and templates they use by ID and by name, so an import into another environment finds them again. A new notification starts **disabled**. Before anything is overwritten, the import shows what will change, downloads a backup, and asks you to confirm.

## 2026-10-22.1

### Create a target system from GitHub

A GitHub button next to the import button lists Tools4ever's target connectors. Pick one to see its README, latest release and files. **Create** lets you:

- name the new system;
- choose which file goes to each part;
- pick a variant;
- set up the permission sets.

The new system is created **disabled**. To raise GitHub's limit of 60 requests an hour, set a token in the new setting **GitHub: token**.

### Microsoft Entra ID: from a client secret to a certificate

A second script, **HelloID Entra ID certificates**, moves Entra ID systems from a client secret to a certificate. It builds on HelloID UX improvements, which has to be installed too. Three symbols show where each system stands, with filter buttons in the list:

- 🔐 still on a client secret;
- 🚧 halfway;
- 🧪 ready to test and clean up.

### Export without a browser

`Export-HelloIDTargetSystems.ps1` makes the same files as the Export button, for automation.

### For script authors

Other userscripts can now build on this one through `window.HelloIDUX`. They can add symbols with filter buttons, add buttons per target system, and use the script's own helpers.

## 2026-10-12.2

- **Business rules > Entitlements:** copy buttons on System and Entitlement. A **≥1** button in the Rules header shows only the entitlements that at least one business rule has.
- **Entitlements > History:** the "Finished on" filter starts at 24 hours ago. **Clear** loads the full history, as HelloID does.

## 2026-10-12.1

- **Entitlements > History:** two date-and-time fields in the filter card, to show only the actions that finished in that range.
- **Import target system:** permission sets are added and deleted one at a time, because HelloID refuses more than one per request.
- **Copy buttons:**
  - added to the grids of the selected entitlement on Business rules > Entitlements;
  - a person's name is copied without the initials shown in front of it.

## 2026-10-07.1

- **Target systems:** two warning symbols of their own, each with a filter button:
  - ⛓️‍💥 for PowerShell v1 systems that business rules still use;
  - 🏁 for enabled systems that no business rule uses.

  A line in the list says how many systems are still being checked.
- **Filters:** when several are on, a row only needs to match one of them. The red "without" state on the Entitlements tab is gone.
- **Links:** these buttons are now links, so Ctrl+click, the middle mouse button and "Open in new tab" work:
  - Configure on target, source and notification system tiles;
  - the wrench of a rule, on a target system's Entitlements tab and on Persons > Rules.
- **List view:** the Actions column is gone, because it showed the same number as the info column.

## 2026-10-05.2

### Migrating PowerShell v1 systems to PowerShell v2

- **New export button** for PowerShell v1 systems. It saves the export together with instructions and a PowerShell tool for a Claude agent. The agent converts the scripts and the mapping, and answers with a file for the import.
- **Importing that file:**
  1. starts HelloID's migration, after HelloID's own warning;
  2. ticks off the migration checklist for what was imported;
  3. completes the migration when no task is left open;
  4. leaves the system disabled.

### Other changes

- **Dialogs:** errors show in red and warnings in bold. When there are any, the buttons to go on wait five seconds before you can click them.
- **Import target system:**
  - a file without a correlation field no longer sends a correlation request;
  - an empty mapping value counts as no value, as HelloID stores it.

## 2026-10-02.3

- **Import target system:** retrieving permissions follows HelloID's own 30-second limit instead of waiting two minutes. When it fails, the import goes on, and the closing message says what happened.

## 2026-10-02.2

### Export target system: everything about the system

The export now also includes:

- the business rules, with their conditions and entitlements;
- the notifications and their notification systems;
- the agent selection;
- the systems that use this one;
- a list of the secrets;
- the full configuration of built-in Active Directory and Azure AD systems.

The file name has the system ID in it, and a card shows the progress.

### Export granted entitlements

A new export button saves the entitlements each person has in the system, to compare before and after a change.

### Import target system

- Active Directory systems can be imported, also as a new system.
- The import also sets the agent selection and the notifications.
- Business rules are linked, but only saved as drafts. Permissions are retrieved first when needed.
- Dependencies are found by name when their ID isn't in the environment.

## 2026-10-01.8

- **Import target system:** a card shows each request and how it went, as it happens. A new system starts **disabled**.

## 2026-10-01.7

### Import target system

An import button next to **Add new system** reads an export file:

- It shows what differs from the system and, after you confirm, writes it to HelloID. A backup of the system is downloaded first.
- It covers the general settings, dependencies, configuration values, account scripts, thresholds, resources, permissions, mapping, uniqueness check and correlation.
- A file whose system isn't in the environment creates a new system, after you confirm.
- This first version supports PowerShell systems only.

Messages now show in a dialog of their own, which scrolls and has a **Copy text** button. The export now also saves the resources, the system ID and name, and hides values whose name says they are secret.

## 2026-10-01.6

### Export target system

An export button between Copy name and Configure, in the list and on the tiles, asks where to save the file. The file has:

- the system's configuration;
- the scripts and default scripts of PowerShell systems;
- the business rules that have an entitlement for the system.

Password fields are written as `***` unless the new setting **Target system export: include secrets** is on. The settings for button colors are gone.

## 2026-10-01.5

- **Target systems list:** the sort buttons show an up-down arrows icon. The sorted column highlights the arrow of its direction. Clicking the sorted column reverses the direction, and the Name sort button goes back to the default order.

## 2026-10-01.4

- **Persons > Rules:**
  - a filter button in the Status header shows all rules, only the rules the person is in, or only the rules the person is not in;
  - a copy button in the Name column;
  - better starting widths for the Name and Entitlements columns.

## 2026-10-01.3

- **Persons > Audit logs:** copy buttons for system and message.
- **Notifications > Configurations:** copy buttons for name and system, and column widths that fit, with the name column taking the space that is left.

## 2026-10-01.2

- **Evaluations > Actions:**
  - all rows are fetched at once;
  - filter buttons on the entitlement type icon;
  - copy buttons for system, person and entitlement name.
- **Entitlements > Granted:** all rows are fetched at once. The "first 500 entitlements" warning is hidden once everything is loaded.
- **Entitlements > Granted and History:** copy buttons for system, person and entitlement name.
- **Business rules > Rules:** a copy button in the persons grid of a rule.
- **Copy buttons** copy only the name, not the description line under it.
- **Settings renamed:** "Grids: max rows to fetch" and "Grids: cache duration (minutes)".

## 2026-10-01.1

- **Business rules > Entitlements:** warning and info filter buttons, with counts, for entitlements the target system no longer has.
- **Copy buttons** in the Rules and Persons tabs of a selected entitlement.
- **Grids that fetch all rows** keep them for 5 minutes, so scrolling and filtering don't load them again. The time is a setting. The grid shows its loading overlay while the rows come in.

## 2026-09-30.4

- **Target systems list:** sort buttons in the Name, Summary since and Last updated headers.

## 2026-09-30.3

- **Filters** are kept per browser tab, and reset when you go to another page.
- **Target systems list:** the recent action columns are in a fixed order, each with its own icon.

## 2026-09-30.2

### Target systems: list view

The Target Systems overview can show a table instead of tiles, with one row per system. You can switch back to tiles. The list has:

- a search on name, which also filters the tiles;
- filter buttons, with counts, for systems with warnings and for disabled systems;
- resizable columns and a header that stays visible while you scroll;
- Copy name and Configure buttons in each row;
- the recent actions as numbers, colored by their status.

## 2026-09-30.1

### Filter panels: all items, with a search

- The pop-up filter cards show all items instead of the first 50.
- The systems list gets a search box, a **Selected systems only** button, and a count of what is selected.
- Each list has its own **Select all** button, which acts on the items you can see.

## 2026-09-29.3

- **All HelloID addresses:** the script now runs on every HelloID address, not only `*.helloid.com`.

## 2026-09-29.2

- **Resizable columns** in all grids, not only on Business Rules.

## 2026-09-29.1

- **Business Rules:**
  - a copy button on each rule name, and the full name on hover;
  - all columns can be resized, with a light line in the header showing where.

## 2026-09-25.2

- **Settings:** a menu in Tampermonkey to change the script's settings, and to reset them to their defaults.

## 2026-09-25.1

### First version

- **Target system > Entitlements tab:** filter buttons for rules with an account, account access or permission entitlement.
- **Target systems:** a button to copy a system's name.
- **Business Rules:** a button to copy a rule's name.
