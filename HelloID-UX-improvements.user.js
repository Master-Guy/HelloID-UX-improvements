// ==UserScript==
// @name         HelloID UX improvements
// @version      2026-10-02.2
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
        // Grids that are fetched in full (see INTERCEPTS): number of rows
        // requested from the server in one go.
        // Must be higher than the number of rows in any of these grids.
        fetchAllTake: 999999,

        // The same grids: how long fetched rows are reused (minutes)
        // before they are fetched again
        cacheMaxAgeMinutes: 5,

        // Entitlements tab: wait this long after the last filter click
        // before reloading, so several buttons can be set in one go.
        filterReloadDelayMs: 1500,

        // Copy buttons: how long the check/cross is shown after copying
        copyFeedbackMs: 1000,

        // Target system export: also write the values of password fields
        // to the file. Off: those values are replaced by "***".
        exportSecrets: false,
    });

    const SETTINGS_KEY = 'settings';

    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    // Defaults + stored overrides. Nested objects are
    // merged too, so overriding one value in them keeps the others.
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
    const parseYesNo = (v) => (/^(yes|true|1)$/i.test(v) ? true : /^(no|false|0)$/i.test(v) ? false : undefined);

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
            label: 'Grids: max rows to fetch',
            description: 'Number of rows requested from the server in one go, for the grids that are fetched ' +
                         'in full (entitlements, evaluation actions). Must be higher than the number of rows in any of them.',
            parse: parsePositiveInt,
            hint: 'a whole number',
        },
        {
            path: 'cacheMaxAgeMinutes',
            label: 'Grids: cache duration (minutes)',
            description: 'How long the rows of the grids that are fetched in full are reused while scrolling and ' +
                         'filtering, before they are fetched from the server again. ' +
                         'Navigating to another page always fetches fresh rows.',
            parse: parsePositiveInt,
            hint: 'a whole number of minutes',
        },
        {
            path: 'exportSecrets',
            label: 'Target system export: include secrets',
            description: 'Whether the export of a target system also contains the values of its password fields ' +
                         '(e.g. an app secret). With "no", those values are replaced by "***". ' +
                         'Secrets typed into the scripts themselves are always exported.',
            parse: parseYesNo,
            hint: 'yes or no',
        },
        {
            path: 'filterReloadDelayMs',
            label: 'Target system entitlements: filter reload delay (ms)',
            description: 'Target system > Entitlements tab: how long to wait after the last click on a filter button before the page reloads, ' +
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

    // Color of a filter or sort button, per status
    const statusColor = {
        [ButtonStatus.UNKNOWN]:  '#cdcdcd', // off: not filtering
        [ButtonStatus.ENABLED]:  'black',   // on: only the rows that have it
        [ButtonStatus.DISABLED]: 'red',     // inverted: only the rows that don't have it
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

    // Pages (part of their address, after the #)
    const ENTITLEMENTS_ROUTE = '/business/entitlements';
    const EVALUATIONS_ROUTE = '/business/evaluations';
    const AUDIT_LOGS_ROUTE = '/persons/overview?tab=Audit';
    const NOTIFICATIONS_ROUTE = '/notifications/configurations';
    const PERSON_RULES_ROUTE = '/persons/overview?tab=Rules';
    const PERSON_RULES_GRID = 'Condition Summary'; // a header only this grid has

    // Paged requests that are fetched in full instead, so they can be
    // filtered here; the app then gets only the page it asked for.
    // filter: all rows -> the rows to show
    // grid: the grid showing these rows, if known (for its loading overlay)
    // limitWarning: text of the page's "only the first N rows" warning,
    //   which no longer applies once all rows are fetched
    // route: only on pages with this in their address
    const INTERCEPTS = [
        // Target system > Entitlements tab
        { pattern: /\/entitlements-overview(\?|$)/, filter: (all) => all.filter(matchesFilters) },
        // Business rules > Entitlements tab
        {
            pattern: /\/rules\/api\/entitlements(\?|$)/,
            filter: (all) => filterByFlags(FLAG_GRIDS.entitlements, all),
            grid: 'helloid-entitlement-grid ag-grid-angular',
        },
        // Business rules > Evaluations: actions of the selected evaluation
        {
            pattern: /\/rule-enforcement\/api\/evaluation-report\/[^/?]+(\?|$)/,
            filter: (all) => filterByFlags(FLAG_GRIDS.actions, all),
            grid: 'helloid-tab-control ag-grid-angular',
        },
        // Entitlements > Granted tab
        {
            pattern: new RegExp('/rule-enforcement/api/enforcedstate/granted([?]|$)'),
            filter: (all) => all,
            limitWarning: 'will only show the first',
        },
        // Persons > Rules tab (the Business rules page uses the same
        // request, and is left alone)
        {
            pattern: new RegExp('/rules/api/rules/published([?]|$)'),
            filter: (all) => filterPersonRules(all),
            route: PERSON_RULES_ROUTE,
        },
    ];
    const onPage = (route) => !route || location.hash.includes(route);
    const interceptFor = (url) => INTERCEPTS.find(i => i.pattern.test(url) && onPage(i.route));

    // HelloID's API server, as seen in its own requests: where it is and
    // the headers (login) to send along. For requests of our own.
    let gateway = null; // { origin, headers, withCredentials }
    const isGatewayUrl = (url) => {
        try { return /gateway/i.test(new URL(url, location.href).hostname); } catch { return false; }
    };

    // Responses that are only read, not changed. onData: the parsed response
    const WATCHES = [
        // Persons > Rules tab: the IDs of the rules the selected person is in
        {
            pattern: new RegExp('/evaluation/results/person/[^/?]+/rules([?]|$)'),
            onData: (ids) => onPersonRules(ids),
        },
        // Target systems: the IDs of the systems (for the export's file name)
        {
            pattern: new RegExp('/provisioning-api/api/target-systems([?]|$)'),
            onData: (systems) => rememberSystemIds(systems),
        },
    ];
    const watchFor = (url) => WATCHES.find(w => w.pattern.test(url));

    function watched(watch, raw) {
        if (raw == null || raw === '') return; // no content
        try {
            watch.onData(typeof raw === 'string' ? JSON.parse(raw) : raw);
        } catch (e) {
            console.warn('[HelloID UX] Could not read response', e);
        }
    }

    // Field the grid uses to decide how many rows exist
    const COUNT_KEYS = ['totalRowCount'];

    // Full responses per query (the URL without skip/take): scrolling
    // through a grid fetches everything only once. Cleared on navigation.
    const CACHE_MAX_AGE_MS = SETTINGS.cacheMaxAgeMinutes * 60 * 1000;
    const fullResponses = new Map(); // key -> { data, time, ready, resolve }

    function queryKey(url) {
        const u = new URL(url, location.href);
        u.searchParams.delete('skip');
        u.searchParams.delete('take');
        u.searchParams.delete('cachebust'); // changes with every request
        u.searchParams.sort();
        return u.toString();
    }

    // Which page the app wants, and where the full data comes from. The
    // first request for a query fetches everything ("loads"). Later ones
    // wait for that, if needed, and are sent as a 1-row request: they keep
    // the app's own request (with its login headers), but the answer comes
    // from the cache.
    function rewriteUrl(url) {
        // Before filtering: drop filters (and cached data) from another page
        syncFiltersWithPage();

        const u = new URL(url, location.href);
        const skip = parseInt(u.searchParams.get('skip'), 10) || 0;
        const takeParam = u.searchParams.get('take');
        const key = queryKey(url);

        let entry = fullResponses.get(key);
        if (entry?.data && Date.now() - entry.time > CACHE_MAX_AGE_MS) {
            fullResponses.delete(key);
            entry = null;
        }
        const loads = !entry;
        if (loads) {
            entry = { data: null, time: 0 };
            entry.ready = new Promise(resolve => { entry.resolve = resolve; });
            fullResponses.set(key, entry);
            showLoadingWhile(entry.ready, interceptFor(url).grid);
        }

        u.searchParams.set('skip', '0');
        u.searchParams.set('take', loads ? String(SETTINGS.fetchAllTake) : '1');
        return {
            skip,
            take: takeParam === null ? Infinity : (parseInt(takeParam, 10) || Infinity),
            intercept: interceptFor(url),
            key,
            entry,
            loads,
            url: u.toString(),
        };
    }

    // The answer for the app: the full data, filtered, and only the page it
    // asked for. raw is the response body (text or parsed JSON); errors are
    // passed on unchanged.
    function respond(raw, page, ok) {
        const { entry } = page;
        if (page.loads && !page.done) {
            page.done = true;
            if (ok) {
                try {
                    entry.data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    entry.time = Date.now();
                } catch (e) {
                    console.warn('Could not read response', e);
                }
            }
            if (!entry.data) fullResponses.delete(page.key);
            entry.resolve(); // let the waiting requests go
        }
        if (!ok || !entry.data) return raw;
        const result = modifyData({ ...entry.data }, page);
        return typeof raw === 'string' ? JSON.stringify(result) : result;
    }

    // A full fetch can take a while. Meanwhile the grid only shows empty
    // rows, so show its "Loading" overlay on top: the same one the grid
    // shows on its first load. The grid is the intercept's own, if known;
    // otherwise the one showing loading rows (AG Grid marks rows that
    // wait for data with ag-row-loading).
    function showLoadingWhile(ready, gridSelector) {
        let done = false;
        ready.then(() => { done = true; });
        setTimeout(() => { // the grid draws its loading rows around the request
            if (done) return;
            const grids = gridSelector
                ? [...document.querySelectorAll(gridSelector)]
                : [...document.querySelectorAll(AG_GRIDS)].filter(g => g.querySelector('.ag-row-loading'));
            const apis = grids.map(findGridApi).filter(Boolean);
            apis.forEach(api => setGridLoading(api, true));
            // After the grid got its rows
            ready.then(() => setTimeout(() => apis.forEach(api => setGridLoading(api, false))));
        }, 100);
    }

    // HelloID uses AG Grid v32+, with the "loading" option: it keeps the
    // overlay up until turned off, even while the grid updates its rows.
    // Afterwards it goes back to undefined (not false, which would block
    // the grid's own loading overlay from then on).
    function setGridLoading(api, on) {
        try {
            api.setGridOption('loading', on ? true : undefined);
        } catch (e) {
            console.warn('[HelloID UX] Could not toggle the loading overlay', e);
        }
    }

    // Filter the full set, then hand the app only the page it asked for.
    function modifyData(data, page) {
        if (!Array.isArray(data?.pageData)) return data;

        // Fewer rows than asked for: that's all of them
        const { intercept } = page;
        if (intercept.limitWarning) {
            intercept.complete = data.pageData.length < SETTINGS.fetchAllTake;
            if (intercept.complete && data.exceededTotalRowCountLimit === true) {
                data.exceededTotalRowCountLimit = false;
            }
        }

        const filtered = page.intercept.filter(data.pageData);
        data.pageData = filtered.slice(page.skip, page.skip + page.take);

        for (const key of COUNT_KEYS) {
            if (typeof data[key] === 'number') data[key] = filtered.length;
        }
        return data;
    }

    // Hide the page's "only the first N rows" warnings that no longer apply
    function hideLimitWarnings() {
        const texts = INTERCEPTS.filter(i => i.limitWarning && i.complete).map(i => i.limitWarning);
        if (!texts.length) return;
        document.querySelectorAll('.alert.alert-warning').forEach(alert => {
            if (alert.style.display !== 'none' && texts.some(t => alert.textContent.includes(t))) {
                alert.style.display = 'none';
            }
        });
    }

    // --- fetch ---
    const origFetch = pageWindow.fetch;
    pageWindow.fetch = async function (input, init) {
        const url = input instanceof pageWindow.Request ? input.url : String(input);
        const watch = watchFor(url);
        if (watch) {
            const response = await origFetch.call(this, input, init);
            if (response.ok) response.clone().text().then(text => watched(watch, text), () => {});
            return response;
        }
        if (!interceptFor(url)) return origFetch.call(this, input, init);

        const page = rewriteUrl(url);
        if (!page.loads) await page.entry.ready;

        try {
            const newInput = input instanceof pageWindow.Request ? new pageWindow.Request(page.url, input) : page.url;
            const response = await origFetch.call(this, newInput, init);

            const text = await response.clone().text();
            const body = respond(text, page, response.ok);
            if (body === text) return response;
            const modified = new pageWindow.Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
            Object.defineProperty(modified, 'url', { value: url });
            return modified;
        } catch (e) {
            respond(null, page, false); // don't leave waiting requests hanging
            throw e;
        }
    };

    // --- XMLHttpRequest ---
    const proto = pageWindow.XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    const origSetRequestHeader = proto.setRequestHeader;
    const origResponse = Object.getOwnPropertyDescriptor(proto, 'response').get;
    const origResponseText = Object.getOwnPropertyDescriptor(proto, 'responseText').get;

    proto.setRequestHeader = function (name, value) {
        if (this._tmHeaders) this._tmHeaders[name] = String(value);
        return origSetRequestHeader.call(this, name, value);
    };

    proto.open = function (method, url, ...rest) {
        const s = String(url);
        delete this._tmResult;
        this._tmHeaders = {};
        this._tmUrl = s;
        if (interceptFor(s)) {
            this._tmPage = rewriteUrl(s);
            if (this._tmPage.loads) {
                // Also when the app never reads the answer (error, abort):
                // let the waiting requests go
                this.addEventListener('loadend', () => getModified(this), { once: true });
            }
            return origOpen.call(this, method, this._tmPage.url, ...rest);
        }
        this._tmPage = null;
        // Listen once per request object; it may be opened again
        this._tmWatch = watchFor(s);
        if (this._tmWatch && !this._tmWatching) {
            this._tmWatching = true;
            this.addEventListener('load', () => {
                if (this._tmWatch && this.status >= 200 && this.status < 300) {
                    watched(this._tmWatch, origResponse.call(this));
                }
            });
        }
        return origOpen.call(this, method, url, ...rest);
    };

    // A request that is answered from the cache waits until the full data
    // is there
    proto.send = function (...args) {
        // Remember how HelloID talks to its API server
        const headers = this._tmHeaders ?? {};
        if (isGatewayUrl(this._tmUrl) && Object.keys(headers).some(h => /^authorization$/i.test(h))) {
            gateway = {
                origin: new URL(this._tmUrl, location.href).origin,
                headers: Object.fromEntries(Object.entries(headers).filter(([h]) => !/^content-type$/i.test(h))),
                withCredentials: this.withCredentials,
            };
        }

        const page = this._tmPage;
        if (page && !page.loads && !page.entry.data) {
            page.entry.ready.then(() => origSend.apply(this, args));
            return;
        }
        return origSend.apply(this, args);
    };

    function getModified(xhr) {
        if (!('_tmResult' in xhr)) {
            const ok = xhr.status >= 200 && xhr.status < 300;
            xhr._tmResult = respond(origResponse.call(xhr), xhr._tmPage, ok);
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

    // --- Target systems overview: tiles (copy and export buttons) ---
    function addSystemTileCopyButtons() {
        document.querySelectorAll('helloid-provisioning-system-tile').forEach(tile => {
            if (tile.querySelector(`.${COPY_BTN_CLASS}`)) return;

            const configureBtn = tile.querySelector('button[title="configure" i]');
            if (!configureBtn) return;

            // The name at click time: HelloID may reuse a tile for another system
            const name = () => tile.querySelector('h5')?.innerText.trim() ?? '';
            configureBtn.before(
                createCopyButton(name, configureBtn.className),
                createExportButton(name, configureBtn.className),
                createExportButton(name, configureBtn.className, EXPORT_KINDS.granted),
            );
        });
    }

    // --- Business rules: name columns in grids ---
    // Grids (by their host element) and the column that gets a copy
    // button: by column ID, or by header text when the ID isn't known.
    // route: only on pages with this in their address (for hosts that
    // are used on many pages). Without host: any grid on that page.
    // requires: only grids that also have a column with this header.
    const NAME_COLUMNS = [
        { host: 'helloid-rules-grid', colId: 'name' },          // Rules tab
        // Its persons: a single column without a header, so any column
        { host: 'helloid-stored-persons-in-rule', header: null },
        // Entitlements tab, details of the selected entitlement
        { host: 'helloid-entitlement-details', colId: 'name' }, // its Rules tab
        { host: 'helloid-entitlement-details', header: 'Person' }, // its Persons tab
        // Evaluations: actions of the selected evaluation
        ...['System', 'Person', 'Entitlement name'].map(header => (
            { host: 'helloid-tab-control', header, route: EVALUATIONS_ROUTE })),
        // Entitlements: Granted and History tabs
        ...['System', 'Person', 'Entitlement name'].map(header => (
            { header, route: ENTITLEMENTS_ROUTE })),
        // Persons > Audit logs
        ...['System', 'Message'].map(header => ({ header, route: AUDIT_LOGS_ROUTE })),
        // Notifications > Configurations
        ...['Name', 'System'].map(header => ({ header, route: NOTIFICATIONS_ROUTE })),
        // Persons > Rules
        { header: 'Name', route: PERSON_RULES_ROUTE, requires: PERSON_RULES_GRID },
    ];

    const headerTexts = (grid) => [...grid.querySelectorAll('.ag-header-cell')]
        .map(h => h.textContent.trim().toLowerCase());
    const hasHeader = (grid, header) => !header || headerTexts(grid).includes(header.toLowerCase());

    // Body cells of the name columns, in all grids on the page
    function nameCells() {
        const here = NAME_COLUMNS.filter(c => !c.route || location.hash.includes(c.route));
        return here.flatMap(({ host, colId, header, requires }) =>
            [...document.querySelectorAll(`${host ?? ''} ag-grid-angular`)].flatMap(grid => {
                if (!hasHeader(grid, requires)) return [];
                const rows = 'div.ag-body-viewport div[role="row"]';
                // Any column: the grid may have no header at all
                if (!colId && header == null) return [...grid.querySelectorAll(`${rows} div[col-id]`)];
                const ids = colId ? [colId]
                    : [...grid.querySelectorAll('.ag-header-cell')]
                        .filter(h => h.textContent.trim().toLowerCase() === header.toLowerCase())
                        .map(h => h.getAttribute('col-id'));
                return ids.flatMap(id => [...grid.querySelectorAll(
                    `${rows} div[col-id="${CSS.escape(id)}"]`)]);
            }));
    }

    // Text of the cell without our own button. Cells with a second,
    // smaller line (a description under the name): only the first line.
    function cellTextWithout(cell, btn) {
        const firstLine = cell.querySelector('.truncate-ellipse');
        if (firstLine) return firstLine.innerText ?? firstLine.textContent;
        return [...cell.childNodes]
            .filter(n => n !== btn)
            .map(n => n.innerText ?? n.textContent)
            .join('');
    }

    function addRuleGridCopyButtons() {
        nameCells().forEach(cell => {
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

    const PINNED_CLASS = 'tm-pinned-buttons';

    // Pin one or more small buttons to the right edge of a cell
    function pinButtons(cell, ...buttons) {
        const group = document.createElement('span');
        group.className = PINNED_CLASS;
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

    // Sortable columns: the name, and these info columns (dates). Each has
    // a sort button in its header: an up-down arrows icon (not sorted on this column), ▼ or ▲.
    // HelloID's own order is by name, ascending: that's the default.
    const SORTABLE_LABELS = new Set(['Summary since', 'Last updated']);
    const NAME_SORT_KEY = 'name';
    const DEFAULT_SORT = Object.freeze({ column: NAME_SORT_KEY, dir: 'asc' });
    const SORT_KEY = 'tm-helloid-system-sort'; // in sessionStorage: { column, dir }, null = default

    const getSort = () => {
        const sort = sessionGet(SORT_KEY, null);
        return isPlainObject(sort) && sort.column && sort.dir ? sort : null;
    };
    const effectiveSort = () => getSort() ?? DEFAULT_SORT;

    // Dates like "04/09/2026, 7:26" or "4/9/26 7:26 PM" (or year first)
    const DATE_RE = /(\d{1,4})\D(\d{1,2})\D(\d{2,4})(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?m?\.?)?/i;

    // Day-month or month-day: from the dates themselves when one gives it
    // away (a number above 12), otherwise from the browser's locale
    function detectDateOrder(values) {
        for (const value of values) {
            const m = value.match(DATE_RE);
            if (!m || m[1].length === 4) continue;
            if (+m[1] > 12) return 'dmy';
            if (+m[2] > 12) return 'mdy';
        }
        const parts = new Intl.DateTimeFormat().formatToParts(new Date(2000, 11, 31))
            .map(p => p.type).filter(t => t === 'day' || t === 'month');
        return parts[0] === 'month' ? 'mdy' : 'dmy';
    }

    // Timestamp, or null for no date (e.g. "-")
    function parseDate(text, order) {
        const m = text.match(DATE_RE);
        if (!m) return null;
        const [, a, b, c, hour = '0', minute = '0', second = '0', ampm] = m;
        let [year, month, day] = a.length === 4 ? [a, b, c]
            : order === 'mdy' ? [c, a, b]
            : [c, b, a];
        year = +year < 100 ? 2000 + +year : +year;
        let h = +hour;
        if (ampm) h = (h % 12) + (/p/i.test(ampm) ? 12 : 0);
        return new Date(year, month - 1, +day, h, +minute, +second).getTime();
    }

    // Sort button. The first click on a date sorts descending, on the name
    // ascending (the default); every next click reverses the direction.
    // Back to the default: sort on the name. The look is updated in
    // applySystemsView().
    function createSortButton(key) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-default btn-xs';
        btn.dataset.sort = key;
        // Fixed width: the icon and ▲/▼ differ in width
        Object.assign(btn.style, {
            width: '22px',
            paddingLeft: '0',
            paddingRight: '0',
            textAlign: 'center',
        });
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const current = effectiveSort();
            let next = current.column !== key
                ? { column: key, dir: key === NAME_SORT_KEY ? 'asc' : 'desc' }
                : { column: key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
            // Name ascending is the default; stored as "no sort"
            if (next?.column === DEFAULT_SORT.column && next.dir === DEFAULT_SORT.dir) next = null;
            sessionSet(SORT_KEY, next);
            applySystemsView();
        });
        return btn;
    }

    // What a sort button shows: the up-down arrows icon. Not sorted on its
    // column: both arrows the same. Sorted: the duotone version, with the
    // arrow of the direction dark and the other one light. Without the
    // duotone font on the page: ▲ or ▼ instead.
    const SORT_ICON = 'fa-arrow-down-arrow-up';
    // The direction of the arrow that the duotone icon shows dark by
    // default (its "primary" layer); fa-swap-opacity shows the other dark
    const SORT_ICON_PRIMARY = 'asc';

    let duotoneFont; // is there a Font Awesome duotone font? Remembered once found
    const hasDuotoneFont = () =>
        duotoneFont ||= [...document.fonts].some(f => /duotone/i.test(f.family));

    function setSortIndicator(btn, dir) {
        if (dir && !hasDuotoneFont()) {
            setText(btn, dir === 'asc' ? '▲' : '▼');
            return;
        }
        const className = !dir ? `fa-solid ${SORT_ICON}`
            : `fa-duotone ${SORT_ICON}${dir === SORT_ICON_PRIMARY ? '' : ' fa-swap-opacity'}`;
        let icon = btn.querySelector('i');
        if (!icon) {
            icon = document.createElement('i');
            btn.replaceChildren(icon);
        }
        if (icon.className !== className) icon.className = className;
    }

    // Put the rows in the chosen order. By name: HelloID's order (which is
    // by name), or exactly that reversed. By date: empty values (no date)
    // always last, ties in HelloID's order. Only touches the DOM when the
    // order changes.
    function sortSystemRows(table) {
        const tbody = table.querySelector('tbody');
        const rows = [...tbody.children];
        const sort = effectiveSort();
        const byName = sort.column === NAME_SORT_KEY;
        const column = byName ? -1
            : [...table.querySelectorAll('thead th')].findIndex(th => th.dataset.sortKey === sort.column);

        const sorted = [...rows].sort((a, b) => {
            const ia = +a.dataset.index;
            const ib = +b.dataset.index;
            if (byName) return sort.dir === 'desc' ? ib - ia : ia - ib;
            if (column >= 0) {
                const va = a.children[column]?.dataset.sortValue ?? '';
                const vb = b.children[column]?.dataset.sortValue ?? '';
                if (!va !== !vb) return va ? -1 : 1;
                if (va) {
                    const c = Number(va) - Number(vb);
                    if (c) return sort.dir === 'desc' ? -c : c;
                }
            }
            return ia - ib;
        });

        if (sorted.some((tr, i) => tr !== rows[i])) tbody.append(...sorted);
    }

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
            dateOrder: detectDateOrder(rows.flatMap(r => r.info
                .filter(i => SORTABLE_LABELS.has(i.label)).map(i => i.value))),
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

    // Width a cell needs for its text on one line, plus its padding (which
    // includes the room reserved for pinned buttons). The text is measured
    // as laid out in the cell: the "..." is only drawn over that, so this is
    // the full width, also when cut off. (scrollWidth leaves out the right
    // padding then.)
    const measureRange = document.createRange();

    function neededWidth(cell) {
        let textWidth = 0;
        cell.childNodes.forEach(n => {
            if (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim()) return;
            measureRange.selectNodeContents(n);
            textWidth += measureRange.getBoundingClientRect().width;
        });
        const style = getComputedStyle(cell);
        const extra = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
            .reduce((sum, p) => sum + (parseFloat(style[p]) || 0), 0);
        return Math.ceil(textWidth + extra) + 2; // +2: rounding
    }

    // Line the header buttons up with the header text: the text doesn't sit
    // in the middle of the cell, so centering the buttons on the cell puts
    // them off. Measure where the buttons actually are and move them by the
    // difference, which also covers any margins HelloID's button styles add.
    function alignHeaderButtons(table) {
        table.querySelectorAll('thead th').forEach(th => {
            const group = th.querySelector(`.${PINNED_CLASS}`);
            const button = group?.querySelector('button');
            const text = [...th.childNodes]
                .find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
            if (!button || !text) return;
            measureRange.selectNodeContents(text);
            const textRect = measureRange.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            if (!textRect.height || !buttonRect.height) return; // not visible
            const delta = (textRect.top + textRect.height / 2) - (buttonRect.top + buttonRect.height / 2);
            if (Math.abs(delta) < 0.5) return;
            // offsetTop: the current "top" in px (transforms not included)
            group.style.top = `${Math.round((group.offsetTop + delta) * 2) / 2}px`;
        });
    }

    // Widen the fit-to-content columns to their widest header or value.
    // Skipped once the user resized a column, and while the list is hidden
    // (nothing to measure).
    function fitColumnsToContent(table) {
        if (table.dataset.frozen || !table.offsetParent) return;
        const cols = [...table.querySelectorAll('col')];
        const rows = [...table.querySelectorAll('tbody tr')];
        let changed = false;
        table.querySelectorAll('thead th').forEach((th, i) => {
            if (!th.classList.contains(FIT_CLASS)) return;
            const cells = [th, ...rows.map(r => r.children[i]).filter(Boolean)];
            const needed = Math.max(...cells.map(neededWidth));
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

        // Name, with the symbol filter and sort buttons pinned right
        const nameTh = th('Name');
        nameTh.dataset.sortKey = NAME_SORT_KEY;
        pinButtons(nameTh, ...SYSTEM_FLAGS.map(createFlagButton), createSortButton(NAME_SORT_KEY));
        nameTh.style.paddingRight = '140px'; // room for the buttons with their counts
        headRow.appendChild(nameTh);
        model.infoLabels.forEach(l => {
            const label = LABEL_RENAMES[l] ?? l;
            const cell = th(label, l);
            cell.classList.add(FIT_CLASS);
            if (CENTERED_LABELS.has(label)) cell.classList.add('tm-center');
            if (SORTABLE_LABELS.has(l)) {
                // The button's room is reserved as padding, so fitting the
                // column to its header makes room for the button too
                cell.dataset.sortKey = l;
                pinButtons(cell, createSortButton(l));
            }
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

    // --- Export of a system's configuration ---
    // The Export button (list and tiles) saves what HelloID knows about one
    // target system in a single JSON file: its configuration, what its
    // type adds to that (e.g. the scripts of a PowerShell system), and the
    // business rules that have an entitlement for it. The data comes
    // straight from HelloID's API, with the login headers of HelloID's own
    // requests (see "gateway").

    // All target systems, with their general configuration (mapping,
    // correlation, thresholds, ...)
    const SYSTEMS_PATH = '/service/provisioning-api/api/target-systems?showReferenceSystems=true';

    // What else to fetch per type of target system (templateIdentifier):
    // name in the export -> path. "configuration" replaces the system's
    // entry from SYSTEMS_PATH (it has the same, and more). Other types
    // are exported with what all types have.
    const POWERSHELL_RESOURCES_PATH = (id) => `/connector/powershell-target/api/resources/${id}`;
    const powershellExport = (id) => ({
        configuration: `/connector/powershell-target/api/configuration/${id}`,
        defaultScripts: `/connector/powershell-target/api/configuration/${id}/default`,
        resources: POWERSHELL_RESOURCES_PATH(id),
    });
    // Parts that may fail to load without stopping the export: the file
    // then says which ones are missing (couldNotRead)
    const OPTIONAL_EXPORTS = new Set(['resources']);
    // PowerShell systems come in two types that work the same
    const CONNECTOR_EXPORTS = {
        'powershell-onpremise': powershellExport,
        'powershell-target': powershellExport,
        // Built-in Azure AD: its mapping, correlation and settings
        'azuread': (id) => ({
            configuration: `/connector/azure-active-directory/api/configuration/${id}`,
        }),
        // Built-in Active Directory: its containers, directories, Exchange
        // and other settings
        'activedirectory': (id) => ({
            configuration: `/connector/active-directory/api/configuration/${id}`,
        }),
    };

    // Message shown after saving the export, per type of target system
    const DEPRECATED_NOTICE = 'This system type is deprecated.\n\n' +
        'Recommendation: Migrate to a PowerShell v2 connector.';
    const EXPORT_NOTICES = {
        'azuread': 'This system type is deprecated. Its configuration was exported in full, but the file ' +
                   'cannot be imported.\n\nRecommendation: Migrate to a PowerShell v2 connector.',
        'activedirectory': DEPRECATED_NOTICE,
    };

    // The tags and agent pools whose agents run a system's on-premises
    // actions: read with GET, stored with POST
    const AGENT_SELECTION_PATH = (id) => `/service/agent-repository/api/agents/selected-agents/${id}`;
    // Two selections with the same tags and pools?
    const sameAgentSelection = (a, b) => {
        const keys = (selection) => (selection ?? []).map(s => `${s?.type}:${s?.value}`).sort().join();
        return keys(a) === keys(b);
    };

    const EXPORT_MASK = '***'; // instead of a secret, when not exported

    const RULE_ENTITLEMENT_FIELDS = FILTERS.map(f => f.field);

    // Values that are secrets: the password fields of the configuration
    // form, and any value whose name says so. The latter also covers
    // values of fields that are no longer in the form, which HelloID keeps.
    const SECRET_NAME = /secret|passw|pwd|token|api[-_]?key|private[-_]?key|certificate|credential/i;

    // The names of the values that are secrets
    function secretKeys(configuration) {
        if (!isPlainObject(configuration.scriptConfiguration)) return [];
        const passwordKeys = new Set((configuration.scriptConfigurationForm?.fields ?? [])
            .filter(f => f.templateOptions?.type === 'password')
            .map(f => f.key));
        return Object.keys(configuration.scriptConfiguration)
            .filter(key => passwordKeys.has(key) || SECRET_NAME.test(key));
    }

    const isFilled = (value) => typeof value === 'string' && value !== '';

    // Built-in types (e.g. Azure AD) have their settings in the
    // configuration itself, or in a group in it (exchangeConfiguration):
    // there, the texts (or empty values) whose name says they are secrets.
    // As [group, key]; group is null for the configuration itself.
    function settingSecretKeys(configuration) {
        const secretsOf = (values) => Object.keys(values)
            .filter(key => SECRET_NAME.test(key) && (values[key] === null || typeof values[key] === 'string'));
        return [
            ...secretsOf(configuration).map(key => [null, key]),
            ...Object.keys(configuration)
                // scriptConfiguration: see secretKeys
                .filter(group => group !== 'scriptConfiguration' && isPlainObject(configuration[group]))
                .flatMap(group => secretsOf(configuration[group]).map(key => [group, key])),
        ];
    }

    function maskSecrets(configuration) {
        const masked = { ...configuration };
        settingSecretKeys(configuration).forEach(([group, key]) => {
            if (group) {
                if (!isFilled(masked[group][key])) return;
                masked[group] = { ...masked[group], [key]: EXPORT_MASK };
            } else if (isFilled(masked[key])) {
                masked[key] = EXPORT_MASK;
            }
        });
        const keys = secretKeys(configuration);
        if (keys.length) {
            masked.scriptConfiguration = { ...configuration.scriptConfiguration };
            keys.forEach(key => {
                if (isFilled(masked.scriptConfiguration[key])) masked.scriptConfiguration[key] = EXPORT_MASK;
            });
        }
        return masked;
    }

    // Which values are secrets, and whether HelloID returned one: also in
    // a file without the secrets themselves
    const listSecrets = (configuration) => [
        ...settingSecretKeys(configuration).map(([group, key]) => (group
            ? { key: `${group}.${key}`, hasValue: isFilled(configuration[group][key]) }
            : { key, hasValue: isFilled(configuration[key]) })),
        ...secretKeys(configuration)
            .map(key => ({ key, hasValue: isFilled(configuration.scriptConfiguration[key]) })),
    ];

    // --- Other systems that use the exported one ---
    // A system is used by another one that depends on it ("Depends on
    // systems"), or that names its accounts in a mapping or a script:
    // Person.Accounts._<system ID without dashes>. A replacement of the
    // system has another ID, so those have to be changed along.

    const accountsReference = (systemId) => `_${String(systemId).replace(/-/g, '')}`;

    // Where a text is found in a configuration, as paths; list items by
    // their name, when they have one ("mappingConfiguration.fields[mail]")
    function findText(value, text, path = '') {
        if (typeof value === 'string') return value.toLowerCase().includes(text) ? [path] : [];
        if (Array.isArray(value)) {
            return value.flatMap((v, i) => findText(v, text, `${path}[${v?.name ?? v?.displayName ?? i}]`));
        }
        if (isPlainObject(value)) {
            return Object.entries(value).flatMap(([k, v]) => findText(v, text, path ? `${path}.${k}` : k));
        }
        return [];
    }

    const USED_BY_BATCH = 6; // configurations fetched at the same time

    // The other systems that use this one. Systems of a type with a
    // configuration of its own (CONNECTOR_EXPORTS) are read in full: their
    // scripts or mappings aren't in the list of systems. Other types with
    // what the list has.
    // onCount(done, total): called as the systems are read; the same
    // for the other collectors
    async function collectUsedBy(system, systems, onCount = () => {}) {
        const text = accountsReference(system.systemId).toLowerCase();
        const others = systems.filter(o => o?.systemId && o.systemId !== system.systemId);
        const usedBy = [];
        let count = 0;
        onCount(count, others.length);
        for (let i = 0; i < others.length; i += USED_BY_BATCH) {
            await Promise.all(others.slice(i, i + USED_BY_BATCH).map(async (other) => {
                const path = CONNECTOR_EXPORTS[other.templateIdentifier]
                    ?.(encodeURIComponent(other.systemId)).configuration;
                let configuration = other;
                let couldNotRead = false;
                if (path) {
                    try {
                        configuration = await fetchFromGateway(path);
                    } catch (e) {
                        console.warn(`[HelloID UX] Export: could not read "${other.displayName}"`, e);
                        couldNotRead = true;
                    }
                }
                const dependsOnThisSystem = (configuration.dependOnSystems ?? other.dependOnSystems ?? [])
                    .some(d => d?.systemId === system.systemId);
                const references = findText(configuration, text);
                onCount(++count, others.length);
                if (!dependsOnThisSystem && !references.length && !couldNotRead) return;
                usedBy.push({
                    systemId: other.systemId,
                    displayName: other.displayName,
                    templateIdentifier: other.templateIdentifier,
                    dependsOnThisSystem,
                    references,
                    // Its scripts were not searched
                    ...(couldNotRead ? { couldNotRead } : {}),
                });
            }));
        }
        return usedBy.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    }

    // --- The business rules of the exported system, in full ---
    // The overview only says that a rule has entitlements for the system.
    // The rule itself has the rest: its conditions, and which entitlements
    // (of them, the ones for this system are exported).
    const RULE_PATH = (ruleId) => `/service/rules/api/rules/${encodeURIComponent(ruleId)}`;

    async function collectRules(rows, system, onCount = () => {}) {
        const rules = [];
        let count = 0;
        onCount(count, rows.length);
        const counted = (rule) => {
            onCount(++count, rows.length);
            return rule;
        };
        for (let i = 0; i < rows.length; i += USED_BY_BATCH) {
            rules.push(...await Promise.all(rows.slice(i, i + USED_BY_BATCH).map(async (row) => {
                try {
                    const { description, categories, published, hasDraft, condition, entitlements } =
                        await fetchFromGateway(RULE_PATH(row.ruleId));
                    return counted({
                        ...row,
                        description,
                        categories,
                        published,
                        hasDraft,
                        condition,
                        entitlements: (entitlements ?? []).filter(e => e?.systemIdentifier === system.systemId),
                    });
                } catch (e) {
                    console.warn(`[HelloID UX] Export: could not read rule "${row.ruleName}"`, e);
                    return counted({ ...row, couldNotRead: true });
                }
            })));
        }
        return rules;
    }

    // --- Notifications ---
    // The notifications of the exported system, in full, and those of
    // other systems that use its data (their dataReferences name it): a
    // replacement of the system has another ID. Which ones use it is only
    // in the notification itself, so all of them are read.
    const NOTIFICATIONS_PATH = '/service/notifications/api/notifications';

    // What sends the notifications (e.g. the built-in "Email"): the ones
    // these notifications use, in full. A notification only has the ID,
    // which may be another one in another environment.
    const NOTIFICATION_SYSTEMS_PATH = '/service/notifications/api/notification/systems';

    async function collectNotificationSystems(notifications) {
        const ids = [...new Set(notifications.map(n => n.notificationSystemId).filter(Boolean))];
        return Promise.all(ids.map(async (systemId) => {
            try {
                const read = await fetchFromGateway(`${NOTIFICATION_SYSTEMS_PATH}/${encodeURIComponent(systemId)}`);
                // Its settings may hold secrets, like those of a target system
                const settings = read.systemConfiguration;
                if (SETTINGS.exportSecrets || !isPlainObject(settings)) return read;
                return {
                    ...read,
                    systemConfiguration: Object.fromEntries(Object.entries(settings).map(([key, value]) =>
                        [key, SECRET_NAME.test(key) && isFilled(value) ? EXPORT_MASK : value])),
                };
            } catch (e) {
                console.warn(`[HelloID UX] Export: could not read notification system ${systemId}`, e);
                return { systemId, couldNotRead: true };
            }
        }));
    }

    async function collectNotifications(system, onCount = () => {}) {
        const list = await fetchFromGateway(`${NOTIFICATIONS_PATH}?skip=0&take=${SETTINGS.fetchAllTake}` +
                                            '&enabled=false&disabled=false'); // no filter: both
        const rows = list.pageData ?? [];
        const notifications = [];
        const notificationsUsingThisSystem = [];
        let count = 0;
        onCount(count, rows.length);
        for (let i = 0; i < rows.length; i += USED_BY_BATCH) {
            await Promise.all(rows.slice(i, i + USED_BY_BATCH).map(async (row) => {
                const own = row.systemId === system.systemId;
                let notification;
                try {
                    notification = await fetchFromGateway(`${NOTIFICATIONS_PATH}/${encodeURIComponent(row.identifier)}`);
                } catch (e) {
                    onCount(++count, rows.length);
                    console.warn(`[HelloID UX] Export: could not read notification "${row.name}"`, e);
                    (own ? notifications : notificationsUsingThisSystem).push({ ...row, couldNotRead: true });
                    return;
                }
                onCount(++count, rows.length);
                if (own) {
                    notifications.push(notification);
                    return;
                }
                const dataReferences = (notification.dataReferences ?? [])
                    .filter(r => r?.systemId === system.systemId);
                if (!dataReferences.length) return;
                const { identifier, systemId, event, name, enabled } = notification;
                notificationsUsingThisSystem.push({ identifier, systemId, event, name, enabled, dataReferences });
            }));
        }
        const byName = (a, b) => String(a.name).localeCompare(String(b.name));
        return {
            notifications: notifications.sort(byName),
            notificationSystems: await collectNotificationSystems(notifications),
            notificationsUsingThisSystem: notificationsUsingThisSystem.sort(byName),
        };
    }

    async function fetchFromGateway(path) {
        const response = await origFetch.call(pageWindow, gateway.origin + path, {
            cache: 'no-store', // always HelloID's current state
            headers: gateway.headers,
            credentials: gateway.withCredentials ? 'include' : 'same-origin',
        });
        if (!response.ok) throw new Error(`HelloID answered ${response.status} for ${path}`);
        return response.json();
    }

    // HelloID's list of target systems
    async function fetchSystems() {
        if (!gateway) throw new Error('No request of HelloID seen yet. Reload the page and try again.');
        const systems = await fetchFromGateway(SYSTEMS_PATH);
        rememberSystemIds(systems);
        return Array.isArray(systems) ? systems : [];
    }

    // The IDs of the systems by name, from the last list of systems that
    // came by (HelloID's own or ours): for the name of the export file,
    // which is needed before anything can be fetched
    const systemIds = new Map();

    function rememberSystemIds(systems) {
        if (!Array.isArray(systems)) return;
        systems.forEach(s => {
            if (typeof s?.displayName === 'string' && s.systemId) systemIds.set(s.displayName.trim(), s.systemId);
        });
    }

    // The steps of the export, for its progress: report(key, state, detail)
    // is called as they go (see showProgress for the states)
    const CONFIGURATION_STEPS = [
        { key: 'systems', label: 'List of target systems' },
        { key: 'configuration', label: 'Configuration' },
        { key: 'agents', label: 'Agents' },
        { key: 'rules', label: 'Business rules' },
        { key: 'notifications', label: 'Notifications' },
        { key: 'usedBy', label: 'Other systems that use this one' },
    ];

    // Reports a step as busy, and as done or failed when its work is over
    const tracked = (report, key, work) => {
        report(key, 'busy');
        return work().then(
            result => { report(key, 'done'); return result; },
            e => { report(key, 'failed'); throw e; },
        );
    };
    const counter = (report, key) => (done, total) => report(key, 'busy', `${done}/${total}`);

    async function collectSystemExport(name, report = () => {}) {
        const systems = await tracked(report, 'systems', fetchSystems);
        const system = systems
            .find(s => typeof s?.displayName === 'string' && s.displayName.trim() === name);
        if (!system) throw new Error(`"${name}" was not found in HelloID's list of target systems.`);

        const id = encodeURIComponent(system.systemId);
        const paths = CONNECTOR_EXPORTS[system.templateIdentifier]?.(id) ?? {};
        const names = Object.keys(paths);
        const couldNotRead = [];
        // The agents that run the system's on-premises actions: which
        // ones are selected (by tag or agent pool, never a single agent),
        // and how many that are.
        // Not all systems may have this, so no message when it fails.
        const agentPaths = {
            selected: AGENT_SELECTION_PATH(id),
            summary: `/service/agent-repository/api/agents/selections/summary/${id}`,
        };
        const collectAgents = async () => {
            const parts = await Promise.all(Object.values(agentPaths).map(path => fetchFromGateway(path)));
            const agents = Object.fromEntries(Object.keys(agentPaths).map((key, i) => [key, parts[i]]));
            // The agents that selection stands for right now. HelloID
            // answers with all agents, marking the selected ones (a POST,
            // but it only looks them up).
            if (Array.isArray(agents.selected) && agents.selected.length) {
                const all = await sendToGateway('/service/agent-repository/api/agents', 'POST', agents.selected);
                if (Array.isArray(all)) agents.selectedAgents = all.filter(a => a?.selected === true);
            }
            return agents;
        };
        const [agents, notifications, rules, usedBy, answers] = await Promise.all([
            tracked(report, 'agents', collectAgents).catch(e => {
                console.warn('[HelloID UX] Export: could not read "agents"', e);
                return { couldNotRead: true };
            }),
            tracked(report, 'notifications',
                () => collectNotifications(system, counter(report, 'notifications'))).catch(e => {
                console.warn('[HelloID UX] Export: could not read "notifications"', e);
                couldNotRead.push('notifications');
                return {};
            }),
            // Only the rules that have an entitlement for this system
            tracked(report, 'rules', () => fetchFromGateway(
                `/api/connectors/shared/rules/published/${id}/entitlements-overview` +
                `?skip=0&take=${SETTINGS.fetchAllTake}`)
                .then(overview => collectRules((overview.pageData ?? [])
                    .filter(r => RULE_ENTITLEMENT_FIELDS.some(f => r[f] === true)), system, counter(report, 'rules')))),
            tracked(report, 'usedBy', () => collectUsedBy(system, systems, counter(report, 'usedBy'))),
            tracked(report, 'configuration', () => Promise.all(names.map(n => fetchFromGateway(paths[n]).catch(e => {
                if (!OPTIONAL_EXPORTS.has(n)) throw e;
                console.warn(`[HelloID UX] Export: could not read "${n}"`, e);
                couldNotRead.push(n);
            })))),
        ]);
        const { configuration: read = system, ...others } = Object.fromEntries(names.map((n, i) => [n, answers[i]]));
        // The systems it depends on, with their names: HelloID only gives
        // their IDs, which mean nothing in another environment
        const configuration = !Array.isArray(read.dependOnSystems) ? read : {
            ...read,
            dependOnSystems: read.dependOnSystems.map(d => {
                const displayName = systems.find(o => o?.systemId === d.systemId)?.displayName;
                return displayName === undefined ? d : { ...d, displayName };
            }),
        };
        // What the list of systems has about it that the configuration
        // of its type doesn't
        const listEntry = Object.fromEntries(Object.entries(system).filter(([key]) => !(key in read)));

        return {
            exportedAt: new Date().toISOString(),
            exportedFrom: location.origin,
            exportedBy: `HelloID UX improvements ${typeof GM_info !== 'undefined' ? GM_info.script.version : ''}`.trim(),
            secretsIncluded: SETTINGS.exportSecrets,
            systemId: system.systemId,
            displayName: system.displayName,
            templateIdentifier: system.templateIdentifier,
            configuration: SETTINGS.exportSecrets ? configuration : maskSecrets(configuration),
            secrets: listSecrets(configuration),
            ...(Object.keys(listEntry).length ? { listEntry } : {}),
            agents,
            ...others,
            // How its accounts are named in mappings and scripts, and the
            // other systems that do so or depend on it
            accountsReference: `Person.Accounts.${accountsReference(system.systemId)}`,
            usedBy,
            ...notifications,
            ...(couldNotRead.length ? { couldNotRead } : {}),
            rules,
        };
    }

    // With the system's ID, when known: a copied or migrated system has
    // the name of the original. forName: the system, when name says more
    // than that.
    const exportFileName = (name, forName = name) => {
        const id = systemIds.get(forName);
        return `${name.replace(/[\\/:*?"<>|]+/g, '_').trim()}${id ? ` - ${id}` : ''} - ` +
               `${new Date().toISOString().slice(0, 10)}.json`;
    };

    // The save dialog has to open right at the click, so first ask where
    // to save, then collect, then write. Browsers without that dialog get
    // a normal download.
    // kind: which export (see EXPORT_KINDS)
    async function exportSystem(name, kind) {
        const fileName = () => exportFileName(`${name}${kind.suffix}`, name);
        let handle = null;
        if (typeof pageWindow.showSaveFilePicker === 'function') {
            try {
                handle = await pageWindow.showSaveFilePicker({
                    suggestedName: fileName(),
                    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
                });
            } catch (e) {
                if (e?.name === 'AbortError') return false; // cancelled
                throw e;
            }
        }

        // The progress, in a card: the steps of this export, then the file
        const steps = [...kind.steps, { key: 'save', label: 'Save the file' }];
        const progress = showProgress(`Export: ${name}`, steps.map(step => step.label));
        const report = (key, state, detail) => progress.set(steps.findIndex(step => step.key === key), state, detail);
        let data;
        try {
            data = await kind.collect(name, report);
            const json = JSON.stringify(data, null, 2);

            report('save', 'busy');
            if (handle) {
                const writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
            } else {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
                link.download = fileName();
                link.click();
                setTimeout(() => URL.revokeObjectURL(link.href), 10000);
            }
            report('save', 'done');
        } catch (e) {
            console.warn('[HelloID UX] Export failed', e);
            progress.failBusy();
            await progress.finish(`Export failed: ${e?.message ?? e}`);
            // Already shown to the user
            throw Object.assign(new Error(String(e?.message ?? e)), { shown: true });
        }

        // The card stays only when there is something to tell
        const notice = kind.notice(data);
        if (notice) await progress.finish(`Export finished.\n\n${notice}`);
        else progress.close();
        return true;
    }

    function configurationNotice(data) {
        const notSearched = data.usedBy.filter(u => u.couldNotRead).map(u => u.displayName);
        return data.couldNotRead
            ? `The file was saved without: ${data.couldNotRead.join(', ')}. HelloID did not return that part.`
            : notSearched.length
                ? 'The file was saved, but these systems could not be read, so it is not known whether they ' +
                  `use this system (usedBy in the file): ${notSearched.join(', ')}.`
                : EXPORT_NOTICES[data.templateIdentifier];
    }

    // --- Export of a system's granted entitlements ---
    // What the persons have in the system right now, per person: data, not
    // configuration, so a file of its own. For comparing before and after
    // a change (e.g. against the system that replaces this one).
    // HelloID has no request for one system: all granted entitlements are
    // fetched, and those of the system are kept.
    const GRANTED_PATH = '/service/rule-enforcement/api/enforcedstate/granted';

    const GRANTED_STEPS = [
        { key: 'systems', label: 'List of target systems' },
        { key: 'granted', label: 'Granted entitlements (of all systems)' },
    ];

    async function collectGrantedExport(name, report = () => {}) {
        const system = (await tracked(report, 'systems', fetchSystems))
            .find(s => typeof s?.displayName === 'string' && s.displayName.trim() === name);
        if (!system) throw new Error(`"${name}" was not found in HelloID's list of target systems.`);

        const granted = await tracked(report, 'granted',
            () => fetchFromGateway(`${GRANTED_PATH}?take=${SETTINGS.fetchAllTake}&skip=0`));
        const all = granted.pageData ?? [];
        const persons = new Map(); // personId -> person
        all.filter(row => row?.systemId === system.systemId).forEach(row => {
            const personId = row.personEntitlementId?.personId;
            if (!persons.has(personId)) {
                persons.set(personId, { personId, personName: row.personName, entitlements: [] });
            }
            const { entitlementId, type, displayName, permissionDefinitionDisplayName } = row.entitlement ?? {};
            persons.get(personId).entitlements.push({
                entitlementId,
                type,
                displayName: displayName ?? row.entitlementName,
                permissionDefinitionDisplayName,
                subPermissionCount: row.subPermissionCount,
                lastChangedOnUtc: row.lastChangedOnUtc,
                hasOpenActions: row.hasOpenActions,
            });
        });
        // In a fixed order, so two files can be compared
        const text = (v) => String(v ?? '');
        const result = [...persons.values()].sort((a, b) =>
            text(a.personName).localeCompare(text(b.personName)) || text(a.personId).localeCompare(text(b.personId)));
        result.forEach(p => p.entitlements.sort((a, b) =>
            text(a.type).localeCompare(text(b.type)) || text(a.displayName).localeCompare(text(b.displayName)) ||
            text(a.entitlementId).localeCompare(text(b.entitlementId))));

        return {
            exportedAt: new Date().toISOString(),
            exportedFrom: location.origin,
            exportedBy: `HelloID UX improvements ${typeof GM_info !== 'undefined' ? GM_info.script.version : ''}`.trim(),
            contents: 'grantedEntitlements',
            systemId: system.systemId,
            displayName: system.displayName,
            templateIdentifier: system.templateIdentifier,
            // False: HelloID returned as many rows as were asked for, so
            // there may be more (setting "Grids: max rows to fetch")
            complete: all.length < SETTINGS.fetchAllTake,
            // For checking that: the rows HelloID returned, of all systems
            // together, and what it said about its own limit
            rowsOfAllSystems: all.length,
            exceededTotalRowCountLimit: granted.exceededTotalRowCountLimit,
            personCount: result.length,
            entitlementCount: result.reduce((n, p) => n + p.entitlements.length, 0),
            persons: result,
        };
    }

    const EXPORT_KINDS = {
        configuration: {
            title: 'Export the configuration to a JSON file',
            icon: 'fa-solid fa-download',
            suffix: '',
            steps: CONFIGURATION_STEPS,
            collect: collectSystemExport,
            notice: configurationNotice,
        },
        granted: {
            title: 'Export the granted entitlements (per person) to a JSON file',
            icon: 'fa-solid fa-list-check',
            suffix: ' - granted entitlements',
            steps: GRANTED_STEPS,
            collect: collectGrantedExport,
            notice: (data) => (data.complete ? ''
                : 'The file may not have all granted entitlements: HelloID returned as many rows as were asked ' +
                  'for. Raise the setting "Grids: max rows to fetch" and export again.'),
        },
    };

    // getName is called at click time
    function createExportButton(getName, className = 'btn btn-default btn-xs', kind = EXPORT_KINDS.configuration) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = className;
        btn.title = kind.title;
        const icon = document.createElement('i');
        icon.className = kind.icon;
        btn.appendChild(icon);

        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            icon.className = 'fa-solid fa-spinner fa-spin';
            let result = kind.icon;
            try {
                if (await exportSystem(getName(), kind)) result = 'fa-solid fa-check';
            } catch (err) {
                result = 'fa-solid fa-xmark';
                if (!err?.shown) {
                    console.warn('[HelloID UX] Export failed', err);
                    alert(`Export failed.\n\n${err?.message ?? err}`);
                }
            }
            icon.className = result;
            btn.disabled = false;
            setTimeout(() => { icon.className = kind.icon; }, SETTINGS.copyFeedbackMs);
        });
        return btn;
    }

    // --- Dialog ---
    // A message in a card on top of the page, in HelloID's own styles: it
    // scrolls when the text is long, and the text can be selected and
    // copied (the browser's own alert/confirm cut long texts off).
    // With confirm: Cancel and Continue; resolves to true for Continue.
    // With alternative (a label): a button in between, for another way to
    // continue; resolves to 'alternative' for that one.
    const DIALOG_CLASS = 'tm-dialog';

    function showDialog(title, text, { confirm = false, alternative = null } = {}) {
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.className = DIALOG_CLASS;

            const heading = document.createElement('h5');
            heading.textContent = title;

            const body = document.createElement('pre');
            body.textContent = text;
            body.tabIndex = 0; // can take the focus, so the keyboard scrolls it

            const footer = document.createElement('div');
            footer.className = 'tm-dialog-footer';
            const button = (label, className, onClick) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `btn btn-sm ${className}`;
                btn.textContent = label;
                btn.addEventListener('click', onClick);
                footer.appendChild(btn);
                return btn;
            };
            const copy = button('Copy text', 'btn-primary tm-dialog-copy', async () => {
                copy.textContent = await copyToClipboard(text) ? 'Copied' : 'Copy failed';
                setTimeout(() => { copy.textContent = 'Copy text'; }, SETTINGS.copyFeedbackMs);
            });
            copy.style.marginRight = 'auto'; // on the left, the others on the right
            if (confirm) button('Cancel', 'btn-default', () => dialog.close('cancel'));
            // (as valid a choice as Continue: the same color)
            if (alternative) button(alternative, 'btn-primary', () => dialog.close('alternative'));
            const ok = button(confirm ? 'Continue' : 'Close', 'btn-primary', () => dialog.close('ok'));

            // Also closed with Escape: that counts as Cancel
            dialog.addEventListener('close', () => {
                dialog.remove();
                resolve(dialog.returnValue === 'alternative' ? 'alternative' : dialog.returnValue === 'ok');
            });
            // Keep typing away from the page's own key handlers
            dialog.addEventListener('keydown', (e) => e.stopPropagation());

            dialog.append(heading, body, footer);
            addStyles();
            document.body.appendChild(dialog);
            dialog.showModal();
            // Not the primary button for a confirmation: Enter shouldn't
            // start an import by accident
            (confirm ? body : ok).focus();
        });
    }

    // The same card for a job in steps: lists the steps with their state,
    // updated while they run. It can't be closed until the job is over.
    //   set(index, state, detail): waiting, busy, done, failed or skipped;
    //                    detail: shown behind the step ("12/40"), kept
    //                    until another one is given
    //   failBusy():      the job stopped: its busy steps failed
    //   close():         closes the card, without the user
    //   finish(message): adds the closing text, lets the user close the
    //                    card; resolves when that happens
    const PROGRESS_ICONS = { waiting: '•', busy: '⏳', done: '✅', failed: '❌', skipped: '–' };

    function showProgress(title, names) {
        const states = names.map(() => 'waiting');
        const details = names.map(() => '');
        let closing = '';
        const text = () => names.map((name, i) =>
            `${PROGRESS_ICONS[states[i]]} ${name}${details[i] ? ` (${details[i]})` : ''}`).join('\n') + closing;

        const dialog = document.createElement('dialog');
        dialog.className = DIALOG_CLASS;
        const heading = document.createElement('h5');
        heading.textContent = title;
        const body = document.createElement('pre');
        body.tabIndex = 0;
        const render = () => { body.textContent = text(); };

        const footer = document.createElement('div');
        footer.className = 'tm-dialog-footer';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-sm btn-primary tm-dialog-copy';
        copy.textContent = 'Copy text';
        copy.style.marginRight = 'auto';
        copy.addEventListener('click', async () => {
            copy.textContent = await copyToClipboard(text()) ? 'Copied' : 'Copy failed';
            setTimeout(() => { copy.textContent = 'Copy text'; }, SETTINGS.copyFeedbackMs);
        });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-sm btn-primary';
        close.textContent = 'Close';
        close.disabled = true; // until the job is over
        close.addEventListener('click', () => dialog.close());
        footer.append(copy, close);

        // Escape closes a dialog: not while the job runs
        dialog.addEventListener('cancel', (e) => { if (close.disabled) e.preventDefault(); });
        dialog.addEventListener('keydown', (e) => e.stopPropagation());
        const closed = new Promise(resolve => dialog.addEventListener('close', () => {
            dialog.remove();
            resolve();
        }));

        dialog.append(heading, body, footer);
        render();
        addStyles();
        document.body.appendChild(dialog);
        dialog.showModal();
        body.focus();

        return {
            set(index, state, detail) {
                states[index] = state;
                if (detail !== undefined) details[index] = detail;
                render();
            },
            failBusy() {
                states.forEach((state, i) => { if (state === 'busy') states[i] = 'failed'; });
                render();
            },
            close() {
                dialog.close();
            },
            finish(message) {
                closing = `\n\n${message}`;
                render();
                close.disabled = false;
                close.focus();
                return closed;
            },
        };
    }

    // --- Import of a system's configuration ---
    // The Import button (next to HelloID's "Add new system" button) reads
    // a file made by the Export button and compares it with the system it
    // was exported from, found by the system ID in the file. It shows
    // what differs and, after a confirmation, writes that to HelloID.
    // Without such a system, a new one is made (also after a confirmation).

    // What to write per type of target system (templateIdentifier), each
    // step being one request:
    //   name:   what it writes, for the summary
    //   path:   where to
    //   method: how
    //   body:   (configuration from the file, current one, all systems)
    //           -> what to send
    //   requests: (configuration, current) -> the requests to send instead
    //           of the step itself (each with name, path, method, body, or
    //           with name and run: (id) -> sends it), for a part that
    //           takes a request per item
    //   before: requests to send first, each with name, path, method, body
    //           and optionally when: (current) -> is it needed?
    //   resetsFieldIds: the mapping fields have new IDs afterwards
    //   usesFieldIds: sent again after such a step, with the new IDs
    //   note:   what else the user should know, for the summary
    //   changes: (configuration, current) -> the names of the parts it
    //           would change, when that's not simply what differs in body
    const GENERAL_FIELDS = ['displayName', 'description', 'icon', 'isDisabled', 'executeOnPremises',
        'limitConcurrentActionsConfiguration'];
    // For every type: these are stored apart from the type's configuration
    const SHARED_IMPORT_STEPS = [
        // The systems this one waits for. The request wants more about each
        // of them than the configuration has; that comes from the list of
        // systems. Systems that aren't in this environment are left out
        // (see findDependency).
        {
            name: 'Depends on systems',
            path: (id) => `/service/provisioning-api/api/target-systems/${id}/depend-on-systems`,
            method: 'POST',
            body: (configuration, current, systems) => ({
                dependOnSystems: (configuration.dependOnSystems ?? [])
                    .map(dependency => findDependency(dependency, systems)).filter(Boolean)
                    .map(system => ({
                        systemId: system.systemId,
                        displayName: system.displayName,
                        internalSystemReferenceName: system.internalSystemReferenceName,
                        templateIdentifier: system.templateIdentifier,
                    })),
            }),
            changes: (configuration, current) => {
                const ids = (c) => (c.dependOnSystems ?? []).map(d => d.systemId).sort().join();
                return ids(configuration) === ids(current) ? [] : ['dependOnSystems'];
            },
        },
        // Stored apart from the configuration; here it goes along with it
        // (see agentSelection in the import)
        {
            name: 'Agents for on-premises execution',
            path: AGENT_SELECTION_PATH,
            method: 'POST',
            body: (configuration) => configuration.agentSelection ?? [],
            changes: (configuration, current) =>
                (sameAgentSelection(configuration.agentSelection, current.agentSelection) ? [] : ['agentSelection']),
        },
    ];
    const POWERSHELL_IMPORT_STEPS = [
        {
            name: 'General settings',
            path: (id) => `/connector/powershell-target/api/configuration/${id}/general`,
            method: 'POST',
            body: (configuration) => Object.fromEntries(GENERAL_FIELDS.map(f => [f, configuration[f]])),
        },
        ...SHARED_IMPORT_STEPS,
        {
            name: 'Configuration values',
            path: (id) => `/connector/powershell-target/api/configuration/${id}/script-configuration`,
            method: 'POST',
            body: (configuration) => ({ scriptConfiguration: configuration.scriptConfiguration }),
        },
        {
            name: 'Account scripts and configuration form',
            path: (id) => `/connector/powershell-target/api/configuration/${id}/account`,
            method: 'POST',
            body: (configuration) => ({
                scripts: Object.fromEntries(Object.entries(configuration.scripts ?? {})
                    .filter(([key]) => key.startsWith('account'))),
                scriptConfigurationForm: configuration.scriptConfigurationForm,
                scriptConfiguration: configuration.scriptConfiguration,
            }),
        },
        // All thresholds in one request
        {
            name: 'Thresholds',
            path: (id) => `/connector/powershell-target/api/configuration/${id}/thresholds`,
            method: 'POST',
            body: (configuration) => configuration.thresholds ?? [],
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c === 'thresholds'),
        },
        // All resources (with their scripts) in one request. They belong
        // to the system they are sent to; one that the system already has
        // (same name) keeps the ID it has there.
        {
            name: 'Resources',
            path: POWERSHELL_RESOURCES_PATH,
            method: 'POST',
            body: (configuration, current) => (configuration.resources ?? []).map(resource => ({
                ...resource,
                systemId: current.systemId,
                // In a new system: an ID of its own, as the file's may be
                // in use by the system it was exported from
                resourceDefinitionId: matchingResource(resource, current.resources ?? [])?.resourceDefinitionId ??
                    (current.isNew ? crypto.randomUUID() : resource.resourceDefinitionId),
            })),
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c.startsWith(RESOURCE)),
        },
        // All permission sets (with their scripts) in one request
        {
            name: 'Permissions',
            path: (id) => `/connector/powershell-target/api/configuration/${id}/permissions`,
            method: 'POST',
            body: (configuration) => ({ permissions: configuration.permissions ?? [] }),
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c.startsWith(PERMISSION_SET)),
        },
        // The whole mapping, in the format of HelloID's own mapping export
        // ("v1"): names instead of the numbers the configuration has.
        // That request only adds fields, so first all fields are deleted,
        // which in turn needs correlation to be off. The new fields get new
        // IDs: correlation (next step) always has to be set again after this.
        {
            name: 'Mapping (all fields)',
            resetsFieldIds: true,
            note: 'replaces the whole mapping: turns correlation off, deletes all fields, then adds those of the file',
            before: [
                {
                    name: 'Turn correlation off',
                    when: (current) => current.correlationConfiguration?.enabled === true,
                    path: (id) => `/connector/powershell-target/api/configuration/${id}/correlation-configuration`,
                    method: 'POST',
                    body: (configuration, current) => ({ ...current.correlationConfiguration, enabled: false }),
                },
                {
                    name: 'Delete all mapping fields',
                    path: (id) => `/connector/powershell-target/api/mapping/${id}/fields`,
                    method: 'DELETE',
                },
            ],
            path: (id) => `/connector/powershell-target/api/mapping/${id}/import`,
            method: 'POST',
            body: (configuration) => ({
                Version: 'v1',
                MappingFields: (configuration.mappingConfiguration?.fields ?? []).map(field => ({
                    Name: field.name,
                    Description: field.description,
                    Type: mappingName(MAPPING_TYPES, field.type, 'type', field),
                    MappingActions: (field.mappingActions ?? []).map(action => ({
                        MapForActions: (action.entitlementActions ?? [])
                            .map(n => mappingName(MAPPING_ACTIONS, n, 'action', field)),
                        MappingMode: mappingName(MAPPING_MODES, action.mode, 'mode', field),
                        Value: JSON.stringify(action.value ?? null),
                        UsedInNotifications: action.usedInNotifications === true,
                        StoreInAccountData: action.storeInAccountData === true,
                    })),
                })),
                UniqueFieldNames: (configuration.mappingConfiguration?.uniquenessConfiguration
                    ?.selectedUniqueFields ?? []).map(id => mappingFieldName(configuration, id)),
            }),
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c.startsWith(MAPPING_FIELD)),
        },
        // The fields to check are given by their IDs in the system as it is
        // then, like the correlation field below
        {
            name: 'Uniqueness check',
            usesFieldIds: true,
            path: (id) => `/connector/powershell-target/api/mapping/${id}/uniqueness`,
            method: 'POST',
            body: (configuration, current) => {
                const { script, mappingEntitlementActions, selectedUniqueFields } =
                    configuration.mappingConfiguration?.uniquenessConfiguration ?? {};
                const currentFields = current.mappingConfiguration?.fields ?? [];
                return {
                    script,
                    mappingEntitlementActions,
                    selectedUniqueFields: (selectedUniqueFields ?? []).map(id => {
                        const name = mappingFieldName(configuration, id);
                        const field = currentFields.find(f => f.name === name);
                        if (!field) throw new Error(`The unique field "${name}" is not in the mapping.`);
                        return field.identifier;
                    }),
                };
            },
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c === UNIQUENESS),
        },
        // The correlation field is given by its ID in the system as it is
        // then (after the mapping step: its new ID), found by its name.
        // On or off as in the file.
        {
            name: 'Correlation',
            usesFieldIds: true,
            path: (id) => `/connector/powershell-target/api/configuration/${id}/correlation-configuration`,
            method: 'POST',
            body: (configuration, current) => {
                const { enabled, accountFieldId, personPropertyPath } = configuration.correlationConfiguration ?? {};
                const name = mappingFieldName(configuration, accountFieldId);
                const field = (current.mappingConfiguration?.fields ?? []).find(f => f.name === name);
                if (enabled && !field) {
                    const inFile = (configuration.mappingConfiguration?.fields ?? [])
                        .some(f => f.identifier === accountFieldId);
                    throw new Error(inFile
                        ? `Correlation is on in the file, but its field ("${name}") is not in the mapping of the system.`
                        : 'Correlation is on in the file, but correlationConfiguration.accountFieldId ' +
                          `(${accountFieldId}) is not the identifier of a mapping field in the file. ` +
                          'Set it to the identifier of the field to correlate on.');
                }
                return { enabled: enabled === true, accountFieldId: field?.identifier ?? null, personPropertyPath };
            },
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c === CORRELATION),
        },
    ];

    const CORRELATION = 'correlationConfiguration';
    const UNIQUENESS = 'mappingConfiguration.uniquenessConfiguration';

    // Name of the mapping field with this ID (IDs differ per system and
    // change when the mapping is imported; names don't)
    const mappingFieldName = (configuration, identifier) =>
        (configuration.mappingConfiguration?.fields ?? []).find(f => f.identifier === identifier)?.name ?? identifier;

    // The names HelloID's mapping export uses for the numbers in the
    // configuration. Another number stops the import instead of being
    // guessed.
    const MAPPING_TYPES = { 1: 'Text', 2: 'Array' };
    const MAPPING_MODES = { 0: 'None', 1: 'Fixed', 2: 'Field', 3: 'Complex' };
    const MAPPING_ACTIONS = { 1: 'Create', 2: 'Enable', 3: 'Update', 4: 'Disable', 5: 'Delete' };

    function mappingName(names, number, what, field) {
        if (!(number in names)) {
            throw new Error(`Mapping field "${field.name}" has ${what} ${number}, which this script doesn't know.`);
        }
        return names[number];
    }

    // A system the file's system depends on, as it is in this environment:
    // found by its ID or, for a file from another environment, by its name
    // (unless the user chose not to: matchByName false)
    const findDependency = (dependency, systems) =>
        systems.find(s => s.systemId === dependency.systemId) ??
        systems.find(s => dependency.matchByName !== false &&
                          typeof dependency.displayName === 'string' && typeof s.displayName === 'string' &&
                          s.displayName.trim() === dependency.displayName.trim());

    // The file's dependencies with the IDs they have here, without the
    // ones that aren't here
    const resolveDependencies = (configuration, systems) => (configuration.dependOnSystems ?? [])
        .filter(d => findDependency(d, systems))
        .map(({ displayName, matchByName, ...d }) => ({ ...d, systemId: findDependency({ displayName, ...d }, systems).systemId }));

    // For the user: the dependencies that are left out, if any
    function missingDependencies(configuration, systems) {
        const missing = (configuration.dependOnSystems ?? []).filter(d => !findDependency(d, systems));
        if (!missing.length) return '';
        return '\n\nThe system depends on systems whose ID is not in this HelloID environment. They are left ' +
               'out of "Depends on systems"; add them by hand when needed:\n' +
               missing.map(d => `  - ${d.displayName ?? '?'} (ID ${d.systemId})`).join('\n');
    }

    // Is there a target system with this name already?
    const NAME_EXISTS_PATH = (name) =>
        `/service/provisioning-api/api/target-systems/exists?name=${encodeURIComponent(name)}`;

    // Makes a new, empty system of a type; answers its ID
    const CREATE_PATHS = {
        'powershell-target': '/connector/powershell-target/api/configuration/create/powershell-target',
        'powershell-onpremise': '/connector/powershell-target/api/configuration/create/powershell-onpremise',
        'activedirectory': '/connector/active-directory/api/configuration/create/activedirectory',
    };

    // Built-in Active Directory. A part without a step here is shown as
    // not importable when it differs.
    const AD_GENERAL_FIELDS = ['domain', 'selectedDomainControllers', 'manualDomainControllerSelection',
        'description', 'displayName', 'isDisabled'];
    // The requests that make the system's mapping fields those of the
    // file, field by field (found by name), so the fields keep their IDs:
    // a field that differs is sent; a field the system doesn't have is
    // made (HelloID makes an empty one) and then sent; a field that isn't
    // in the file is deleted, after the others. The mapping actions of a
    // field keep their IDs too, in order; an action more than the system
    // has gets a new ID.
    function adFieldRequests(configuration, current) {
        const fieldPath = (id, identifier) => `/connector/active-directory/api/mapping/${id}/field` +
            (identifier ? `/${encodeURIComponent(identifier)}` : '');
        const withoutIds = ({ identifier, mappingActions, ...field }) => JSON.stringify({
            ...field,
            mappingActions: (mappingActions ?? []).map(({ mappingActionId, ...action }) => action),
        });
        // mine: the system's field it is written to
        const bodyFor = (field, mine) => ({
            type: field.type,
            mappingActions: (field.mappingActions ?? []).map((action, i) => ({
                ...action,
                mappingActionId: mine.mappingActions?.[i]?.mappingActionId ?? crypto.randomUUID(),
            })),
            configuredForActions: [...new Set((field.mappingActions ?? []).flatMap(a => a.entitlementActions ?? []))],
            identifier: mine.identifier,
            name: field.name,
            description: field.description,
            // Always empty in HelloID's own requests
            useInNotificationsForActions: '',
            storeInAccountDataForActions: '',
        });
        const currentFields = current.mappingConfiguration?.fields ?? [];
        const fileFields = configuration.mappingConfiguration?.fields ?? [];
        const known = new Set(currentFields.map(f => f.identifier)); // to tell a new field from the others

        // HelloID answers nothing usable for a new field: it is the one
        // the system didn't have before (it may take a moment to show)
        const makeField = async (id) => {
            await sendToGateway(fieldPath(id), 'POST', {});
            for (let attempt = 0; ; attempt++) {
                const now = await fetchFromGateway(CONNECTOR_EXPORTS.activedirectory(id).configuration);
                const made = (now.mappingConfiguration?.fields ?? []).filter(f => !known.has(f.identifier));
                if (made.length === 1) {
                    known.add(made[0].identifier);
                    return made[0];
                }
                if (made.length > 1 || attempt >= 9) {
                    throw new Error(`A new mapping field was made, but HelloID shows ${made.length} new fields.`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        };

        const requests = fileFields.flatMap(field => {
            const mine = currentFields.find(f => f.name === field.name);
            if (!mine) {
                return [{
                    name: `Mapping field "${field.name}" (new)`,
                    run: async (id) => {
                        const made = await makeField(id);
                        await sendToGateway(fieldPath(id, made.identifier), 'POST', bodyFor(field, made));
                    },
                }];
            }
            if (withoutIds(mine) === withoutIds(field)) return [];
            const body = bodyFor(field, mine);
            return [{
                name: `Mapping field "${field.name}"`,
                path: (id) => fieldPath(id, mine.identifier),
                method: 'POST',
                body: () => body,
            }];
        });
        currentFields.filter(f => !fileFields.some(o => o.name === f.name)).forEach(f => requests.push({
            name: `Mapping field "${f.name}" (delete)`,
            path: (id) => fieldPath(id, f.identifier),
            method: 'DELETE',
        }));
        // After the last one, the system has the fields of the file
        if (requests.length) requests[requests.length - 1].resetsFieldIds = true;
        return requests;
    }

    const AD_ADMINISTRATION_FIELDS = ['deleteAccounts', 'managerSettings',
        'container', 'containerSelectionType', 'containerSelectorPowershellScript',
        ...['enable', 'disable', 'update'].flatMap(action => [`${action}Container`,
            `${action}ContainerSelectionType`, `${action}ContainerSelectorPowershellScript`,
            `moveOn${action[0].toUpperCase()}${action.slice(1)}`])];
    const ACTIVE_DIRECTORY_IMPORT_STEPS = [
        {
            name: 'General settings',
            path: (id) => `/connector/active-directory/api/configuration/${id}/general`,
            method: 'POST',
            body: (configuration) => Object.fromEntries(AD_GENERAL_FIELDS.map(f => [f, configuration[f]])),
        },
        ...SHARED_IMPORT_STEPS,
        {
            name: 'Exchange',
            path: (id) => `/connector/active-directory/api/configuration/${id}/exchange`,
            method: 'POST',
            body: (configuration) => configuration.exchangeConfiguration,
            changes: (configuration, current) =>
                (JSON.stringify(configuration.exchangeConfiguration ?? null) ===
                 JSON.stringify(current.exchangeConfiguration ?? null) ? [] : ['exchangeConfiguration']),
        },
        // Home, profile and terminal services directories, in one request
        {
            name: 'Directories',
            path: (id) => `/connector/active-directory/api/configuration/${id}/directories`,
            method: 'POST',
            body: (configuration) => configuration.directories,
            changes: (configuration, current) =>
                (JSON.stringify(configuration.directories ?? null) ===
                 JSON.stringify(current.directories ?? null) ? [] : ['directories']),
        },
        // Field by field (see adFieldRequests). The steps that point at
        // fields are sent again afterwards: a new field has its ID only then.
        {
            name: 'Field mapping',
            note: 'field by field: changes them, adds the new ones, deletes the ones that are not in the file',
            resetsFieldIds: true,
            requests: adFieldRequests,
            body: (configuration, current) => adFieldRequests(configuration, current).map(r => r.body?.()),
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c.startsWith(MAPPING_FIELD)),
        },
        // Delete accounts, the manager, and the containers (default, and
        // after enable, disable and update). The request groups per
        // container what the configuration has side by side.
        {
            name: 'Administration (delete accounts, manager, containers)',
            path: (id) => `/connector/active-directory/api/configuration/${id}/administration`,
            method: 'POST',
            body: (configuration) => {
                const container = (action, move) => ({
                    container: configuration[action ? `${action}Container` : 'container'],
                    containerSelectionType: configuration[action ? `${action}ContainerSelectionType`
                        : 'containerSelectionType'],
                    containerSelectorPowershellScript: configuration[action
                        ? `${action}ContainerSelectorPowershellScript` : 'containerSelectorPowershellScript'],
                    ...(action ? { move: configuration[move] } : {}),
                });
                return {
                    deleteAccounts: configuration.deleteAccounts,
                    managerSettings: configuration.managerSettings,
                    defaultContainer: container(),
                    enableContainer: container('enable', 'moveOnEnable'),
                    disableContainer: container('disable', 'moveOnDisable'),
                    updateContainer: container('update', 'moveOnUpdate'),
                };
            },
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => AD_ADMINISTRATION_FIELDS.includes(c)),
        },
        // All thresholds in one request
        {
            name: 'Thresholds',
            path: (id) => `/connector/active-directory/api/configuration/${id}/thresholds`,
            method: 'POST',
            body: (configuration) => configuration.thresholds,
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c === 'thresholds'),
        },
        // As for a PowerShell system: the script, its actions and the
        // fields to check
        {
            name: 'Uniqueness check',
            usesFieldIds: true,
            path: (id) => `/connector/active-directory/api/mapping/${id}/uniqueness`,
            method: 'POST',
            body: (configuration, current) => {
                const { script, mappingEntitlementActions, selectedUniqueFields } =
                    configuration.mappingConfiguration?.uniquenessConfiguration ?? {};
                return {
                    script,
                    mappingEntitlementActions,
                    selectedUniqueFields: (selectedUniqueFields ?? []).map(id => {
                        const name = mappingFieldName(configuration, id);
                        const field = (current.mappingConfiguration?.fields ?? []).find(f => f.name === name);
                        if (!field) throw new Error(`The unique field "${name}" is not in the mapping of the system.`);
                        return field.identifier;
                    }),
                };
            },
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => c === UNIQUENESS),
        },
        // The unique fields are given by their IDs in the system, found by
        // name. The request also wants the dependencies again.
        {
            name: 'Account settings (sync unique fields, configuration form, post-action scripts)',
            usesFieldIds: true,
            path: (id) => `/connector/active-directory/api/configuration/${id}/account`,
            method: 'POST',
            body: (configuration, current, systems) => ({
                selectedUniqueFields: (configuration.mappingConfiguration?.uniquenessConfiguration
                    ?.selectedUniqueFields ?? []).map(id => {
                    const name = mappingFieldName(configuration, id);
                    const field = (current.mappingConfiguration?.fields ?? []).find(f => f.name === name);
                    if (!field) throw new Error(`The unique field "${name}" is not in the mapping of the system.`);
                    return field.identifier;
                }),
                syncUniqueFields: configuration.syncUniqueFields,
                ...SHARED_IMPORT_STEPS[0].body(configuration, current, systems), // dependOnSystems
                scriptConfigurationForm: configuration.scriptConfigurationForm,
                postActionPowerShellConfiguration: configuration.postActionPowerShellConfiguration,
            }),
            changes: (configuration, current) => changedParts(configuration, current)
                .filter(c => ['syncUniqueFields', 'scriptConfigurationForm',
                    'postActionPowerShellConfiguration'].includes(c)),
        },
        // As for a PowerShell system, to another address
        {
            ...POWERSHELL_IMPORT_STEPS.find(step => step.name === 'Correlation'),
            path: (id) => `/connector/active-directory/api/configuration/${id}/correlate`,
        },
    ];

    const IMPORT_STEPS = {
        'powershell-onpremise': POWERSHELL_IMPORT_STEPS,
        'powershell-target': POWERSHELL_IMPORT_STEPS,
        'activedirectory': ACTIVE_DIRECTORY_IMPORT_STEPS,
    };

    // --- Import of the notifications ---
    // The notifications of the file are made for the system, or, when it
    // has them already (the same ID, or else the same event and name),
    // changed into those of the file where they differ. One request each;
    // HelloID uses the same one for a new and for an existing
    // notification, told apart by the ID. Notifications the system has
    // that the file doesn't are left alone.

    // What HelloID wants: the notification as it was read, with the ID to
    // write to, for this system and this environment. Data of the file's
    // system is data of this system here.
    function notificationFor(notification, identifier, fileSystemId, system) {
        const { couldNotRead, ...rest } = notification;
        return {
            ...rest,
            identifier,
            systemId: system.systemId,
            tenantUrl: location.origin,
            dataReferences: (notification.dataReferences ?? [])
                .map(r => (r?.systemId === fileSystemId ? { ...r, systemId: system.systemId } : r)),
        };
    }

    // Two notifications with the same content? Not counting when they
    // were changed and what HelloID fills in itself.
    function sameNotification(a, b) {
        const content = ({ lastChange, tenantUrl, configuration, ...rest }) => {
            const { verifiedDomains, ...mail } = configuration ?? {};
            return { ...rest, configuration: mail };
        };
        const ordered = (value) => (Array.isArray(value) ? value.map(ordered)
            : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])]))
            : value ?? null);
        return JSON.stringify(ordered(content(a))) === JSON.stringify(ordered(content(b)));
    }

    // The requests, as import steps; none when the file has no
    // notifications (an older export)
    // skipped: for the user, the notifications that can't be sent here
    async function notificationRequests(data, fileSystemId, system) {
        const all = (Array.isArray(data.notifications) ? data.notifications : [])
            .filter(n => isPlainObject(n) && !n.couldNotRead && isPlainObject(n.configuration));
        if (!all.length) return { requests: [], skipped: '' };

        // What sends them, as it is here: found by its ID or, for a file
        // from another environment, by its name
        const senders = await fetchFromGateway(NOTIFICATION_SYSTEMS_PATH);
        const senderHere = (id) => {
            if (!id || senders.some(s => s?.systemId === id)) return id;
            const name = (data.notificationSystems ?? []).find(s => s?.systemId === id)?.displayName;
            return senders.find(s => typeof name === 'string' && s?.displayName === name)?.systemId;
        };
        const unsendable = all.filter(n => n.notificationSystemId && !senderHere(n.notificationSystemId));
        const skipped = !unsendable.length ? ''
            : '\n\nThese notifications of the file are not imported: what sends them (their notification ' +
              'system) is not in this HelloID environment:\n' + unsendable.map(n => `  - ${n.name}`).join('\n');
        const inFile = all.filter(n => !unsendable.includes(n))
            .map(n => ({ ...n, notificationSystemId: senderHere(n.notificationSystemId) }));
        const list = await fetchFromGateway(`${NOTIFICATIONS_PATH}?skip=0&take=${SETTINGS.fetchAllTake}` +
                                            '&enabled=false&disabled=false');
        const here = (list.pageData ?? []).filter(n => n?.systemId === system.systemId);
        const taken = new Set(); // each one of the system matches one of the file at most
        const requests = [];
        for (const notification of inFile) {
            const match = here.find(n => !taken.has(n) && n.identifier === notification.identifier) ??
                          here.find(n => !taken.has(n) && n.event === notification.event && n.name === notification.name);
            if (match) taken.add(match);
            const body = notificationFor(notification, match?.identifier ?? crypto.randomUUID(), fileSystemId, system);
            if (match && sameNotification(body,
                await fetchFromGateway(`${NOTIFICATIONS_PATH}/${encodeURIComponent(match.identifier)}`))) {
                continue;
            }
            requests.push({
                name: `Notification "${notification.name}" (${match ? 'change' : 'new'})`,
                path: () => NOTIFICATIONS_PATH,
                method: 'POST',
                body: () => body,
            });
        }
        return { requests, skipped };
    }

    // --- Import of the business rule links ---
    // The rules of the file get the entitlements they had for the file's
    // system, for this system: found by ID, or else (another system) by
    // type and name. What a rule has for other systems stays. A rule is
    // saved as a DRAFT and never published: that is up to the user, in
    // HelloID, which shows what publishing would do. HelloID returns a
    // rule's draft when it has one, so a draft that is there is added to.
    // Entitlements this system has in rules that the file doesn't have
    // are only taken out when the user chooses so.
    // Permissions can only be linked once HelloID has retrieved them from
    // the system (its permission scripts). When some of the file aren't
    // there, two last steps let HelloID retrieve them (and wait for them),
    // and link what came: after the configuration is imported, as a new
    // system has its scripts only then.
    const RULES_PATH = '/service/rules/api/rules';
    // All entitlements that rules can have, of all systems
    const RULE_ENTITLEMENTS_PATH = `/service/rules/api/entitlements?skip=0&take=${SETTINGS.fetchAllTake}`;
    const ENTITLEMENT_TYPES = { 1: 'Account', 2: 'AccountAccess', 3: 'Permission' };
    // Lets HelloID retrieve the permissions of a system; it does so in
    // its own time
    const RETRIEVE_PERMISSIONS_PATH = (id) =>
        `/service/provisioning-api/api/target-systems/snapshots/create/${id}?permissionsOnly=true`;
    const RETRIEVE_WAIT_MS = 120000; // how long to wait for them
    const RETRIEVE_POLL_MS = 5000;

    // An entitlement as rules have it, from a row of that list (which
    // has the type as a number)
    function ruleEntitlement(row, system) {
        const entitlement = isPlainObject(row?.entitlement) ? { ...row, ...row.entitlement } : row ?? {};
        const type = entitlement.type ?? entitlement.entitlementType;
        return {
            entitlementId: entitlement.entitlementId ?? entitlement.id,
            systemIdentifier: entitlement.systemIdentifier ?? entitlement.systemId,
            type: ENTITLEMENT_TYPES[type] ?? type,
            displayName: entitlement.displayName ?? entitlement.entitlementName ?? entitlement.name,
            permissionDefinitionDisplayName: entitlement.permissionDefinitionDisplayName ?? null,
            systemName: system.displayName,
        };
    }

    const entitlementLabel = (e) => (e.type === 'Permission'
        ? `permission "${e.displayName}"${e.permissionDefinitionDisplayName ? ` (${e.permissionDefinitionDisplayName})` : ''}`
        : e.type === 'AccountAccess' ? 'account access' : e.type === 'Account' ? 'account' : `${e.type} "${e.displayName}"`);

    // Answers, or null when the user cancelled:
    //   requests:  the import steps
    //   skipped:   for the user, what could not be linked (read it after
    //              the import: the last step changes it)
    //   drafts():  the number of rules saved as a draft
    // Nothing when the file has no rules with their entitlements (an
    // older export).
    async function ruleRequests(data, system, created, header) {
        const requests = [];
        const drafts = new Set(); // rule IDs
        let missing = [];  // { ruleId, name, entitlement }: not an entitlement of the system
        const notes = [];  // other lines for the user
        let retrieving = false; // the last step is planned, and hasn't run
        const result = {
            requests,
            drafts: () => drafts.size,
            get skipped() {
                // (not the permissions the last step is still to retrieve)
                const lines = [...notes,
                    ...missing.filter(m => !(retrieving && m.entitlement.type === 'Permission'))
                        .map(m => `"${m.name}": ${entitlementLabel(m.entitlement)} is not an entitlement of the system`)];
                return !lines.length ? ''
                    : `\n\nNot linked in business rules:\n${lines.map(line => `  - ${line}`).join('\n')}`;
            },
        };

        const fileRules = (Array.isArray(data.rules) ? data.rules : [])
            .filter(r => isPlainObject(r) && r.ruleId && Array.isArray(r.entitlements));
        // (usedBy: only exports that have the rules' entitlements have it;
        // an older export with no rules says nothing about the rules)
        if (!Array.isArray(data.rules) || !Array.isArray(data.usedBy) ||
            (data.rules.length && !fileRules.length)) return result;

        // What rules can have for this system (not what the system no
        // longer returns)
        const readAvailable = async () => {
            const list = await fetchFromGateway(RULE_ENTITLEMENTS_PATH);
            return (list.pageData ?? list ?? []).filter(row => row?.inTargetSystem !== false)
                .map(row => ruleEntitlement(row, system))
                .filter(e => e.entitlementId && e.systemIdentifier === system.systemId);
        };
        let available;
        try {
            available = await readAvailable();
        } catch (e) {
            console.warn('[HelloID UX] Import: could not read the entitlements for rules', e);
            notes.push(`no rule was linked: HelloID did not return the list of entitlements (${e?.message ?? e})`);
            return result;
        }
        const sameName = (a, b) => a.type === b.type && a.displayName === b.displayName;
        const here = (entitlement, list = available) => list.find(a => a.entitlementId === entitlement.entitlementId) ??
            list.find(a => sameName(a, entitlement) &&
                (a.permissionDefinitionDisplayName ?? null) === (entitlement.permissionDefinitionDisplayName ?? null)) ??
            // Without the permission set's name, when that leaves one
            (list.filter(a => sameName(a, entitlement)).length === 1
                ? list.find(a => sameName(a, entitlement)) : undefined);

        const readRule = (ruleId) => fetchFromGateway(`${RULES_PATH}/${encodeURIComponent(ruleId)}`);
        const ofSystem = (rule) => (rule.entitlements ?? []).filter(e => e?.systemIdentifier === system.systemId);
        const withEntitlements = (rule, add, remove = []) => ({
            ...rule,
            entitlements: [...(rule.entitlements ?? []).filter(e => !remove.includes(e)), ...add],
        });

        // Per rule: what to add, and what the system has that the file doesn't
        const plans = [];
        for (const fileRule of fileRules) {
            let rule;
            try {
                rule = await readRule(fileRule.ruleId);
            } catch (e) {
                console.warn(`[HelloID UX] Import: could not read rule "${fileRule.ruleName}"`, e);
                if (fileRule.entitlements.length) notes.push(`"${fileRule.ruleName}": the rule is not in this HelloID environment`);
                continue;
            }
            const wanted = [];
            fileRule.entitlements.forEach(entitlement => {
                const found = here(entitlement);
                if (found) wanted.push(found);
                else missing.push({ ruleId: rule.ruleId, name: rule.name, entitlement });
            });
            const has = ofSystem(rule);
            plans.push({
                rule,
                add: wanted.filter(w => !has.some(h => h.entitlementId === w.entitlementId)),
                // (not what is only missing for now)
                remove: has.filter(h => !wanted.some(w => w.entitlementId === h.entitlementId) &&
                                        !fileRule.entitlements.some(e => e.entitlementId === h.entitlementId || sameName(e, h))),
            });
        }
        // An existing system: the rules that have it, but aren't in the file
        if (!created) {
            const overview = await fetchFromGateway(
                `/api/connectors/shared/rules/published/${encodeURIComponent(system.systemId)}/entitlements-overview` +
                `?skip=0&take=${SETTINGS.fetchAllTake}`);
            for (const row of overview.pageData ?? []) {
                if (fileRules.some(r => r.ruleId === row.ruleId) || !RULE_ENTITLEMENT_FIELDS.some(f => row[f] === true)) continue;
                const rule = await readRule(row.ruleId);
                if (ofSystem(rule).length) plans.push({ rule, add: [], remove: ofSystem(rule) });
            }
        }

        // Taking entitlements out of rules: only when the user says so
        const describe = (name, sign, entitlements) => entitlements.map(e => `${sign} "${name}": ${entitlementLabel(e)}`);
        const removals = plans.flatMap(plan => describe(plan.rule.name, '-', plan.remove));
        let removing = false;
        if (removals.length) {
            const answer = await showDialog('Import: business rules', `${header}\n\n` +
                `Business rules have entitlements for "${system.displayName}" that the file doesn't have:\n` +
                `${removals.map(line => `  ${line}`).join('\n')}\n\n` +
                'Continue: these stay as they are.\n' +
                'Take them out: the rules are saved without them, as drafts. Nothing changes until you publish ' +
                'those rules in HelloID; when you do, HelloID asks what to do with what was granted.\n' +
                'Cancel: stops the import.',
                { confirm: true, alternative: 'Take them out' });
            if (!answer) return null;
            removing = answer === 'alternative';
        }

        plans.filter(plan => plan.add.length || (removing && plan.remove.length)).forEach(plan => {
            const remove = removing ? plan.remove : [];
            const body = withEntitlements(plan.rule, plan.add, remove);
            drafts.add(plan.rule.ruleId);
            requests.push({
                name: `Business rule "${plan.rule.name}" (draft)`,
                changes: [...describe(plan.rule.name, '+', plan.add), ...describe(plan.rule.name, '-', remove)],
                path: () => RULES_PATH,
                method: 'POST',
                body: () => body,
            });
        });

        // Permissions of the file that the system doesn't have (yet)
        const missingPermissions = () => missing.filter(m => m.entitlement.type === 'Permission');
        if (!missingPermissions().length) return result;
        // A new system without its secrets can't reach the target system
        // (a secret that was left out of the file: "***" in it, whatever
        // the file says about its secrets)
        const configuration = data.configuration ?? {};
        const leftOut = Object.values(configuration.scriptConfiguration ?? {}).includes(EXPORT_MASK) ||
            settingSecretKeys(configuration).some(([group, key]) =>
                (group ? configuration[group][key] : configuration[key]) === EXPORT_MASK);
        if (created && leftOut) {
            notes.push('the permissions of the new system can\'t be retrieved before its secrets are set: ' +
                       'set them, then import the file again to link the permissions');
            return result;
        }
        retrieving = true;
        // Two steps: HelloID retrieves the permissions (in its own time,
        // so this waits for the ones that are wanted), then the rules
        // get the ones that came
        let retrieved = available;
        requests.push({
            name: 'Retrieve the permissions of the system',
            changes: ['lets HelloID retrieve the permissions of the system now, and waits for them ' +
                      `(${RETRIEVE_WAIT_MS / 60000} minutes at most)`],
            run: async (id) => {
                try {
                    await sendToGateway(RETRIEVE_PERMISSIONS_PATH(id), 'POST', {});
                } catch (e) {
                    console.warn('[HelloID UX] Import: could not start retrieving the permissions', e);
                    notes.push(`HelloID did not start retrieving the permissions (${e?.message ?? e})`);
                    return;
                }
                // Until all of them are there, or time is up
                const deadline = Date.now() + RETRIEVE_WAIT_MS;
                while (missing.some(m => !here(m.entitlement, retrieved)) && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, RETRIEVE_POLL_MS));
                    retrieved = await readAvailable();
                }
            },
        });
        requests.push({
            name: 'Link the retrieved permissions in business rules (drafts)',
            changes: missingPermissions().flatMap(m => describe(m.name, '+', [m.entitlement])),
            run: async () => {
                retrieving = false;
                // Each rule as it is now: an earlier step may have saved it
                const found = missing.filter(m => here(m.entitlement, retrieved));
                for (const ruleId of new Set(found.map(m => m.ruleId))) {
                    const rule = await readRule(ruleId);
                    const has = ofSystem(rule);
                    const add = found.filter(m => m.ruleId === ruleId).map(m => here(m.entitlement, retrieved))
                        .filter((w, i, all) => all.indexOf(w) === i && !has.some(h => h.entitlementId === w.entitlementId));
                    if (!add.length) continue;
                    await sendToGateway(RULES_PATH, 'POST', withEntitlements(rule, add));
                    drafts.add(ruleId);
                }
                missing = missing.filter(m => !found.includes(m));
                if (missing.some(m => m.entitlement.type === 'Permission')) {
                    notes.push('HelloID was asked to retrieve the permissions of the system, but these did not come ' +
                               '(in time): check the system, let it retrieve its permissions, then import the file again');
                }
            },
        });
        return result;
    }

    // Secrets that were left out of the file ("***") keep the value the
    // system has now
    function restoreSecrets(configuration, current) {
        const restored = { ...configuration };
        // Settings of built-in types (see settingSecretKeys)
        settingSecretKeys(configuration).forEach(([group, key]) => {
            if (group) {
                if (restored[group][key] !== EXPORT_MASK) return;
                restored[group] = { ...restored[group], [key]: current[group]?.[key] ?? null };
            } else if (restored[key] === EXPORT_MASK) {
                restored[key] = current[key] ?? null;
            }
        });
        if (!isPlainObject(configuration.scriptConfiguration)) return restored;
        const values = { ...configuration.scriptConfiguration };
        Object.keys(values).forEach(key => {
            if (values[key] === EXPORT_MASK) values[key] = current.scriptConfiguration?.[key] ?? null;
        });
        return { ...restored, scriptConfiguration: values };
    }

    // Lets the user pick the file to import; null when cancelled
    async function pickImportFile() {
        if (typeof pageWindow.showOpenFilePicker === 'function') {
            try {
                const [handle] = await pageWindow.showOpenFilePicker({
                    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
                });
                return (await handle.getFile()).text();
            } catch (e) {
                if (e?.name === 'AbortError') return null; // cancelled
                throw e;
            }
        }
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.addEventListener('change', () => {
                const file = input.files[0];
                if (file) file.text().then(resolve, reject);
                else resolve(null);
            });
            input.addEventListener('cancel', () => resolve(null));
            input.click();
        });
    }

    const MAPPING_FIELD = 'mapping field ';
    const PERMISSION_SET = 'permission set ';
    const RESOURCE = 'resource ';

    const matchingResource = (resource, resources) =>
        resources.find(o => o.resourceDefinitionId === resource.resourceDefinitionId) ??
        resources.find(o => o.displayName === resource.displayName);

    // Names of the parts of a configuration (or of a step's body) that
    // differ from the system's current one, e.g. "scripts.accountCreate",
    // 'mapping field "mail"', 'mapping field "mail" (not in the system)'
    // or 'permission set "Groups"'
    function changedParts(body, currentBody) {
        const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const keysOf = (...objects) => [...new Set(objects.flatMap(o => Object.keys(o ?? {})))];
        return keysOf(body, currentBody).flatMap(key => {
            if (key === 'mappingConfiguration') {
                // By name and without the IDs, which an import changes
                const withoutIds = ({ identifier, mappingActions, ...field }) => ({
                    ...field,
                    mappingActions: (mappingActions ?? []).map(({ mappingActionId, ...action }) => action),
                });
                const fieldsOf = (c) => new Map((c.mappingConfiguration?.fields ?? []).map(f => [f.name, withoutIds(f)]));
                const mine = fieldsOf(body);
                const theirs = fieldsOf(currentBody);
                // The rest, with the unique fields by name as well
                const restOf = (c) => {
                    const { fields, ...rest } = c.mappingConfiguration ?? {};
                    const unique = rest.uniquenessConfiguration;
                    return !unique ? rest : {
                        ...rest,
                        uniquenessConfiguration: {
                            ...unique,
                            selectedUniqueFields: (unique.selectedUniqueFields ?? [])
                                .map(id => mappingFieldName(c, id)).sort(),
                        },
                    };
                };
                const rest = restOf(body);
                const currentRest = restOf(currentBody);
                return [
                    ...[...mine.values()].filter(f => !same(f, theirs.get(f.name))).map(f =>
                        `${MAPPING_FIELD}"${f.name}"${theirs.has(f.name) ? '' : ' (not in the system)'}`),
                    ...[...theirs.values()].filter(f => !mine.has(f.name)).map(f =>
                        `${MAPPING_FIELD}"${f.name}" (not in the file)`),
                    ...changedParts(rest, currentRest).map(c => `mappingConfiguration.${c}`),
                ];
            }
            if (key === 'resources') {
                // Only when both sides have them (older files don't)
                if (!Array.isArray(body.resources) || !Array.isArray(currentBody.resources)) return [];
                const mine = body.resources;
                const theirs = currentBody.resources;
                const withoutIds = ({ systemId, resourceDefinitionId, ...resource }) => resource;
                return [
                    ...mine.filter(r => !matchingResource(r, theirs)).map(r =>
                        `${RESOURCE}"${r.displayName}" (not in the system)`),
                    ...mine.filter(r => matchingResource(r, theirs) &&
                                        !same(withoutIds(r), withoutIds(matchingResource(r, theirs))))
                        .map(r => `${RESOURCE}"${r.displayName}"`),
                    ...theirs.filter(r => !matchingResource(r, mine)).map(r =>
                        `${RESOURCE}"${r.displayName}" (not in the file)`),
                ];
            }
            if (key === 'permissions') {
                // By ID, or else by name: HelloID gives a new set an ID of
                // its own, so the same set can have another ID in the file
                const mine = body.permissions ?? [];
                const theirs = currentBody.permissions ?? [];
                const match = (set, sets) => sets.find(o => o.identification === set.identification) ??
                    sets.find(o => o.displayName === set.displayName);
                const withoutId = ({ identification, ...set }) => set;
                return [
                    ...mine.filter(set => !match(set, theirs)).map(set =>
                        `${PERMISSION_SET}"${set.displayName}" (not in the system)`),
                    ...mine.filter(set => match(set, theirs) && !same(withoutId(set), withoutId(match(set, theirs))))
                        .map(set => `${PERMISSION_SET}"${set.displayName}"`),
                    ...theirs.filter(set => !match(set, mine)).map(set =>
                        `${PERMISSION_SET}"${set.displayName}" (not in the file)`),
                ];
            }
            if (key === CORRELATION) {
                // The field by its name instead of its ID
                const named = (c) => c[CORRELATION] && {
                    ...c[CORRELATION],
                    accountFieldId: mappingFieldName(c, c[CORRELATION].accountFieldId),
                };
                return same(named(body), named(currentBody)) ? [] : [key];
            }
            if (key === 'dependOnSystems') {
                // Only which systems: the file also has their names
                const ids = (c) => (c.dependOnSystems ?? []).map(d => d.systemId).sort().join();
                return ids(body) === ids(currentBody) ? [] : [key];
            }
            if (key === 'scripts') {
                return keysOf(body.scripts, currentBody.scripts)
                    .filter(s => !same(body.scripts?.[s], currentBody.scripts?.[s]))
                    .map(s => `scripts.${s}`);
            }
            return same(body[key], currentBody[key]) ? [] : [key];
        });
    }

    // false: cancelled
    async function importSystem() {
        const text = await pickImportFile();
        if (text === null) return false;

        let data;
        try { data = JSON.parse(text); } catch { throw new Error('The file is not a valid JSON file.'); }
        if (!isPlainObject(data?.configuration) || typeof data.templateIdentifier !== 'string') {
            throw new Error('The file is not an export of a target system.');
        }
        const steps = IMPORT_STEPS[data.templateIdentifier];
        if (!steps) throw new Error(`Import is not supported for systems of type "${data.templateIdentifier}".`);
        // Older exports only have these inside the configuration
        const systemId = data.systemId ?? data.configuration.systemId;
        const fileName = data.displayName ?? data.configuration.displayName ?? '?';
        if (!systemId) throw new Error('The file has no system ID. Export the system again.');

        // The file has to be right in itself: correlation that is on needs
        // its field in the file's own mapping
        const fileFields = data.configuration.mappingConfiguration?.fields ?? [];
        const fileCorrelation = data.configuration.correlationConfiguration;
        if (fileCorrelation?.enabled === true &&
            !fileFields.some(f => f.identifier === fileCorrelation.accountFieldId)) {
            throw new Error('Correlation is on in the file, but its field (correlationConfiguration.accountFieldId: ' +
                            `${fileCorrelation.accountFieldId}) is not in the mapping of the file. ` +
                            'Nothing was imported.');
        }

        const systems = await fetchSystems();
        // Dependencies that aren't here: the user decides, before anything
        // else. First those with only a system of the same name here (it
        // is another system than the one of the file): use these, leave
        // them out, or stop.
        const header = `File: export of "${fileName}" from ${data.exportedFrom ?? '?'}, ${data.exportedAt ?? '?'}`;
        const notHere = missingDependencies(data.configuration, systems);
        const onlyByName = (d) => !systems.some(s => s.systemId === d.systemId) && findDependency(d, systems);
        const byName = (data.configuration.dependOnSystems ?? []).filter(onlyByName).map(d => {
            const found = findDependency(d, systems);
            const type = found.templateIdentifier === d.templateIdentifier ? `type ${found.templateIdentifier}`
                : `type ${found.templateIdentifier}, NOT the type in the file (${d.templateIdentifier})`;
            return `  - "${found.displayName}": ID in the file ${d.systemId}, ID here ${found.systemId} (${type})`;
        });
        if (byName.length) {
            const answer = await showDialog('Import: dependency matched by name', `${header}\n\n` +
                'The system depends on systems whose ID is not in this HelloID environment, but a target system ' +
                `with the same name is:\n${byName.join('\n')}\n\n` +
                'Continue: "Depends on systems" will point at these systems.\n' +
                'Continue without these: they are left out of "Depends on systems".\n' +
                'Cancel: stops the import.',
                { confirm: true, alternative: 'Continue without these' });
            if (!answer) return false;
            if (answer === 'alternative') {
                data.configuration = {
                    ...data.configuration,
                    dependOnSystems: data.configuration.dependOnSystems
                        .map(d => (onlyByName(d) ? { ...d, matchByName: false } : d)),
                };
            }
        }
        // Then those that aren't here at all
        if (notHere && !await showDialog('Import: dependency not found',
            `${header}${notHere}\n\nContinue the import without them?`, { confirm: true })) {
            return false;
        }
        // All that are left out, for the messages
        const missing = missingDependencies(data.configuration, systems);
        let system = systems.find(s => s?.systemId === systemId);
        const created = !system;
        if (created) system = await createSystemFor(data, fileName, systemId, steps, systems);
        if (!system) return false; // cancelled
        if (system.templateIdentifier !== data.templateIdentifier) {
            throw new Error(`The file is of a system of type "${data.templateIdentifier}", ` +
                            `but "${system.displayName}" is of type "${system.templateIdentifier}".`);
        }

        const id = encodeURIComponent(system.systemId);
        const currentPath = CONNECTOR_EXPORTS[system.templateIdentifier]?.(id).configuration;
        // The resources are a part of their own, in the file and in HelloID;
        // here they go along with the configuration
        const hasResources = Boolean(CONNECTOR_EXPORTS[system.templateIdentifier]?.(id).resources);
        let resourcesRead = true;
        const loadCurrent = async () => ({
            ...(currentPath ? await fetchFromGateway(currentPath) : system),
            systemId: system.systemId,
            isNew: created,
            resources: !hasResources ? undefined : await fetchFromGateway(POWERSHELL_RESOURCES_PATH(id)).catch(e => {
                console.warn('[HelloID UX] Import: could not read the resources', e);
                resourcesRead = false;
            }),
            agentSelection: await fetchFromGateway(AGENT_SELECTION_PATH(id)).catch(e => {
                console.warn('[HelloID UX] Import: could not read the agent selection', e);
                return [];
            }),
        });
        const current = await loadCurrent();
        const configuration = {
            ...restoreSecrets(data.configuration, current),
            resources: data.resources,
            // The tags and agent pools of the file; a file without them
            // (an older export), or with the same ones, changes nothing
            agentSelection: !Array.isArray(data.agents?.selected) ||
                            sameAgentSelection(data.agents.selected, current.agentSelection)
                ? current.agentSelection : data.agents.selected,
            isNew: created, // as in the current one: not a difference
            ...(Array.isArray(data.configuration.dependOnSystems)
                ? { dependOnSystems: resolveDependencies(data.configuration, systems) } : {}),
            // A new system starts disabled, whatever the file says, so it
            // does nothing before it has been checked
            ...(created ? { isDisabled: true } : {}),
        };
        const { requests: newNotifications, skipped: notificationsSkipped } =
            await notificationRequests(data, systemId, system);
        const ruleWork = await ruleRequests(data, system, created, header);
        if (!ruleWork) return false; // cancelled
        const ruleDrafts = ruleWork.requests;
        const notCompared = !hasResources ? null : !Array.isArray(data.resources) ? 'the file has no resources (export the system again)'
            : !resourcesRead ? 'HelloID did not return the resources of the system'
            : null;

        // Everything that differs, and which of it a known request can write
        // (a part that several requests send is listed with the first one)
        const importable = new Set();
        const work = steps.map(step => {
            const changes = (step.changes?.(configuration, current) ??
                             changedParts(step.body(configuration, current, systems), step.body(current, current, systems)))
                .filter(c => !importable.has(c));
            changes.forEach(c => importable.add(c));
            return { step, changes };
        }).filter(w => w.changes.length);
        const others = changedParts(configuration, current).filter(c => !importable.has(c));

        // A new name must not be in use by another system: stop right here
        if (!created && importable.has('displayName') && typeof configuration.displayName === 'string' &&
            await fetchFromGateway(NAME_EXISTS_PATH(configuration.displayName)) === true) {
            throw new Error(`Another target system is already named "${configuration.displayName}". ` +
                            'Nothing was imported.');
        }

        const from = `File: export of "${fileName}" from ${data.exportedFrom ?? '?'}, ` +
                     `${data.exportedAt ?? '?'}`;
        const skipped = (notCompared ? `\n\nResources were not compared: ${notCompared}.` : '') + missing +
                        notificationsSkipped + ruleWork.skipped;
        const describe = (title, changes) => `${title}:\n` + changes.map(c => `  - ${c}`).join('\n');
        const unsupported = others.length ? `\n\n${describe('Not importable, left as is', others)}` : '';
        if (!work.length && !newNotifications.length && !ruleDrafts.length) {
            await showDialog('Import', `${from}\n\n` + (created ? `Created "${system.displayName}". ` : '') +
                (others.length
                    ? `Nothing to import into "${system.displayName}".${unsupported}`
                    : `"${system.displayName}" already has the configuration of the file.`) + skipped);
            return true;
        }

        // What to send: the steps with changes, plus, when the mapping is
        // replaced, the steps that point at mapping fields (new IDs)
        const replacesMapping = work.some(w => w.step.resetsFieldIds);
        const plan = steps.filter(step => work.some(w => w.step === step) ||
                                          (replacesMapping && step.usesFieldIds));
        const parts = plan.map(step => {
            const changes = work.find(w => w.step === step)?.changes;
            const title = step.name + (step.note ? ` (${step.note})` : '');
            return changes ? describe(title, changes) : `${title}:\n  - set again after the mapping is changed`;
        });
        if (newNotifications.length) {
            parts.push(describe('Notifications',
                newNotifications.map(r => r.name)));
        }
        if (ruleDrafts.length) {
            parts.push(describe('Business rules (saved as DRAFTS, not published: publish them yourself in HelloID)',
                ruleDrafts.flatMap(r => r.changes)));
        }

        // Build every request once before sending any, so a problem in the
        // file stops the import before anything is changed. (After the
        // mapping step the system has the fields of the file.)
        const afterMapping = replacesMapping
            ? { ...current, mappingConfiguration: configuration.mappingConfiguration } : current;
        plan.forEach(step => step.body(configuration, step.usesFieldIds ? afterMapping : current, systems));

        // A system that was just made was confirmed already, and has
        // nothing to back up
        if (!created) {
            if (!await showDialog('Import', `${from}\n\nThis will overwrite in, or add to, "${system.displayName}":\n\n` +
                                  `${parts.join('\n\n')}${unsupported}${skipped}\n\n` +
                                  'A backup of the current configuration is downloaded first.', { confirm: true })) {
                return false;
            }
            await downloadBackup(system.displayName.trim());
        }

        // Send, in order, showing each request and how it went; the first
        // error stops the import
        // (a step with requests of its own is sent as those)
        const requests = [
            ...plan.flatMap(step => step.requests?.(configuration, current) ?? [...(step.before ?? []), step]),
            ...newNotifications,
            ...ruleDrafts,
        ];
        const first = created ? 1 : 0; // a new system: it was made before this
        const progress = showProgress(
            `${created ? 'Creating' : 'Importing into'} "${system.displayName}"`,
            [...(created ? ['Create new system'] : []), ...requests.map(r => r.name)]);
        if (created) progress.set(0, 'done');

        let latest = current;
        let index = first;
        try {
            for (const request of requests) {
                if (request.when && !request.when(latest)) {
                    progress.set(index++, 'skipped'); // not needed
                    continue;
                }
                progress.set(index, 'busy');
                // (run: a request that takes more than one call)
                if (request.run) await request.run(id);
                else await sendToGateway(request.path(id), request.method, request.body?.(configuration, latest, systems));
                if (request.resetsFieldIds) latest = await loadImportedFields(loadCurrent, fileFields);
                progress.set(index++, 'done');
            }
        } catch (e) {
            console.warn('[HelloID UX] Import failed', e);
            progress.set(index, 'failed');
            await progress.finish(`Import failed: ${e?.message ?? e}\n\n` +
                (index > first ? 'The steps before it were done; the ones after it were not. '
                    : created ? 'Only the new system was made. ' : 'Nothing was changed. ') +
                (created ? 'The new system is in the list of target systems.'
                    : 'The backup file has the configuration from before the import.'));
            // Already shown to the user
            throw Object.assign(new Error(String(e?.message ?? e)), { shown: true });
        }

        // A file without secrets: those kept the values the system had
        const masked = Object.entries(data.configuration.scriptConfiguration ?? {})
            .filter(([, value]) => value === EXPORT_MASK).map(([key]) => key);
        const secrets = data.secretsIncluded !== false ? ''
            : '\n\nThe file was exported without secrets. ' +
              (created ? 'They are empty in the new system' : 'They kept the values the system already had') +
              (masked.length ? ` (${masked.join(', ')})` : '') +
              (created ? ': set them by hand.' : ': check them, and set them by hand where needed.');
        const draftsNote = !ruleWork.drafts() ? ''
            : `\n\n${ruleWork.drafts()} business rule(s) were saved as DRAFTS. They do nothing until you publish ` +
              'them in HelloID (Business rules; they are marked as having a draft).';
        const disabled = !created ? ''
            : '\n\nThe new system is DISABLED. Check it, and enable it yourself when it is ready.';
        await progress.finish(`Import finished.${disabled}${secrets}${missing}${notificationsSkipped}${ruleWork.skipped}${draftsNote}\n\n` +
                              'The page reloads when you close this message.');
        location.reload(); // show the changes
        return true;
    }

    // The file's system isn't in this environment: make a new, empty one
    // for it, after a confirmation. Returns the new system as in the list
    // of systems, or null when cancelled. Everything that can be checked
    // is checked first, so no empty system is left behind for a file that
    // can't be imported.
    async function createSystemFor(data, fileName, systemId, steps, systems) {
        const createPath = CREATE_PATHS[data.templateIdentifier];
        if (!createPath) {
            throw new Error(`The system of the file ("${fileName}", ID ${systemId}) was not found in this ` +
                            `HelloID environment, and systems of type "${data.templateIdentifier}" can't be created.`);
        }
        const name = data.configuration.displayName;
        if (typeof name === 'string' && await fetchFromGateway(NAME_EXISTS_PATH(name)) === true) {
            throw new Error(`The system of the file (ID ${systemId}) was not found in this HelloID environment, ` +
                            `and a new one can't be made: another target system is already named "${name}". ` +
                            'Nothing was imported.');
        }
        // Build every request once, as if for a system that already has
        // the mapping of the file
        const configuration = { ...data.configuration, resources: data.resources };
        const empty = { systemId: '', isNew: true, resources: [], mappingConfiguration: configuration.mappingConfiguration };
        steps.forEach(step => step.body(configuration, empty, systems));

        if (!await showDialog('Import: new system',
            `File: export of "${fileName}" from ${data.exportedFrom ?? '?'}, ${data.exportedAt ?? '?'}\n\n` +
            `This HelloID environment has no target system with the ID of the file (${systemId}).\n\n` +
            `A NEW target system "${name}" (type ${data.templateIdentifier}) will be created, and the ` +
            'configuration of the file is then imported into it.\n\n' +
            'The new system will be DISABLED, also when the system of the file is enabled, so it does ' +
            'nothing before you have checked it. Enable it yourself when it is ready.' +
            (data.secretsIncluded === false
                ? '\n\nThe file has no secrets: those will be empty in the new system.' : '') +
            missingDependencies(data.configuration, systems),
            { confirm: true })) {
            return null;
        }
        const newId = await sendToGateway(createPath, 'POST', {});
        if (typeof newId !== 'string' || !newId) {
            throw new Error('HelloID did not return the ID of the new system. Check the list of target systems.');
        }
        return { systemId: newId, displayName: name, templateIdentifier: data.templateIdentifier };
    }

    // After the mapping is replaced: the system with its new fields (and
    // their new IDs). HelloID may need a moment before it shows them.
    async function loadImportedFields(loadCurrent, fileFields) {
        for (let attempt = 0; ; attempt++) {
            const current = await loadCurrent();
            const names = new Set((current.mappingConfiguration?.fields ?? []).map(f => f.name));
            if (fileFields.every(f => names.has(f.name))) return current;
            if (attempt >= 9) {
                throw new Error('The mapping fields were sent, but HelloID does not show them (yet).');
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // The system as it is now, saved as a normal download (no save dialog:
    // that needs a click of its own)
    async function downloadBackup(name) {
        const json = JSON.stringify(await collectSystemExport(name), null, 2);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        link.download = exportFileName(`${name} - backup before import`, name);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    }

    async function sendToGateway(path, method, body) {
        const response = await origFetch.call(pageWindow, gateway.origin + path, {
            method,
            headers: body === undefined ? gateway.headers : { ...gateway.headers, 'Content-Type': 'application/json' },
            credentials: gateway.withCredentials ? 'include' : 'same-origin',
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 300);
            throw new Error(`HelloID answered ${response.status} for ${method} ${path}` + (detail ? `\n${detail}` : ''));
        }
        // The answer, if any (most requests have none)
        const answer = await response.text().catch(() => '');
        try { return JSON.parse(answer); } catch { return answer; }
    }

    const IMPORT_BTN_CLASS = 'tm-import-system';

    // Next to HelloID's "Add new system" button on the target systems page
    function addImportButton() {
        const addBtn = document.querySelector('button[data-cy="add-target-system"]');
        if (!addBtn || addBtn.parentElement.querySelector(`.${IMPORT_BTN_CLASS}`)) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn-xs btn-default ${IMPORT_BTN_CLASS}`;
        btn.title = 'Import the configuration from an exported JSON file';
        // The header spreads its items out: keep this one with the Add button
        btn.style.marginLeft = 'auto';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-upload';
        btn.appendChild(icon);

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            icon.className = 'fa-solid fa-spinner fa-spin';
            let result = 'fa-solid fa-upload';
            try {
                if (await importSystem()) result = 'fa-solid fa-check';
            } catch (err) {
                if (!err?.shown) console.warn('[HelloID UX] Import failed', err);
                result = 'fa-solid fa-xmark';
                if (!err?.shown) await showDialog('Import failed', String(err?.message ?? err));
            }
            icon.className = result;
            btn.disabled = false;
            setTimeout(() => { icon.className = 'fa-solid fa-upload'; }, SETTINGS.copyFeedbackMs);
        });
        addBtn.before(btn);
    }

    function findTileByName(name) {
        return [...document.querySelectorAll(SYSTEM_TILE)]
            .find(t => t.querySelector('h5.system-header')?.textContent.trim() === name);
    }

    function buildSystemRow(row, model, index) {
        const tr = document.createElement('tr');
        tr.dataset.index = index; // HelloID's order, for "no sort" and ties
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

        // Name: icon, name, extra labels; copy, export and configure buttons pinned
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

        pinButtons(nameCell, createCopyButton(() => row.name, 'btn btn-default btn-xs'),
            createExportButton(() => row.name),
            createExportButton(() => row.name, undefined, EXPORT_KINDS.granted), configure);

        // Summary since, Last updated, Actions, ...
        model.infoLabels.forEach(label => {
            const value = row.info.find(i => i.label === label)?.value ?? '';
            const cell = td(value);
            if (CENTERED_LABELS.has(LABEL_RENAMES[label] ?? label)) cell.classList.add('tm-center');
            if (SORTABLE_LABELS.has(label)) {
                cell.dataset.sortValue = parseDate(value, model.dateOrder) ?? '';
            }
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

        // Sort buttons: black ▲/▼ for the column that's sorted on, a grey icon
        // for the others; and the rows in that order
        const sort = effectiveSort();
        table.querySelectorAll('thead button[data-sort]').forEach(btn => {
            const isName = btn.dataset.sort === NAME_SORT_KEY;
            const active = sort.column === btn.dataset.sort;
            const dir = active ? sort.dir : null;
            setSortIndicator(btn, dir);
            const color = statusColor[active ? ButtonStatus.ENABLED : ButtonStatus.UNKNOWN];
            if (btn.style.color !== color) btn.style.color = color;
            const title = isName
                ? (active && dir === 'asc' ? 'Sorted by name, A-Z (default). Click for Z-A.'
                    : active ? 'Sorted by name, Z-A. Click for A-Z.'
                    : 'Click to sort by name, A-Z (default)')
                : (dir === 'desc' ? 'Sorted descending. Click to sort ascending.'
                    : dir === 'asc' ? 'Sorted ascending. Click to sort descending.'
                    : 'Click to sort descending');
            if (btn.title !== title) btn.title = title;
        });
        sortSystemRows(table);

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
            alignHeaderButtons(table);
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
            rows.forEach((r, i) => tbody.appendChild(buildSystemRow(r, model, i)));
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
    // Grids: filter buttons on the icon of a row
    // =====================================================================
    // Some grids have a nameless column with an icon per row. Its header
    // gets a filter button for each icon, with the number of rows that
    // have it; grey = off, black = only those. A row has one icon at
    // most, so with several buttons on, a row needs any of them.
    // These grids load their rows page by page from the server, so the
    // filtering happens on the request (see Response interception), and a
    // click makes the grid load its rows again.
    //   grid:    the grid
    //   route:   only on pages with this in their address
    //   header:  only grids with this column (the host can hold others)
    //   flags:   the buttons; test: does this row have the icon?

    const FLAG_GROUP_CLASS = 'tm-grid-flags';

    const notInTargetSystem = (e) => e.inTargetSystem === false;

    // Evaluation actions: entitlementType of a row
    const EntitlementType = Object.freeze({ ACCOUNT: 1, ACCOUNT_ACCESS: 2, PERMISSION: 3 });

    const FLAG_GRIDS = {
        // Business rules > Entitlements: entitlements the target system no
        // longer returns; a warning when business rules still use them, an
        // info icon when not
        entitlements: {
            grid: 'helloid-entitlement-grid ag-grid-angular',
            storageKey: 'tm-helloid-entitlement-flags', // in sessionStorage
            flags: [
                {
                    key: 'warning',
                    icon: 'fa-solid fa-warning',
                    label: 'entitlements no longer in the target system, but still used in business rules',
                    test: (e) => notInTargetSystem(e) && e.ruleCount > 0,
                },
                {
                    key: 'info',
                    icon: 'fa-solid fa-info-circle',
                    label: 'entitlements no longer in the target system, not used in business rules',
                    test: (e) => notInTargetSystem(e) && !(e.ruleCount > 0),
                },
            ],
        },
        // Business rules > Evaluations > Actions: the type of entitlement
        actions: {
            grid: 'helloid-tab-control ag-grid-angular',
            route: EVALUATIONS_ROUTE,
            header: 'Operation',
            storageKey: 'tm-helloid-action-flags',
            flags: [
                {
                    key: 'account',
                    icon: 'fa-solid fa-user',
                    label: 'actions on accounts',
                    test: (a) => a.entitlementType === EntitlementType.ACCOUNT,
                },
                {
                    key: 'access',
                    icon: 'fa-solid fa-unlock',
                    label: 'actions on account access',
                    test: (a) => a.entitlementType === EntitlementType.ACCOUNT_ACCESS,
                },
                {
                    key: 'permission',
                    icon: 'fa-solid fa-users',
                    label: 'actions on permissions',
                    test: (a) => a.entitlementType === EntitlementType.PERMISSION,
                },
            ],
        },
    };
    // Counts per flag, from the last full set of rows; counted once per
    // set (the same cached set comes by for every page of the grid)
    Object.entries(FLAG_GRIDS).forEach(([name, config]) =>
        Object.assign(config, { name, counts: {}, counted: null }));

    const activeGridFlags = (config) => {
        const flags = sessionGet(config.storageKey, []);
        return Array.isArray(flags) ? flags : [];
    };

    // Called with all rows (see INTERCEPTS): count, then filter
    function filterByFlags(config, all) {
        if (all !== config.counted) {
            config.counted = all;
            config.counts = Object.fromEntries(
                config.flags.map(f => [f.key, all.filter(f.test).length]));
            setTimeout(() => updateGridFlagButtons(config)); // not while the app reads the response
        }

        const on = activeGridFlags(config);
        const active = config.flags.filter(f => on.includes(f.key));
        return active.length ? all.filter(row => active.some(f => f.test(row))) : all;
    }

    const flagGroup = (config) =>
        document.querySelector(`.${FLAG_GROUP_CLASS}[data-flag-grid="${config.name}"]`);

    function createGridFlagButton(config, flag, gridEl) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-default btn-xs';
        btn.dataset.gridFlag = flag.key;
        const icon = document.createElement('i');
        icon.className = flag.icon;
        btn.append(icon, ' ', document.createElement('span'));
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const active = activeGridFlags(config);
            sessionSet(config.storageKey, active.includes(flag.key)
                ? active.filter(k => k !== flag.key)
                : [...active, flag.key]);
            updateGridFlagButtons(config);
            // Load the rows again, through the filter
            const api = findGridApi(gridEl);
            if (typeof api?.purgeInfiniteCache === 'function') api.purgeInfiniteCache();
            else api?.refreshInfiniteCache?.();
        });
        return btn;
    }

    // Look and count of the buttons
    function updateGridFlagButtons(config) {
        const active = activeGridFlags(config);
        flagGroup(config)?.querySelectorAll('button[data-grid-flag]').forEach(btn => {
            const flag = config.flags.find(f => f.key === btn.dataset.gridFlag);
            const on = active.includes(flag.key);
            const n = config.counts[flag.key];
            const color = statusColor[on ? ButtonStatus.ENABLED : ButtonStatus.UNKNOWN];
            if (btn.style.color !== color) btn.style.color = color;
            setText(btn.querySelector('span'), n == null ? '' : String(n));
            const count = n == null ? '' : ` (${n})`;
            const title = on
                ? `Showing only ${flag.label}${count}. Click to show all.`
                : `Show only ${flag.label}${count}`;
            if (btn.title !== title) btn.title = title;
        });
        fitFlagColumn(config);
    }

    function addGridFlagButtons() {
        Object.values(FLAG_GRIDS).forEach(config => {
            if (config.route && !location.hash.includes(config.route)) return;

            const headersOf = (g) => [...g.querySelectorAll('.ag-header-cell')];
            const gridEl = [...document.querySelectorAll(config.grid)].find(g => !config.header ||
                headersOf(g).some(h => h.textContent.trim().toLowerCase() === config.header.toLowerCase()));
            if (!gridEl) return;

            // The nameless column: the last header without text
            const header = headersOf(gridEl)
                .filter(h => !h.textContent.trim() || h.querySelector(`.${FLAG_GROUP_CLASS}`))
                .pop();
            if (!header || header.querySelector(`.${FLAG_GROUP_CLASS}`)) return;

            const group = document.createElement('span');
            group.className = FLAG_GROUP_CLASS;
            group.dataset.flagGrid = config.name;
            Object.assign(group.style, { display: 'flex', gap: '2px', flexShrink: '0' });
            config.flags.forEach(f => group.appendChild(createGridFlagButton(config, f, gridEl)));
            (header.querySelector('.ag-header-cell-comp-wrapper') ?? header).appendChild(group);
            updateGridFlagButtons(config);
        });
    }

    // Make the column at least as wide as its buttons need. Done again when
    // the counts change (more digits, wider buttons); a minimum width only
    // grows, so this settles.
    function fitFlagColumn(config) {
        const group = flagGroup(config);
        const header = group?.closest('.ag-header-cell');
        const api = header && findGridApi(header.closest('ag-grid-angular'));
        if (!api || !group.offsetWidth) return;
        const style = getComputedStyle(header);
        const needed = Math.ceil(group.offsetWidth +
            (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)) + 8;
        setMinColumnWidth(api, header.getAttribute('col-id'), needed);
    }

    // =====================================================================
    // Persons > Rules: filter on the status ("in rule")
    // =====================================================================
    // The Status header gets a filter button: grey = all rules, black =
    // only rules the person is in, red = only rules the person is not in
    // (same colors as the other filters).
    // The grid loads the rules page by page, and HelloID gets the rules
    // the person is in from a second request. So all rules are fetched
    // once and filtered on the request (see Response interception), with
    // the IDs from that second request (see WATCHES); a click makes the
    // grid load its rows again.

    const RULE_STATUS_COLUMN = 'inRule'; // column ID
    const RULE_STATUS_CLASS = 'tm-rule-status-filter';
    const RULE_STATUS_KEY = 'tm-helloid-person-rule-status'; // in sessionStorage

    const ruleStatus = () => {
        const status = sessionGet(RULE_STATUS_KEY, null);
        return statusOrder.includes(status) ? status : ButtonStatus.UNKNOWN;
    };

    let personRuleIds = null; // Set: the rules the selected person is in

    // Called with all rules (see INTERCEPTS)
    function filterPersonRules(all) {
        const status = ruleStatus();
        if (status === ButtonStatus.UNKNOWN || !personRuleIds) return all;
        const inRule = status === ButtonStatus.ENABLED;
        return all.filter(rule => personRuleIds.has(rule.ruleId) === inRule);
    }

    // Called with the rule IDs of the selected person (see WATCHES). With
    // a filter on, another person means other rows; only when the IDs
    // really changed, as loading the rows may ask for the IDs again.
    function onPersonRules(ids) {
        if (!Array.isArray(ids)) return;
        const changed = !personRuleIds || personRuleIds.size !== ids.length ||
                        ids.some(id => !personRuleIds.has(id));
        personRuleIds = new Set(ids);
        if (!changed) return;
        setTimeout(() => { // not while the app reads the response
            updateRuleStatusButtons();
            if (ruleStatus() !== ButtonStatus.UNKNOWN) reloadPersonRules();
        });
    }

    function reloadPersonRules() {
        document.querySelectorAll(AG_GRIDS).forEach(gridEl => {
            if (!hasHeader(gridEl, PERSON_RULES_GRID)) return;
            const api = findGridApi(gridEl);
            if (typeof api?.purgeInfiniteCache === 'function') api.purgeInfiniteCache();
            else api?.refreshInfiniteCache?.();
        });
    }

    function updateRuleStatusButtons() {
        const status = ruleStatus();
        const count = personRuleIds ? ` (${personRuleIds.size})` : '';
        const title = {
            [ButtonStatus.UNKNOWN]:  `Showing all rules. Click to show only the rules the person is in${count}.`,
            [ButtonStatus.ENABLED]:  `Showing only the rules the person is in${count}. Click for the rules the person is not in.`,
            [ButtonStatus.DISABLED]: 'Showing only the rules the person is not in. Click to show all rules.',
        }[status];
        document.querySelectorAll(`.${RULE_STATUS_CLASS}`).forEach(btn => {
            if (btn.style.color !== statusColor[status]) btn.style.color = statusColor[status];
            if (btn.title !== title) btn.title = title;
        });
    }

    function addRuleStatusFilter() {
        if (!location.hash.includes(PERSON_RULES_ROUTE)) return;
        document.querySelectorAll(AG_GRIDS).forEach(gridEl => {
            if (!hasHeader(gridEl, PERSON_RULES_GRID)) return;
            const header = gridEl.querySelector(`.ag-header-cell[col-id="${RULE_STATUS_COLUMN}"]`) ??
                [...gridEl.querySelectorAll('.ag-header-cell')]
                    .find(h => h.textContent.trim().toLowerCase() === 'status');
            if (!header || header.querySelector(`.${RULE_STATUS_CLASS}`)) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `btn btn-default btn-xs ${RULE_STATUS_CLASS}`;
            // On the right side of the header: after the label, wherever
            // the grid puts that in the wrapper
            Object.assign(btn.style, { flexShrink: '0', marginLeft: 'auto', order: '1' });
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-filter';
            btn.appendChild(icon);
            btn.addEventListener('mousedown', (e) => e.stopPropagation());
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                sessionSet(RULE_STATUS_KEY, nextStatus(ruleStatus()));
                updateRuleStatusButtons();
                reloadPersonRules(); // through the filter
            });
            (header.querySelector('.ag-header-cell-comp-wrapper') ?? header).appendChild(btn);
            updateRuleStatusButtons();
        });
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

    // Minimum widths we need for some columns (room for our buttons), per
    // grid API: { colId: px }. Set through the column definitions, so the
    // grid keeps them, also when it fits the columns to its width again.
    const minColumnWidths = new WeakMap();

    const columnKey = (d) => d.colId ?? d.field;

    function needsResizable(defs, mins = {}) {
        return defs.some(d => d.children
            ? needsResizable(d.children, mins)
            : d.resizable !== true || d.maxWidth != null ||
              d.minWidth !== mins[columnKey(d)] ||
              (mins[columnKey(d)] != null && (d.width ?? 0) < mins[columnKey(d)]));
    }

    // Some columns are fixed-width (minWidth === maxWidth), which blocks
    // resizing even with resizable: true. Drop both limits; each column
    // keeps its current width as starting point. Only our own minimum
    // widths stay.
    function withResizable(defs, mins = {}) {
        return defs.map(d => {
            if (d.children) return { ...d, children: withResizable(d.children, mins) };
            const min = mins[columnKey(d)];
            return {
                ...d,
                resizable: true,
                minWidth: min,
                maxWidth: undefined,
                ...(min != null && (d.width ?? 0) < min ? { width: min } : {}),
            };
        });
    }

    function setMinColumnWidth(api, colId, px) {
        const mins = minColumnWidths.get(api) ?? {};
        if (mins[colId] >= px) return;
        mins[colId] = px;
        minColumnWidths.set(api, mins);
        applyResizable(api);
    }

    // Column widths (px) for grids whose own widths don't fit their
    // content, by page and header text. The columns start at these widths
    // and keep them when the grid fits its columns to its width; the
    // "fill" column, if any, takes the space that's left (at least
    // fillMin). requires: only grids that have a column with this header.
    const PAGE_COLUMN_WIDTHS = [
        {
            route: NOTIFICATIONS_ROUTE,
            fill: 'Name',
            fillMin: 250,
            widths: {
                'System': 370,
                'Event': 270,
                'Notification System': 180,
                'Enabled': 95,
                'Last changed on': 160,
            },
        },
        {
            route: PERSON_RULES_ROUTE,
            requires: PERSON_RULES_GRID,
            widths: {
                'Name': 250,
                'Entitlements': 210,
            },
        },
    ];

    const pageWidthGrids = new WeakSet(); // grids that have their widths

    function applyPageColumnWidths() {
        PAGE_COLUMN_WIDTHS.filter(c => location.hash.includes(c.route)).forEach(({ widths, fill, fillMin, requires }) => {
            const byHeader = Object.fromEntries(
                Object.entries(widths).map(([header, px]) => [header.toLowerCase(), px]));
            document.querySelectorAll(AG_GRIDS).forEach(gridEl => {
                if (pageWidthGrids.has(gridEl) || !hasHeader(gridEl, requires)) return;
                const headers = [...gridEl.querySelectorAll('.ag-header-cell')];
                const api = headers.length && findGridApi(gridEl);
                if (!api) return; // grid not ready yet; the observer will retry
                pageWidthGrids.add(gridEl);

                // Per column ID: what to change in its definition
                const props = {};
                let fillId;
                headers.forEach(h => {
                    const text = h.textContent.trim().toLowerCase();
                    const id = h.getAttribute('col-id');
                    if (fill && text === fill.toLowerCase()) {
                        fillId = id;
                        props[id] = { flex: 1 };
                    } else if (byHeader[text]) {
                        props[id] = { width: byHeader[text], flex: undefined, suppressSizeToFit: true };
                    }
                });
                setColumnProps(api, props);
                if (fillId != null) setMinColumnWidth(api, fillId, fillMin);
            });
        });
    }

    function setColumnProps(api, props) {
        const merge = (defs) => defs.map(d => d.children
            ? { ...d, children: merge(d.children) }
            : { ...d, ...props[columnKey(d)] });
        const defs = api.getColumnDefs();
        if (defs) setColumnDefs(api, merge(defs));
    }

    // Set while we update the columns, so the resulting newColumnsLoaded
    // event doesn't trigger another update (endless loop if the grid puts
    // a default minWidth back).
    let applyingResizable = false;

    function applyResizable(api) {
        if (applyingResizable) return;
        const defs = api.getColumnDefs();
        const mins = minColumnWidths.get(api);
        if (!defs || !needsResizable(defs, mins)) return;
        setColumnDefs(api, withResizable(defs, mins));
    }

    function setColumnDefs(api, newDefs) {
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

        /* Our own dialog (see showDialog) */
        .${DIALOG_CLASS} {
            width: min(800px, 92vw);
            max-height: 85vh;
            padding: 20px;
            border: none;
            border-radius: 6px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, .3);
            color: inherit;
        }
        .${DIALOG_CLASS}[open] { display: flex; flex-direction: column; gap: 15px; }
        .${DIALOG_CLASS}::backdrop { background: rgba(0, 0, 0, .4); }
        .${DIALOG_CLASS} h5 { margin: 0; }
        /* The message: scrolls, wraps, and can be selected */
        .${DIALOG_CLASS} pre {
            flex: 1;
            min-height: 0;
            overflow: auto;
            margin: 0;
            padding: 0;
            border: none;
            background: none;
            font: inherit;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            user-select: text;
        }
        .tm-dialog-footer { display: flex; gap: 8px; }
        /* Copy: the color of the main button, lighter */
        .tm-dialog-copy { opacity: .55; }
        .tm-dialog-copy:hover, .tm-dialog-copy:focus { opacity: .8; }

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

        // Cached full responses: fetch fresh data on the new page
        fullResponses.clear();

        // Entitlements filters (the object is shared, so clear it in place)
        if (Object.keys(filterState).length) {
            Object.keys(filterState).forEach(k => delete filterState[k]);
            saveState(filterState);
            // Redraw the buttons, if they're on the page already
            document.getElementById(FILTER_DIV_ID)?.remove();
        }

        // Target systems list: symbol filters and sort order
        if (activeFlags().length || getSort()) {
            sessionSet(FLAG_FILTERS_KEY, []);
            sessionSet(SORT_KEY, null);
            applySystemsView();
        }

        // Persons > Rules: status filter
        if (ruleStatus() !== ButtonStatus.UNKNOWN) {
            sessionSet(RULE_STATUS_KEY, null);
            updateRuleStatusButtons();
        }

        // Grids: icon filters
        Object.values(FLAG_GRIDS).forEach(config => {
            if (!activeGridFlags(config).length) return;
            sessionSet(config.storageKey, []);
            updateGridFlagButtons(config);
        });
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
                addImportButton();
                addGridFlagButtons();
                hideLimitWarnings();
                addRuleStatusFilter();
                addFilterPanelSearch();
                makeGridsResizable();
                applyPageColumnWidths();
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
