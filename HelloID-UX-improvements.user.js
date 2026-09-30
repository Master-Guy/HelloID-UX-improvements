// ==UserScript==
// @name         HelloID UX improvements
// @version      2026-09-30.3
// @description  Adds custom improvements to the HelloID admin and provisioning interfaces
// @updateURL    https://raw.githubusercontent.com/Master-Guy/HelloID-UX-improvements/refs/heads/main/HelloID-UX-improvements.user.js
// @downloadURL  https://raw.githubusercontent.com/Master-Guy/HelloID-UX-improvements/refs/heads/main/HelloID-UX-improvements.user.js
// @author       Master-Guy
// @homepageURL  https://github.com/Master-Guy/HelloID-UX-improvements
// @match        https://*.helloid.com/*
// @match        https://*.helloid.training/*
// @include      /^https:\/\/[^\/]*helloid[^\/]*\//
// @icon         https://www.svgrepo.com/show/530424/copy.svg
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @sandbox      JavaScript
// ==/UserScript==

(function () {
    'use strict';

    // =====================================================================
    // Settings
    // =====================================================================
    // These are the defaults. Your own changes are made via the Tampermonkey
    // toolbar menu, are stored by Tampermonkey and survive script updates.

    const DEFAULTS = Object.freeze({
        // Entitlements tab: number of rules requested from the server in one go.
        // Must be higher than the number of rules on any target system.
        fetchAllTake: 99999,

        // Entitlements tab: wait this long after the last filter click
        // before reloading, so several buttons can be set in one go.
        filterReloadDelayMs: 1500,

        // Entitlements tab: icon colors per filter status
        filterColors: {
            unknown:  '#cdcdcd',  // no filter
            enabled:  'black',    // only rules WITH this entitlement
            disabled: 'red',      // only rules WITHOUT this entitlement
        },

        // Copy buttons: how long the check/cross is shown after copying
        copyFeedbackMs: 1000,
    });

    const SETTINGS_KEY = 'settings';

    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    // Defaults + stored overrides. Nested objects (like filterColors) are
    // merged too, so overriding one color keeps the other defaults.
    function mergeSettings(defaults, overrides) {
        const result = { ...defaults };
        for (const [key, value] of Object.entries(overrides || {})) {
            result[key] = isPlainObject(defaults[key]) && isPlainObject(value)
                ? mergeSettings(defaults[key], value)
                : value;
        }
        return result;
    }

    const SETTINGS = Object.freeze(mergeSettings(DEFAULTS, GM_getValue(SETTINGS_KEY, {})));

    // --- Settings menu (Tampermonkey toolbar menu) ---

    const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

    function setPath(obj, path, value) {
        const keys = path.split('.');
        const last = keys.pop();
        let o = obj;
        for (const k of keys) {
            if (!isPlainObject(o[k])) o[k] = {};
            o = o[k];
        }
        o[last] = value;
    }

    function deletePath(obj, path) {
        const keys = path.split('.');
        const last = keys.pop();
        const parent = keys.reduce((o, k) => o?.[k], obj);
        if (!isPlainObject(parent)) return;
        delete parent[last];
        // Clean up empty parent objects
        if (keys.length && Object.keys(parent).length === 0) deletePath(obj, keys.join('.'));
    }

    const parsePositiveInt = (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    const parseColor = (v) => (CSS.supports('color', v) ? v : undefined);

    const SETTING_DEFS = [
        {
            path: 'copyFeedbackMs',
            label: 'Copy buttons: feedback time (ms)',
            description: 'How long the check mark (or cross) is shown after clicking a copy button.',
            parse: parsePositiveInt,
            hint: 'a whole number of milliseconds',
        },
        {
            path: 'fetchAllTake',
            label: 'Entitlements: max rules to fetch',
            description: 'Number of rules requested from the server in one go on the Entitlements tab. ' +
                         'Must be higher than the number of rules on any target system.',
            parse: parsePositiveInt,
            hint: 'a whole number',
        },
        {
            path: 'filterColors.unknown',
            label: 'Entitlements filter: color for "no filter"',
            description: 'Icon color of a filter button that is not filtering.',
            parse: parseColor,
            hint: 'a CSS color, e.g. #cdcdcd or grey',
        },
        {
            path: 'filterColors.enabled',
            label: 'Entitlements filter: color for "with entitlement"',
            description: 'Icon color of a filter button that only shows rules WITH this entitlement.',
            parse: parseColor,
            hint: 'a CSS color, e.g. black or #000',
        },
        {
            path: 'filterColors.disabled',
            label: 'Entitlements filter: color for "without entitlement"',
            description: 'Icon color of a filter button that only shows rules WITHOUT this entitlement.',
            parse: parseColor,
            hint: 'a CSS color, e.g. red or #c00',
        },
        {
            path: 'filterReloadDelayMs',
            label: 'Entitlements filter: reload delay (ms)',
            description: 'How long to wait after the last click on a filter button before the page reloads, ' +
                         'so you can set several filters in one go.',
            parse: parsePositiveInt,
            hint: 'a whole number of milliseconds',
        },
    ].sort((a, b) => a.label.localeCompare(b.label));

    function editSetting(def) {
        const overrides = GM_getValue(SETTINGS_KEY, {});
        const current = getPath(overrides, def.path);
        const defaultValue = getPath(DEFAULTS, def.path);

        const input = prompt(
            `${def.label}\n\n` +
            `${def.description}\n\n` +
            `Default: ${defaultValue}\n` +
            `Leave empty to use the default.`,
            current ?? ''
        );
        if (input === null) return; // cancelled

        const trimmed = input.trim();
        if (trimmed === '') {
            deletePath(overrides, def.path);
        } else {
            const value = def.parse(trimmed);
            if (value === undefined) {
                alert(`"${trimmed}" is not valid. Expected ${def.hint}.\nNothing was saved.`);
                return;
            }
            setPath(overrides, def.path, value);
        }

        GM_setValue(SETTINGS_KEY, overrides);
        location.reload();
    }

    for (const def of SETTING_DEFS) {
        GM_registerMenuCommand(`${def.label}: ${getPath(SETTINGS, def.path)}`, () => editSetting(def));
    }

    GM_registerMenuCommand('Reset all settings to defaults', () => {
        if (!confirm('Reset all settings to their defaults?')) return;
        GM_setValue(SETTINGS_KEY, {});
        location.reload();
    });

    // =====================================================================
    // Filter state
    // =====================================================================

    const ButtonStatus = Object.freeze({
        UNKNOWN:  'unknown',   // don't filter on this entitlement
        ENABLED:  'enabled',   // only rules WITH this entitlement
        DISABLED: 'disabled',  // only rules WITHOUT this entitlement
    });

    const statusOrder = Object.values(ButtonStatus);

    const statusColor = {
        [ButtonStatus.UNKNOWN]:  SETTINGS.filterColors.unknown,
        [ButtonStatus.ENABLED]:  SETTINGS.filterColors.enabled,
        [ButtonStatus.DISABLED]: SETTINGS.filterColors.disabled,
    };

    const FILTERS = [
        { key: 'account',     field: 'accountEntitlementForSystem',       icon: 'fa-user',      title: 'Account entitlement' },
        { key: 'access',      field: 'accountAccessEntitlementForSystem', icon: 'fa-lock-open', title: 'Account access entitlement' },
        { key: 'permissions', field: 'permissionEntitlementForSystem',    icon: 'fa-users',     title: 'Permission entitlement(s)' },
    ];

    // Filters are kept per browser tab, in sessionStorage: they survive
    // reloads of that tab, but other tabs have their own (see "Filters
    // reset on navigation" below). Settings, by contrast, are shared.
    function sessionGet(key, fallback) {
        try {
            const value = sessionStorage.getItem(key);
            return value === null ? fallback : JSON.parse(value);
        } catch {
            return fallback; // blocked or invalid
        }
    }

    function sessionSet(key, value) {
        try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* blocked */ }
    }

    const FILTER_STATE_KEY = 'tm-helloid-filter-state';

    function loadState() {
        const stored = sessionGet(FILTER_STATE_KEY, {});
        return isPlainObject(stored) ? stored : {};
    }

    function saveState(state) {
        sessionSet(FILTER_STATE_KEY, state);
    }

    const filterState = loadState();
    const statusOf = (key) => filterState[key] || ButtonStatus.UNKNOWN;

    function nextStatus(current) {
        const i = statusOrder.indexOf(current);
        return statusOrder[(i + 1) % statusOrder.length];
    }

    function matchesFilters(rule) {
        return FILTERS.every(f => {
            switch (statusOf(f.key)) {
                case ButtonStatus.ENABLED:  return rule[f.field] === true;
                case ButtonStatus.DISABLED: return rule[f.field] === false;
                default:                    return true;
            }
        });
    }

    // =====================================================================
    // Response interception
    // =====================================================================

    // The page's real window. With @sandbox JavaScript this is the page itself;
    // patching the script's own window would not affect HelloID.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const TARGET = /\/entitlements-overview(\?|$)/;

    // Field the grid uses to decide how many rows exist
    const COUNT_KEYS = ['totalRowCount'];

    // Always ask the server for everything, but remember which page the app wanted.
    function rewriteUrl(url) {
        // Before filtering: drop filters left over from another page
        syncFiltersWithPage();

        const u = new URL(url, location.href);
        const skipParam = u.searchParams.get('skip');
        const takeParam = u.searchParams.get('take');
        const page = {
            skip: parseInt(skipParam, 10) || 0,
            take: takeParam === null ? Infinity : (parseInt(takeParam, 10) || Infinity),
        };
        u.searchParams.set('skip', '0');
        u.searchParams.set('take', String(SETTINGS.fetchAllTake));
        page.url = u.toString();
        return page;
    }

    // Filter the full set, then hand the app only the page it asked for.
    function modifyData(data, page) {
        if (!Array.isArray(data?.pageData)) return data;

        const filtered = data.pageData.filter(matchesFilters);
        data.pageData = filtered.slice(page.skip, page.skip + page.take);

        for (const key of COUNT_KEYS) {
            if (typeof data[key] === 'number') data[key] = filtered.length;
        }
        return data;
    }

    function modifyJsonText(text, page) {
        try {
            return JSON.stringify(modifyData(JSON.parse(text), page));
        } catch (e) {
            console.warn('Could not modify response', e);
            return text;
        }
    }

    // --- fetch ---
    const origFetch = pageWindow.fetch;
    pageWindow.fetch = async function (input, init) {
        const url = input instanceof pageWindow.Request ? input.url : String(input);
        if (!TARGET.test(url)) return origFetch.call(this, input, init);

        const page = rewriteUrl(url);
        const newInput = input instanceof pageWindow.Request ? new pageWindow.Request(page.url, input) : page.url;
        const response = await origFetch.call(this, newInput, init);

        const text = await response.clone().text();
        const modified = new pageWindow.Response(modifyJsonText(text, page), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
        Object.defineProperty(modified, 'url', { value: url });
        return modified;
    };

    // --- XMLHttpRequest ---
    const proto = pageWindow.XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origResponse = Object.getOwnPropertyDescriptor(proto, 'response').get;
    const origResponseText = Object.getOwnPropertyDescriptor(proto, 'responseText').get;

    proto.open = function (method, url, ...rest) {
        const s = String(url);
        if (TARGET.test(s)) {
            this._tmPage = rewriteUrl(s);
            return origOpen.call(this, method, this._tmPage.url, ...rest);
        }
        this._tmPage = null;
        return origOpen.call(this, method, url, ...rest);
    };

    function getModified(xhr) {
        if (!('_tmResult' in xhr)) {
            const raw = origResponse.call(xhr);
            xhr._tmResult = typeof raw === 'string'
                ? modifyJsonText(raw, xhr._tmPage)
                : (raw && typeof raw === 'object' ? modifyData(raw, xhr._tmPage) : raw);
        }
        return xhr._tmResult;
    }

    Object.defineProperty(proto, 'response', {
        configurable: true,
        get() {
            return this._tmPage && this.readyState === 4
                ? getModified(this)
                : origResponse.call(this);
        },
    });

    Object.defineProperty(proto, 'responseText', {
        configurable: true,
        get() {
            return this._tmPage && this.readyState === 4
                ? getModified(this)
                : origResponseText.call(this);
        },
    });

    // =====================================================================
    // Filter panels: show all items instead of the first 50
    // =====================================================================
    // The filter pop-up cards (helloid-filter-panels) render their items
    // with Angular's slice pipe: `filters | slice:0:50`. The pipe and the
    // component aren't reachable from here, but the pipe just calls
    // array.slice(0, 50). So catch exactly that call, when it comes from a
    // pipe's transform(), and return everything instead.

    const FILTER_PANEL_LIMIT = 50;
    const ArrayProto = pageWindow.Array.prototype;
    const origSlice = ArrayProto.slice;

    ArrayProto.slice = function (start, end) {
        if (start === 0 && end === FILTER_PANEL_LIMIT &&
            arguments.length === 2 &&
            Array.isArray(this) && this.length > FILTER_PANEL_LIMIT &&
            /\btransform\b/.test(new Error().stack)) {
            return origSlice.call(this);
        }
        return origSlice.apply(this, arguments);
    };

    // =====================================================================
    // UI
    // =====================================================================

    const FILTER_DIV_ID = 'tm-entitlement-filters';

    function isEntitlementsPage() {
        return location.href.includes('/target/systems/') &&
               location.href.includes('tab=Entitlements');
    }

    // Reload after a short pause, so you can click the buttons several times
    // to set the statuses you want before the data is fetched again.
    // Every click (on any of the three buttons) restarts the timer.
    let reloadTimer;
    function scheduleReload() {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => location.reload(), SETTINGS.filterReloadDelayMs);
    }

    function createFilterButton(filter) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-default btn-xs';
        btn.style.height = '35px';
        btn.title = filter.title;

        const icon = document.createElement('i');
        icon.className = `fa-solid ${filter.icon} fa-xl m-l-5 m-r-5`;
        btn.appendChild(icon);

        const render = () => {
            btn.dataset.status = statusOf(filter.key);
            icon.style.color = statusColor[btn.dataset.status];
        };
        render();

        btn.addEventListener('click', (e) => {
            // Keep the click away from the page's own handlers and forms
            e.preventDefault();
            e.stopPropagation();

            filterState[filter.key] = nextStatus(statusOf(filter.key));
            saveState(filterState);
            render();
            scheduleReload();
        });

        return btn;
    }

    function addFilterOptions() {
        if (document.getElementById(FILTER_DIV_ID)) return;

        const searchBar = document.querySelector('input[placeholder="Search rules"]');
        if (!searchBar) return;

        console.log('Adding filter options');
        const filterDiv = document.createElement('div');
        filterDiv.id = FILTER_DIV_ID;
        FILTERS.forEach(f => filterDiv.appendChild(createFilterButton(f)));
        searchBar.parentElement.appendChild(filterDiv);
    }

    // =====================================================================
    // Filter panels: search, "selected only", per-list select buttons
    // =====================================================================
    // Each list (panel) gets a footer with its own controls, so they line
    // up with their column:
    //   large list (systems): [search box]
    //                         [Selected systems only]  [Select all systems]
    //   other lists (types):                           [Select all types]
    // The footers sit at the bottom of their panel, so the button rows
    // line up. HelloID's own "Select all" row (which (de)selects all lists
    // at once) is hidden. The large list's header shows how many items
    // are selected.

    const SEARCH_CLASS = 'tm-filter-search';
    const FOOTER_CLASS = 'tm-filter-footer';
    const TOGGLE_CLASS = 'tm-filter-checked-only';
    const SELECT_BTN_CLASS = 'tm-filter-select';
    const COUNT_CLASS = 'tm-filter-count';

    const panelItems = (panel) => [...panel.querySelectorAll('.filter-grid-column > .checkbox')];
    const itemCheckbox = (item) => item.querySelector('input[type="checkbox"]');
    const isShown = (item) => item.style.display !== 'none';
    const isSearchable = (panel) => panel.matches('.filter-panel-large');

    // Header text of a panel, without our count, e.g. "System"
    function panelName(panel) {
        const header = panel.querySelector('.card-header');
        if (!header) return '';
        return [...header.childNodes]
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent)
            .join('')
            .trim();
    }

    // "System" -> "systems", "Type" -> "types", "Category" -> "categories"
    function plural(word) {
        const w = word.toLowerCase();
        if (/s$/.test(w)) return w;
        if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
        return w + 's';
    }

    // Set text only when it changed; our MutationObserver would otherwise
    // see every write as a change and keep refreshing.
    function setText(el, text) {
        if (el.textContent !== text) el.textContent = text;
    }

    // Search: every word must appear in the name, in any order, ignoring case
    const toWords = (text) => (text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const matchesWords = (name, words) => {
        const n = name.toLowerCase();
        return words.every(w => n.includes(w));
    };

    function searchWords(host) {
        return toWords(host.querySelector(`.${SEARCH_CLASS}`)?.value);
    }

    function refreshFilterPanels(host) {
        const words = searchWords(host);
        const checkedOnly = host.dataset.tmCheckedOnly === '1';

        host.querySelectorAll('.filter-panel').forEach(panel => {
            const items = panelItems(panel);

            if (isSearchable(panel)) {
                // Show/hide items
                items.forEach(item => {
                    const show = matchesWords(item.title || item.textContent, words) &&
                                 (!checkedOnly || itemCheckbox(item)?.checked);
                    const display = show ? '' : 'none';
                    if (item.style.display !== display) item.style.display = display;
                });

                // Selected count in the header
                const header = panel.querySelector('.card-header');
                let count = header?.querySelector(`.${COUNT_CLASS}`);
                if (header && !count) {
                    count = document.createElement('span');
                    count.className = `${COUNT_CLASS} text-muted small m-l-5`;
                    count.style.fontWeight = 'normal';
                    header.appendChild(count);
                }
                if (count) {
                    const selected = items.filter(i => itemCheckbox(i)?.checked).length;
                    // e.g. "12 of 240 system(s) selected"
                    const noun = panelName(panel).toLowerCase();
                    setText(count, `${selected} of ${items.length} ${noun}(s) selected`);
                }
            }

            // Button label: "Deselect all" when every visible item is ticked
            const btn = panel.querySelector(`.${SELECT_BTN_CLASS}`);
            if (btn) {
                const visible = items.filter(isShown);
                const allChecked = visible.length > 0 && visible.every(i => itemCheckbox(i)?.checked);
                setText(btn.querySelector('span'),
                    `${allChecked ? 'Deselect' : 'Select'} all ${plural(panelName(panel))}`);
                const icon = btn.querySelector('i');
                const iconClass = allChecked ? 'fa-regular fa-square' : 'fa-solid fa-check-square';
                if (icon.className !== iconClass) icon.className = iconClass;
            }
        });

        // "Selected ... only" toggle look
        const toggle = host.querySelector(`.${TOGGLE_CLASS}`);
        if (toggle) {
            toggle.classList.toggle('btn-primary', checkedOnly);
            toggle.classList.toggle('btn-default', !checkedOnly);
        }
    }

    // Tick or untick the visible items of one panel, via their checkboxes,
    // so HelloID handles each change as if clicked by hand.
    function toggleVisible(host, panel) {
        const visible = panelItems(panel).filter(isShown);
        const allChecked = visible.length > 0 && visible.every(i => itemCheckbox(i)?.checked);
        visible.forEach(item => {
            const checkbox = itemCheckbox(item);
            if (checkbox && checkbox.checked === allChecked) checkbox.click();
        });
        refreshFilterPanels(host);
    }

    function createSmallButton(iconClass, onClick) {
        const btn = document.createElement('a');
        btn.className = 'btn btn-xs btn-default m-t-10';
        const icon = document.createElement('i');
        icon.className = iconClass;
        const label = document.createElement('span');
        btn.append(icon, ' ', label);
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    // Search input in HelloID's own form style
    function createSearchInput(onInput) {
        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'Search...';
        input.className = 'form-control input-sm';
        input.style.height = '24px';
        input.addEventListener('input', onInput);
        // Keep typing away from the page's own key handlers
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') e.stopPropagation();
        });
        return input;
    }

    function createSearchBox(host) {
        const input = createSearchInput(() => refreshFilterPanels(host));
        input.classList.add('m-t-10', SEARCH_CLASS);
        input.style.width = '100%';
        return input;
    }

    function createPanelFooter(host, panel) {
        const footer = document.createElement('div');
        footer.className = FOOTER_CLASS;
        // Pushed to the bottom of the panel (a flex column, see below)
        footer.style.marginTop = 'auto';

        // Buttons stay on one row; the row is never narrower than the
        // buttons, so the panel (min-width: min-content) grows to fit them
        const buttons = document.createElement('div');
        Object.assign(buttons.style, {
            display: 'flex',
            flexWrap: 'nowrap',
            gap: '5px',
            justifyContent: 'flex-end',
            minWidth: 'max-content',
        });

        if (isSearchable(panel)) {
            footer.appendChild(createSearchBox(host));

            const items = plural(panelName(panel));
            const toggle = createSmallButton('fa-solid fa-filter', () => {
                host.dataset.tmCheckedOnly = host.dataset.tmCheckedOnly === '1' ? '' : '1';
                refreshFilterPanels(host);
            });
            toggle.classList.add(TOGGLE_CLASS);
            toggle.title = `Only show the selected ${items}`;
            toggle.querySelector('span').textContent = `Selected ${items} only`;
            // margin-right: auto keeps it left, the select button right
            toggle.style.marginRight = 'auto';
            buttons.appendChild(toggle);
        }

        const selectBtn = createSmallButton('', () => toggleVisible(host, panel));
        selectBtn.classList.add(SELECT_BTN_CLASS);
        buttons.appendChild(selectBtn);

        footer.appendChild(buttons);
        return footer;
    }

    // Reserve room for the longest label, so the button keeps its width
    // when it switches between "Select all" and "Deselect all"
    function reserveLabelWidth(btn, longestLabel) {
        const span = btn.querySelector('span');
        const current = span.textContent;
        span.textContent = longestLabel;
        btn.style.minWidth = `${btn.offsetWidth}px`;
        span.textContent = current;
    }

    // Let the pop-up card grow to fit the panels: remove any max-width
    // between the panels and the card itself
    function uncapCardWidth(host) {
        for (let el = host; el && el !== document.body; el = el.parentElement) {
            el.style.setProperty('max-width', 'none', 'important');
            if (el.matches('popover-container, .popover')) break;
        }
    }

    function addFilterPanelSearch() {
        document.querySelectorAll('helloid-filter-panels').forEach(host => {
            if (!host.querySelector('.filter-panel-large')) return;

            // HelloID's "Select all" row: replaced by the per-list buttons
            const origSelectAll = [...host.querySelectorAll('a.btn')]
                .find(a => !a.closest(`.${FOOTER_CLASS}`) && /select all/i.test(a.textContent));
            if (origSelectAll?.parentElement) {
                origSelectAll.parentElement.style.display = 'none';
            }

            const newPanels = [];
            host.querySelectorAll('.filter-panel').forEach(panel => {
                if (panel.querySelector(`.${FOOTER_CLASS}`)) return;

                // Flex column, so the footer can sit at the bottom and the
                // footers of all panels line up
                Object.assign(panel.style, { display: 'flex', flexDirection: 'column' });
                // At least as wide as its narrowest possible content, which
                // includes the footer button row. The item names don't
                // count: they are cut off with "..." anyway.
                panel.style.setProperty('min-width', 'min-content', 'important');
                // Keep the header as wide as its text, like before
                const header = panel.querySelector('.card-header');
                if (header) header.style.alignSelf = 'flex-start';

                panel.appendChild(createPanelFooter(host, panel));
                newPanels.push(panel);
            });

            if (!host.dataset.tmListening) {
                host.dataset.tmListening = '1';
                // Checkbox clicks change counts, labels and "Selected only"
                host.addEventListener('change', () => refreshFilterPanels(host));
            }

            // Re-apply after the page re-renders the lists
            refreshFilterPanels(host);

            if (newPanels.length) {
                uncapCardWidth(host);

                newPanels.forEach(panel => {
                    const selectBtn = panel.querySelector(`.${SELECT_BTN_CLASS}`);
                    if (selectBtn) {
                        reserveLabelWidth(selectBtn, `Deselect all ${plural(panelName(panel))}`);
                    }
                });

                host.querySelector(`.${SEARCH_CLASS}`)?.focus();
            }
        });
    }

    // =====================================================================
    // Target systems overview: copy system name
    // =====================================================================

    const COPY_BTN_CLASS = 'tm-copy-system-name';

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fallback for when the Clipboard API is refused
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        }
    }

    // Generic copy button. getText is called at click time, so it always
    // copies what's shown right now (grid rows get recycled while scrolling).
    function createCopyButton(getText, className) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `${className} ${COPY_BTN_CLASS}`;
        btn.title = 'Copy name';

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-copy';
        btn.appendChild(icon);

        // Keep the click away from the tile/grid row (open, select, focus)
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('dblclick', (e) => e.stopPropagation());

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const text = getText(btn)?.trim();
            if (!text) {
                console.warn('Nothing to copy', btn);
                return;
            }

            const ok = await copyToClipboard(text);
            icon.className = ok ? 'fa-solid fa-check' : 'fa-solid fa-xmark';
            setTimeout(() => { icon.className = 'fa-solid fa-copy'; }, SETTINGS.copyFeedbackMs);
        });

        return btn;
    }

    // --- Target systems overview: tiles ---
    function addSystemTileCopyButtons() {
        document.querySelectorAll('helloid-provisioning-system-tile').forEach(tile => {
            if (tile.querySelector(`.${COPY_BTN_CLASS}`)) return;

            const configureBtn = tile.querySelector('button[title="configure" i]');
            if (!configureBtn) return;

            const btn = createCopyButton(
                () => tile.querySelector('h5')?.innerText,
                configureBtn.className
            );
            configureBtn.before(btn);
        });
    }

    // --- Business rules overview: grid ---
    const RULE_NAME_CELLS =
        'helloid-rules-grid ag-grid-angular div.ag-body-viewport div[role="row"] div[col-id="name"]';

    // Text of the cell without our own button
    function cellTextWithout(cell, btn) {
        return [...cell.childNodes]
            .filter(n => n !== btn)
            .map(n => n.innerText ?? n.textContent)
            .join('');
    }

    function addRuleGridCopyButtons() {
        document.querySelectorAll(RULE_NAME_CELLS).forEach(cell => {
            if (cell.querySelector(`.${COPY_BTN_CLASS}`)) return;

            const btn = createCopyButton(
                (b) => cellTextWithout(cell, b),
                'btn btn-default btn-xs'
            );

            // Show the full name on hover. Set at hover time, since the
            // grid recycles cells while scrolling.
            cell.addEventListener('mouseenter', () => {
                cell.title = cellTextWithout(cell, btn).trim();
            });

            pinButtons(cell, btn);
        });
    }

    // Pin one or more small buttons to the right edge of a cell
    function pinButtons(cell, ...buttons) {
        const group = document.createElement('span');
        Object.assign(group.style, {
            position: 'absolute',
            right: '4px',
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            gap: '2px',
        });
        group.append(...buttons);

        // Positioning context for the buttons, unless the cell already is
        // one (AG Grid cells; sticky list headers). The list's own cells
        // get it from the CSS, as they aren't on the page yet here.
        if (getComputedStyle(cell).position === 'static') cell.style.position = 'relative';

        // Reserve room so long names end in "..." before the buttons
        cell.style.paddingRight = `${8 + 28 * buttons.length}px`;

        cell.appendChild(group);
    }

    function addCopyButtons() {
        addSystemTileCopyButtons();
        addRuleGridCopyButtons();
    }

    // =====================================================================
    // Target systems overview: list view
    // =====================================================================
    // Shows the target system tiles as a table: one row per system, with
    // resizable columns and a search on name. The tiles stay on the page
    // (hidden) and are the data source: the list is rebuilt whenever
    // HelloID updates them, and the list's Configure button clicks the
    // tile's own button. A toggle switches back to the tiles.

    const SYSTEM_TILE = 'helloid-provisioning-system-tile';
    const SYSTEM_LIST_CLASS = 'tm-system-list';
    const RESIZE_HANDLE_CLASS = 'tm-col-resize';
    const VIEW_KEY = 'systemsView'; // 'list' or 'tiles'

    // Shorter column headers for some of the tile's labels
    const LABEL_RENAMES = { 'Actions completed': 'Actions' };

    // Starting widths (px); the name column takes the remaining space,
    // but never less than nameMin. The info columns (Summary since, ...)
    // start small and grow to their widest header or value.
    const COLUMN_WIDTHS = { nameMin: 250, info: 40, progress: 120, action: 45 };

    // Info columns shown centered, without "..." (after LABEL_RENAMES)
    const CENTERED_LABELS = new Set(['Actions']);

    // Recent action columns: order and header icon. The tiles use the same
    // icon for several actions; these tell them apart. Actions not listed
    // here come after these, with the tile's own icon.
    const ACTION_COLUMNS = [
        { name: 'Grant account',     icon: 'fa-solid fa-user-plus' },
        { name: 'Update account',    icon: 'fa-solid fa-user-pen' },
        { name: 'Revoke account',    icon: 'fa-solid fa-user-xmark' },
        { name: 'Enable account',    icon: 'fa-solid fa-unlock' },
        { name: 'Disable account',   icon: 'fa-solid fa-lock' },
        { name: 'Grant permission',  icon: 'fa-regular fa-square-check' },
        { name: 'Update permission', icon: 'fa-regular fa-pen-to-square' },
        { name: 'Revoke permission', icon: 'fa-regular fa-square-xmark' },
    ];

    const FIT_CLASS = 'tm-fit'; // header of a column that fits its content

    // Symbols HelloID shows next to a system's name. Each gets a filter
    // button in the Name header: grey = off, black = only systems with
    // that symbol (same colors as the Entitlements filters). With several
    // on, a system needs all of them.
    const SYSTEM_FLAGS = [
        { key: 'warning',  icon: 'fa-solid fa-warning',   match: '.fa-warning',   label: 'systems with warnings' },
        { key: 'disabled', icon: 'fa-solid fa-power-off', match: '.fa-power-off', label: 'disabled systems' },
    ];
    const FLAG_FILTERS_KEY = 'tm-helloid-system-flags'; // in sessionStorage

    const activeFlags = () => {
        const flags = sessionGet(FLAG_FILTERS_KEY, []);
        return Array.isArray(flags) ? flags : [];
    };

    // Keys of the SYSTEM_FLAGS shown on a tile
    function tileFlags(tile) {
        const extras = tile.querySelector('h5.system-header')?.parentElement?.nextElementSibling;
        return SYSTEM_FLAGS.filter(f => extras?.querySelector(f.match)).map(f => f.key);
    }

    const matchesFlags = (flags, active) => active.every(k => flags.includes(k));

    let systemList = null; // { container, wrapper, table, search, count, observer, signature, headSignature }

    const isListView = () => GM_getValue(VIEW_KEY, 'list') === 'list';
    const uniqueBy = (arr, key) => [...new Map(arr.map(x => [key(x), x])).values()];

    // Everything shown on a tile, read from its DOM
    function readTile(tile) {
        const nameEl = tile.querySelector('h5.system-header');

        // "Summary since:", "Last updated:", ... label/value pairs
        const info = [];
        tile.querySelectorAll('.card-body small').forEach(label => {
            const text = label.textContent.trim();
            const value = label.nextElementSibling;
            if (text.endsWith(':') && value?.tagName === 'SMALL') {
                info.push({ label: text.slice(0, -1), value: value.textContent.trim() });
            }
        });

        const actions = [...tile.querySelectorAll('.recent-actions .badge')].map(badge => {
            const texts = badge.querySelector('.flex-col')?.children ?? [];
            // Status icon on the right of the badge, e.g. the green check
            // "Action(s) are completed"
            const status = badge.querySelector('.justify-end i');
            return {
                name: texts[0]?.textContent.trim() ?? '',
                count: texts[1]?.textContent.trim() ?? '',
                icon: badge.querySelector('i.fa-fw')?.className ?? '',
                statusTitle: status?.title ?? '',
                // Its color (text-success, ...), used for the number
                statusClass: [...(status?.classList ?? [])].filter(c => c.startsWith('text-')).join(' '),
            };
        });

        return {
            name: nameEl?.textContent.trim() ?? '',
            // Extra symbols next to the name (warning, disabled)
            extras: nameEl?.parentElement?.nextElementSibling ?? null,
            flags: tileFlags(tile),
            icon: tile.querySelector('helloid-connector-icon img')?.src ?? '',
            info,
            progress: tile.querySelector('circle-progress tspan')?.textContent.trim() ?? '',
            progressColor: tile.querySelector('circle-progress path')?.getAttribute('stroke') ?? '',
            actions,
            // "Recent actions" and the explanation behind its (i) icon
            recentLabel: tile.querySelector('.recent-actions > span strong')?.textContent.trim() ?? '',
            recentInfo: tile.querySelector('.recent-actions > span i')?.title ?? '',
        };
    }

    // Changes when anything shown in the list changes
    function systemsSignature(rows) {
        return JSON.stringify(rows.map(r => [
            r.name, r.icon, r.info, r.progress, r.progressColor, r.extras?.innerHTML, r.actions,
        ]));
    }

    function columnModel(rows) {
        const withRecent = rows.find(r => r.recentLabel);
        const position = (name) => {
            const i = ACTION_COLUMNS.findIndex(c => c.name === name);
            return i === -1 ? ACTION_COLUMNS.length : i;
        };
        return {
            infoLabels: [...new Set(rows.flatMap(r => r.info.map(i => i.label)))],
            // Sorted like ACTION_COLUMNS (stable, so unknown actions keep
            // the tiles' order), with our icons
            actions: uniqueBy(rows.flatMap(r => r.actions), a => a.name)
                .sort((a, b) => position(a.name) - position(b.name))
                .map(a => ({
                    name: a.name,
                    icon: ACTION_COLUMNS.find(c => c.name === a.name)?.icon ?? a.icon,
                })),
            recentLabel: withRecent?.recentLabel || 'Recent actions',
            recentInfo: withRecent?.recentInfo ?? '',
        };
    }

    // --- Column resizing ---

    // Before the first resize: fix every column at its current width, so
    // dragging one column doesn't redistribute the others
    function freezeColumnWidths(table) {
        if (table.dataset.frozen) return;
        const cols = [...table.querySelectorAll('col')];
        const ths = [...table.querySelectorAll('thead th')];
        cols.forEach((col, i) => { col.style.width = `${ths[i].offsetWidth}px`; });
        table.dataset.frozen = '1';
        // From now on the column widths decide
        updateTableWidth(table);
    }

    function updateTableWidth(table) {
        const total = [...table.querySelectorAll('col')]
            .reduce((sum, col) => sum + parseFloat(col.style.width || 0), 0);
        table.style.width = `${total}px`;
    }

    // Until the first resize: full width, but always room for the names;
    // on narrow screens the table scrolls sideways. (min-width doesn't
    // work reliably on tables, so this goes in width itself.)
    function setAutoTableWidth(table) {
        const fixed = [...table.querySelectorAll('col')].slice(1) // all but the name
            .reduce((sum, col) => sum + parseFloat(col.style.width || 0), 0);
        table.style.width = `max(100%, ${fixed + COLUMN_WIDTHS.nameMin}px)`;
    }

    // Widen the fit-to-content columns to their widest header or value.
    // Skipped once the user resized a column, and while the list is hidden
    // (nothing to measure).
    function fitColumnsToContent(table) {
        if (table.dataset.frozen) return;
        const cols = [...table.querySelectorAll('col')];
        const rows = [...table.querySelectorAll('tbody tr')];
        let changed = false;
        table.querySelectorAll('thead th').forEach((th, i) => {
            if (!th.classList.contains(FIT_CLASS)) return;
            // scrollWidth: the full content width, also when cut off
            const cells = [th, ...rows.map(r => r.children[i]).filter(Boolean)];
            const needed = Math.max(...cells.map(c => c.scrollWidth));
            if (!needed) return;
            if (needed > (parseFloat(cols[i].style.width) || 0)) {
                cols[i].style.width = `${needed}px`;
                changed = true;
            }
        });
        if (changed) setAutoTableWidth(table);
    }

    function addResizeHandle(table, th, index) {
        const handle = document.createElement('div');
        handle.className = RESIZE_HANDLE_CLASS;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            freezeColumnWidths(table);
            const col = table.querySelectorAll('col')[index];
            const startX = e.clientX;
            const startWidth = parseFloat(col.style.width);

            const onMove = (ev) => {
                col.style.width = `${Math.max(30, startWidth + ev.clientX - startX)}px`;
                updateTableWidth(table);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', () => {
                document.removeEventListener('mousemove', onMove);
            }, { once: true });
        });
        th.appendChild(handle);
    }

    // --- Table ---

    function buildSystemsHead(table, model) {
        table.querySelector('colgroup')?.remove();
        table.querySelector('thead')?.remove();
        delete table.dataset.frozen;

        // Column widths
        const colgroup = document.createElement('colgroup');
        const hasActions = model.actions.length > 0;
        const widths = [
            ...model.infoLabels.map(() => COLUMN_WIDTHS.info),
            COLUMN_WIDTHS.progress,
            ...(hasActions ? [COLUMN_WIDTHS.action] : []), // recent actions total
            ...model.actions.map(() => COLUMN_WIDTHS.action),
        ];
        [null, ...widths].forEach(w => { // null: name, takes the remaining space
            const col = document.createElement('col');
            if (w) col.style.width = `${w}px`;
            colgroup.appendChild(col);
        });
        const th = (content, title) => {
            const cell = document.createElement('th');
            if (content instanceof Node) cell.appendChild(content);
            else cell.textContent = content ?? '';
            if (title) cell.title = title;
            return cell;
        };
        // Header with only an icon; the title shows on hover
        const iconTh = (iconClass, title) => {
            const icon = document.createElement('i');
            icon.className = iconClass;
            const cell = th(icon, title);
            cell.classList.add('tm-center');
            return cell;
        };

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');

        // Name, with the symbol filter buttons pinned right
        const nameTh = th('Name');
        pinButtons(nameTh, ...SYSTEM_FLAGS.map(createFlagButton));
        nameTh.style.paddingRight = '110px'; // room for the buttons with their counts
        headRow.appendChild(nameTh);
        model.infoLabels.forEach(l => {
            const label = LABEL_RENAMES[l] ?? l;
            const cell = th(label, l);
            cell.classList.add(FIT_CLASS);
            if (CENTERED_LABELS.has(label)) cell.classList.add('tm-center');
            headRow.appendChild(cell);
        });
        headRow.appendChild(th('Progress'));
        if (hasActions) {
            // Recent actions: (i) icon, with the tile's explanation on hover
            const info = [model.recentLabel, model.recentInfo].filter(Boolean).join('\n\n');
            headRow.appendChild(iconTh('fa-solid fa-info-circle', info));
        }
        model.actions.forEach(a => headRow.appendChild(iconTh(a.icon, a.name)));
        thead.appendChild(headRow);

        [...headRow.children].forEach((cell, i) => addResizeHandle(table, cell, i));

        table.prepend(colgroup, thead);
        setAutoTableWidth(table);
    }

    // Filter button for one of the SYSTEM_FLAGS; its look and count are
    // updated in applySystemsView()
    function createFlagButton(flag) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-default btn-xs';
        btn.dataset.flag = flag.key;
        const icon = document.createElement('i');
        icon.className = flag.icon;
        btn.append(icon, ' ', document.createElement('span'));
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const active = activeFlags();
            sessionSet(FLAG_FILTERS_KEY, active.includes(flag.key)
                ? active.filter(k => k !== flag.key)
                : [...active, flag.key]);
            applySystemsView();
        });
        return btn;
    }

    function findTileByName(name) {
        return [...document.querySelectorAll(SYSTEM_TILE)]
            .find(t => t.querySelector('h5.system-header')?.textContent.trim() === name);
    }

    function buildSystemRow(row, model) {
        const tr = document.createElement('tr');
        tr.dataset.name = row.name;
        tr.dataset.flags = row.flags.join(' ');
        const td = (text) => {
            const cell = document.createElement('td');
            if (text != null) {
                cell.textContent = text;
                cell.title = text;
            }
            tr.appendChild(cell);
            return cell;
        };

        // Name: icon, name, extra labels; copy and configure buttons pinned
        // right. Plain inline content, so the cell's own "..." cuts it off.
        const nameCell = td();
        nameCell.title = row.name;
        if (row.icon) {
            const img = document.createElement('img');
            img.src = row.icon;
            img.className = 'tm-system-icon';
            nameCell.appendChild(img);
        }
        nameCell.append(row.name);
        if (row.extras?.children.length) {
            const extras = row.extras.cloneNode(true);
            extras.classList.add('tm-system-extras');
            nameCell.appendChild(extras);
        }

        // Configure: clicks the tile's own button, so HelloID handles it
        const configure = document.createElement('button');
        configure.type = 'button';
        configure.className = 'btn btn-default btn-xs';
        configure.title = 'Configure';
        configure.innerHTML = '<i aria-hidden="true" class="fa-solid fa-wrench"></i>';
        configure.addEventListener('click', () => {
            findTileByName(row.name)?.querySelector('button[title="Configure" i]')?.click();
        });

        pinButtons(nameCell, createCopyButton(() => row.name, 'btn btn-default btn-xs'), configure);

        // Summary since, Last updated, Actions, ...
        model.infoLabels.forEach(label => {
            const cell = td(row.info.find(i => i.label === label)?.value ?? '');
            if (CENTERED_LABELS.has(LABEL_RENAMES[label] ?? label)) cell.classList.add('tm-center');
        });

        // Progress: HelloID's progress bar instead of the circle
        const progressCell = td();
        if (row.progress) {
            const pct = parseFloat(row.progress) || 0;
            progressCell.title = `${row.progress}%`;
            progressCell.innerHTML = `
                <div class="tm-progress">
                    <div class="progress"><div class="progress-bar"></div></div>
                    <small></small>
                </div>`;
            const bar = progressCell.querySelector('.progress-bar');
            bar.style.width = `${pct}%`;
            if (row.progressColor) bar.style.backgroundColor = row.progressColor;
            progressCell.querySelector('small').textContent = `${row.progress}%`;
        }

        // Recent actions: the total, then one number per action. A number
        // gets the color of the tile's status icon (e.g. green when
        // completed); the status shows on hover.
        if (model.actions.length) {
            const total = row.actions.reduce((sum, a) => sum + (parseInt(a.count, 10) || 0), 0);
            const totalCell = td(String(total));
            totalCell.classList.add('tm-center');
            totalCell.title = `${model.recentLabel}: ${total}`;
        }
        model.actions.forEach(({ name }) => {
            const action = row.actions.find(a => a.name === name);
            const cell = td(action?.count ?? '');
            cell.classList.add('tm-center');
            if (!action) return;
            if (action.statusClass) cell.className += ` ${action.statusClass}`;
            cell.title = `${name}: ${action.count}` + (action.statusTitle ? `\n${action.statusTitle}` : '');
        });

        return tr;
    }

    // --- Search, view toggle ---

    function applySystemsView() {
        if (!systemList) return;
        const { wrapper, table, search, count } = systemList;
        const list = isListView();
        const words = toWords(search.value);
        const active = activeFlags();

        let shown = 0;
        let total = 0;
        const flagCounts = {};
        table.querySelectorAll('tbody tr').forEach(tr => {
            total++;
            const flags = tr.dataset.flags.split(' ').filter(Boolean);
            flags.forEach(k => { flagCounts[k] = (flagCounts[k] ?? 0) + 1; });
            const match = matchesWords(tr.dataset.name, words) && matchesFlags(flags, active);
            if (match) shown++;
            const display = match ? '' : 'none';
            if (tr.style.display !== display) tr.style.display = display;
        });

        // Tiles: hidden in list view, filtered the same way otherwise
        document.querySelectorAll(SYSTEM_TILE).forEach(tile => {
            const name = tile.querySelector('h5.system-header')?.textContent ?? '';
            const match = matchesWords(name, words) && matchesFlags(tileFlags(tile), active);
            const display = !list && match ? '' : 'none';
            if (tile.style.display !== display) tile.style.display = display;
        });

        // Symbol filter buttons: color (off/on) and how many systems match
        table.querySelectorAll('thead button[data-flag]').forEach(btn => {
            const flag = SYSTEM_FLAGS.find(f => f.key === btn.dataset.flag);
            const on = active.includes(flag.key);
            const n = flagCounts[flag.key] ?? 0;
            const color = statusColor[on ? ButtonStatus.ENABLED : ButtonStatus.UNKNOWN];
            if (btn.style.color !== color) btn.style.color = color;
            setText(btn.querySelector('span'), String(n));
            const title = on
                ? `Showing only ${flag.label} (${n}). Click to show all.`
                : `Show only ${flag.label} (${n})`;
            if (btn.title !== title) btn.title = title;
        });

        wrapper.querySelector('.tm-system-table-card').style.display = list ? '' : 'none';
        const filtering = words.length > 0 || active.length > 0;
        setText(count, filtering ? `${shown} of ${total} systems` : `${total} systems`);

        const toggle = wrapper.querySelector('.tm-view-toggle');
        const icon = toggle.querySelector('i');
        const iconClass = list ? 'fa-solid fa-grip' : 'fa-solid fa-list';
        if (icon.className !== iconClass) icon.className = iconClass;
        setText(toggle.querySelector('span'), list ? 'Tile view' : 'List view');

        if (list) {
            fitColumnsToContent(table);
            fitListHeight();
        }
    }

    // The page area has a fixed height and doesn't scroll along with the
    // list, so the list scrolls itself: as tall as the space from its top
    // to the bottom of the visible page area (or the window).
    function fitListHeight() {
        if (!systemList) return;
        const scroller = systemList.wrapper.querySelector('.tm-system-scroller');
        const top = scroller.getBoundingClientRect().top;

        let bottom = window.innerHeight;
        for (let el = systemList.wrapper.parentElement; el && el !== document.body; el = el.parentElement) {
            const style = getComputedStyle(el);
            if (style.overflowY !== 'visible') {
                const rect = el.getBoundingClientRect();
                bottom = Math.min(bottom, rect.bottom - (parseFloat(style.paddingBottom) || 0));
                break;
            }
        }

        const margin = 12; // card margin + border
        const height = `${Math.max(200, Math.floor(bottom - top - margin))}px`;
        if (scroller.style.maxHeight !== height) scroller.style.maxHeight = height;
    }

    function createSystemListWrapper() {
        const wrapper = document.createElement('div');
        wrapper.className = SYSTEM_LIST_CLASS;

        const toolbar = document.createElement('div');
        toolbar.className = 'tm-system-toolbar';

        const search = createSearchInput(applySystemsView);
        search.style.width = '250px';

        const count = document.createElement('small');
        count.className = 'text-muted';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn btn-default btn-xs tm-view-toggle';
        toggle.append(document.createElement('i'), ' ', document.createElement('span'));
        toggle.addEventListener('click', () => {
            GM_setValue(VIEW_KEY, isListView() ? 'tiles' : 'list');
            applySystemsView();
        });

        toolbar.append(search, count, toggle);

        const card = document.createElement('div');
        card.className = 'card tm-system-table-card';
        const scroller = document.createElement('div');
        scroller.className = 'tm-system-scroller';
        const table = document.createElement('table');
        table.className = 'table table-hover';
        table.appendChild(document.createElement('tbody'));
        scroller.appendChild(table);
        card.appendChild(scroller);

        wrapper.append(toolbar, card);
        return { wrapper, table, search, count };
    }

    // Rebuild the rows (and the header, if the columns changed) from the tiles
    function renderSystemList() {
        if (!systemList) return;
        const rows = [...document.querySelectorAll(SYSTEM_TILE)].map(readTile);
        const signature = systemsSignature(rows);

        if (signature !== systemList.signature) {
            systemList.signature = signature;
            const model = columnModel(rows);
            const headSignature = JSON.stringify([model.infoLabels, model.actions]);
            if (headSignature !== systemList.headSignature) {
                systemList.headSignature = headSignature;
                buildSystemsHead(systemList.table, model);
            }
            const tbody = document.createElement('tbody');
            rows.forEach(r => tbody.appendChild(buildSystemRow(r, model)));
            systemList.table.querySelector('tbody').replaceWith(tbody);
        }

        applySystemsView();
    }

    function removeSystemList() {
        window.removeEventListener('resize', fitListHeight);
        systemList.observer.disconnect();
        systemList.wrapper.remove();
        systemList = null;
    }

    function setupSystemList() {
        // Left the page: clean up
        if (systemList && !systemList.container.isConnected) removeSystemList();

        const firstTile = document.querySelector(SYSTEM_TILE);
        if (!firstTile) return;
        const container = firstTile.parentElement;
        if (systemList?.container === container) return;
        if (systemList) removeSystemList();

        const parts = createSystemListWrapper();
        container.before(parts.wrapper);

        // If the tiles sit in a flex row, the list takes a full row of its
        // own, and the row may wrap so the list doesn't squeeze the tiles.
        // (Not in a flex column: there flex-basis 100% would mean the full
        // height, pushing the tiles out of view in tile view.)
        const parentStyle = getComputedStyle(container.parentElement);
        if (parentStyle.display.includes('flex') && parentStyle.flexDirection.startsWith('row')) {
            parts.wrapper.style.flexBasis = '100%';
            if (parentStyle.flexWrap === 'nowrap') container.parentElement.style.flexWrap = 'wrap';
        }

        // Re-read the tiles whenever HelloID changes them (counts, dates,
        // progress). Text changes don't show up in the page-wide observer.
        let pending = false;
        const observer = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                renderSystemList();
            });
        });
        observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['src', 'd', 'title', 'class'],
        });

        systemList = { container, observer, signature: null, headSignature: null, ...parts };
        window.addEventListener('resize', fitListHeight);
        renderSystemList();
    }

    // =====================================================================
    // All grids: resizable columns
    // =====================================================================

    // Every AG Grid table in HelloID, on any page or tab
    const AG_GRIDS = 'ag-grid-angular';

    const isGridApi = (a) => a && typeof a.getColumnDefs === 'function';

    // Grid API reachable from an AG Grid object, if any. Where exactly it
    // lives depends on the AG Grid version, so try the known places.
    function gridApiFrom(o) {
        if (!o || typeof o !== 'object') return null;
        let fromBean;
        try { fromBean = o.getBean?.('gridApi') ?? o.context?.getBean?.('gridApi'); } catch { /* no such bean */ }
        const candidates = [
            o,
            o.api,
            o.gridApi,
            o.beans?.gridApi,                       // v32+
            o.gos?.api,                             // v31
            o.gridOptionsService?.api,              // v29-v30
            o.gridOptionsWrapper?.gridOptions?.api, // older
            o.gridOptions?.api,
            fromBean,
        ];
        return candidates.find(isGridApi) ?? null;
    }

    // AG Grid stores its objects on DOM elements under keys like
    // "__ag_grid_instance" and "__AG_<random>" (the latter holds e.g. the
    // header cell component). Search those, one level deep.
    function findGridApi(gridEl) {
        const els = [gridEl, ...gridEl.querySelectorAll('.ag-root-wrapper, .ag-header-cell')];
        for (const el of els) {
            for (const key of Object.keys(el)) {
                if (!/^__ag/i.test(key)) continue;
                const value = el[key];
                const api = gridApiFrom(value) ??
                    (value && typeof value === 'object'
                        ? Object.values(value).map(gridApiFrom).find(Boolean)
                        : null);
                if (api) return api;
            }
        }
        return null;
    }

    function needsResizable(defs) {
        return defs.some(d => d.children
            ? needsResizable(d.children)
            : d.resizable !== true || d.minWidth != null || d.maxWidth != null);
    }

    // Some columns are fixed-width (minWidth === maxWidth), which blocks
    // resizing even with resizable: true. Drop both limits; each column
    // keeps its current width as starting point.
    function withResizable(defs) {
        return defs.map(d => d.children
            ? { ...d, children: withResizable(d.children) }
            : { ...d, resizable: true, minWidth: undefined, maxWidth: undefined });
    }

    // Set while we update the columns, so the resulting newColumnsLoaded
    // event doesn't trigger another update (endless loop if the grid puts
    // a default minWidth back).
    let applyingResizable = false;

    function applyResizable(api) {
        if (applyingResizable) return;
        const defs = api.getColumnDefs();
        if (!defs || !needsResizable(defs)) return;
        const newDefs = withResizable(defs);
        applyingResizable = true;
        try {
            if (typeof api.setGridOption === 'function') {
                api.setGridOption('columnDefs', newDefs); // v31+
            } else {
                api.setColumnDefs(newDefs);
            }
        } finally {
            applyingResizable = false;
        }
    }

    const STYLE_ID = 'tm-helloid-ux-styles';

    // Line on the right edge of each header cell, where the resize handle
    // is. An inset shadow instead of a border, so the cell size doesn't change.
    const HEADER_SEPARATOR = 'inset -1px 0 0 #f0f0f0';

    const STYLES = `
        ${AG_GRIDS} .ag-header-cell {
            box-shadow: ${HEADER_SEPARATOR};
        }

        /* Target systems list view: full width, only as tall as its content
           (in a flex row, setupSystemList() also gives it a row of its own) */
        .${SYSTEM_LIST_CLASS} {
            width: 100%;
            flex: 0 0 auto;
        }
        .tm-system-toolbar {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
        }
        .tm-system-toolbar .tm-view-toggle { margin-left: auto; }
        /* Two classes, so it wins over HelloID's own .card width */
        .${SYSTEM_LIST_CLASS} .tm-system-table-card {
            width: 100%;
            box-sizing: border-box;
            padding: 0;
            margin-bottom: 10px;
        }
        /* Scrolls both ways; the height is set by fitListHeight() */
        .tm-system-scroller { overflow: auto; }
        .${SYSTEM_LIST_CLASS} table {
            table-layout: fixed;
            width: 100%;
            margin-bottom: 0;
        }
        /* Positioning context for the pinned buttons */
        .${SYSTEM_LIST_CLASS} td { position: relative; }
        .${SYSTEM_LIST_CLASS} th,
        .${SYSTEM_LIST_CLASS} td {
            vertical-align: middle !important;
            text-align: left;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        /* Narrow number/icon columns: centered, little side padding, and
           no "..." (a short number never needs it) */
        .${SYSTEM_LIST_CLASS} th.tm-center,
        .${SYSTEM_LIST_CLASS} td.tm-center {
            text-align: center !important;
            padding-left: 2px !important;
            padding-right: 2px !important;
            text-overflow: clip;
        }
        /* Header stays visible while scrolling. Sticky is also the
           positioning context for the resize handles. The bottom line is
           a shadow too: a table border would scroll away with the rows. */
        .${SYSTEM_LIST_CLASS} th {
            position: sticky;
            top: 0;
            z-index: 2;
            color: #000 !important; /* HelloID's table headers are grey */
            background-color: #fff;
            box-shadow: ${HEADER_SEPARATOR}, inset 0 -2px 0 #ddd;
        }
        .${RESIZE_HANDLE_CLASS} {
            position: absolute;
            top: 0;
            right: 0;
            width: 6px;
            height: 100%;
            cursor: col-resize;
            z-index: 1;
        }
        .${SYSTEM_LIST_CLASS} .tm-system-icon {
            width: 20px !important;
            height: 20px !important;
            object-fit: contain;
            vertical-align: middle;
            margin-right: 6px;
        }
        .${SYSTEM_LIST_CLASS} .tm-system-extras {
            display: inline-flex;
            vertical-align: middle;
            margin-left: 6px;
        }
        .tm-progress { display: flex; align-items: center; gap: 6px; }
        .tm-progress .progress { flex: 1; height: 10px; margin: 0; }

        /* Filter panels show all items now (see the slice patch), so the
           "Maximum of 50 entries shown" warning no longer applies. */
        helloid-filter-panels i.fa-warning[title^="Maximum of ${FILTER_PANEL_LIMIT} entries"] {
            display: none;
        }
    `;

    function addStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLES;
        (document.head ?? document.documentElement).appendChild(style);
    }

    const resizableGrids = new WeakSet();

    function makeGridsResizable() {
        document.querySelectorAll(AG_GRIDS).forEach(gridEl => {
            if (resizableGrids.has(gridEl)) return;

            const api = findGridApi(gridEl);
            if (!api) return; // grid not ready yet; the observer will retry

            resizableGrids.add(gridEl);
            applyResizable(api);
            // If the page sets new columns later, make those resizable too
            api.addEventListener?.('newColumnsLoaded', () => applyResizable(api));
        });
    }

    // =====================================================================
    // Filters reset on navigation
    // =====================================================================
    // Filters belong to the page they were set on. They survive our own
    // reloads (the Entitlements filters reload the page), but start off
    // on any other page. The filters and their page are kept in
    // sessionStorage, per browser tab, so a new tab or browser session
    // starts without filters, and tabs don't reset each other's filters.

    const FILTER_PAGE_KEY = 'tm-helloid-filter-page';

    // The page, without query parameters other than the tab, e.g.
    // "/provisioning/#/target/systems/<id>|Entitlements"
    function pageKey() {
        const [route, query = ''] = location.hash.split('?');
        const tab = new URLSearchParams(query).get('tab') ?? '';
        return `${location.pathname}${route}|${tab}`;
    }

    function syncFiltersWithPage() {
        const key = pageKey();
        if (sessionGet(FILTER_PAGE_KEY, null) === key) return;
        sessionSet(FILTER_PAGE_KEY, key);

        // Entitlements filters (the object is shared, so clear it in place)
        if (Object.keys(filterState).length) {
            Object.keys(filterState).forEach(k => delete filterState[k]);
            saveState(filterState);
            // Redraw the buttons, if they're on the page already
            document.getElementById(FILTER_DIV_ID)?.remove();
        }

        // Target systems list: symbol filters
        if (activeFlags().length) {
            sessionSet(FLAG_FILTERS_KEY, []);
            applySystemsView();
        }
    }

    // Watch the DOM: whenever a page is (re)rendered without our buttons,
    // add them. Covers the initial load and SPA navigation.
    function startObserver() {
        let pending = false;
        const observer = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                syncFiltersWithPage();
                if (isEntitlementsPage()) addFilterOptions();
                addStyles();
                addCopyButtons();
                setupSystemList();
                addFilterPanelSearch();
                makeGridsResizable();
            });
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.documentElement) {
        startObserver();
    } else {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    }
})();
