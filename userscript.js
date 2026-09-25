// ==UserScript==
// @name         HelloID UX improvements
// @namespace    http://tampermonkey.net/
// @version      2026-09-25.1
// @description  Adds custom improvements to the HelloID admin and provisioning interfaces.
// @author       Master-Guy
// @match        https://*.helloid.com/*
// @icon         https://www.svgrepo.com/show/530424/copy.svg
// @run-at       document-start
// @grant        none
// ==/UserScript==


(function () {
    'use strict';

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
        [ButtonStatus.UNKNOWN]:  '#cdcdcd',
        [ButtonStatus.ENABLED]:  'black',
        [ButtonStatus.DISABLED]: 'red',
    };

    const FILTERS = [
        { key: 'account',     field: 'accountEntitlementForSystem',       icon: 'fa-user',      title: 'Account entitlement' },
        { key: 'access',      field: 'accountAccessEntitlementForSystem', icon: 'fa-lock-open', title: 'Account access entitlement' },
        { key: 'permissions', field: 'permissionEntitlementForSystem',    icon: 'fa-users',     title: 'Permission entitlement(s)' },
    ];

    const STORAGE_KEY = 'tm-helloid-entitlement-filters';

    function loadState() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    }

    function saveState(state) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            console.warn('Could not save filter state', e);
        }
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

    const TARGET = /\/entitlements-overview(\?|$)/;

    // Field the grid uses to decide how many rows exist
    const COUNT_KEYS = ['totalRowCount'];

    // Always ask the server for everything, but remember which page the app wanted.
    function rewriteUrl(url) {
        const u = new URL(url, location.href);
        const skipParam = u.searchParams.get('skip');
        const takeParam = u.searchParams.get('take');
        const page = {
            skip: parseInt(skipParam, 10) || 0,
            take: takeParam === null ? Infinity : (parseInt(takeParam, 10) || Infinity),
        };
        u.searchParams.set('skip', '0');
        u.searchParams.set('take', '99999');
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
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
        const url = input instanceof Request ? input.url : String(input);
        if (!TARGET.test(url)) return origFetch.call(this, input, init);

        const page = rewriteUrl(url);
        const newInput = input instanceof Request ? new Request(page.url, input) : page.url;
        const response = await origFetch.call(this, newInput, init);

        const text = await response.clone().text();
        const modified = new Response(modifyJsonText(text, page), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
        Object.defineProperty(modified, 'url', { value: url });
        return modified;
    };

    // --- XMLHttpRequest ---
    const proto = XMLHttpRequest.prototype;
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
    const RELOAD_DELAY_MS = 1500;
    let reloadTimer;
    function scheduleReload() {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => location.reload(), RELOAD_DELAY_MS);
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
            setTimeout(() => { icon.className = 'fa-solid fa-copy'; }, 1000);
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
            // Pin the button to the right edge of the cell
            Object.assign(btn.style, {
                position: 'absolute',
                right: '4px',
                top: '50%',
                transform: 'translateY(-50%)',
            });

            // Positioning context for the button (AG Grid cells normally
            // already are, but just in case)
            if (getComputedStyle(cell).position === 'static') {
                cell.style.position = 'relative';
            }

            // Reserve room so long names end in "..." before the button
            cell.style.paddingRight = '36px';

            cell.appendChild(btn);
        });
    }

    function addCopyButtons() {
        addSystemTileCopyButtons();
        addRuleGridCopyButtons();
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
                if (isEntitlementsPage()) addFilterOptions();
                addCopyButtons();
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
