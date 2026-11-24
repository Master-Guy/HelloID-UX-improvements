// Runs the import of the real userscript (HelloID-UX-improvements.user.js, read at test time) in
// Node: its sections are cut out by marker strings and run with new Function, with stubs for what
// comes from the browser (dialogs, the page, downloads). Its requests go to the fake HelloID. Used by
// the equivalence test, which compares its overview and its requests with those of the server's port.
//
// Stubbed: showDialog (Overwrite all is chosen), chooseDecisions (the given answers, else the
// defaults), showOverview (records the entries; confirms or not), showProgress, downloadFile and the
// collect*Export backups (the backup is not ported), location, crypto.randomUUID (the given IDs),
// setTimeout (at once), fetchFromGateway / sendToGateway / fetchSystems (to the fake gateway).
// One edit of the code: importFiles goes to Overwrite all for a single file too, as the server does.

import { readFileSync } from 'node:fs';

const SOURCE = new URL('../../HelloID-UX-improvements.user.js', import.meta.url);

/** The text from a start marker up to (not including) an end marker. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`Marker not found in the userscript: ${start}`);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`Marker not found in the userscript: ${end}`);
  return text.slice(from, to);
}

/** One function declaration: from its start up to the first line that closes it at the same indent. */
function declaration(text: string, start: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`Marker not found in the userscript: ${start}`);
  const to = text.indexOf('\n    }\n', from);
  return text.slice(from, to + '\n    }\n'.length);
}

/** One line. */
function line(text: string, start: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`Marker not found in the userscript: ${start}`);
  return text.slice(from, text.indexOf('\n', from) + 1);
}

function buildSource(): string {
  const text = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const importFiles = between(text, '    async function importFiles(', '    // The browser opens a file picker')
    // (one file: Overwrite all too, as the server)
    .replace('if (only ? skipped.length || kinds.length > 1 : files.length > 1 || skipped.length) {', 'if (true) {');
  if (!importFiles.includes('if (true) {')) throw new Error('importFiles changed: the harness edit does not apply');
  const sections = [
    between(text, '    const DEFAULTS = Object.freeze({', '    // --- Settings menu'),
    declaration(text, '    function setPath(obj, path, value) {'),
    line(text, '    const uniqueBy = '),
    between(text, '    const FILTERS = [', '\n    ];\n') + '\n    ];\n',
    between(text, '    const SYSTEMS_PATH = ', '    async function fetchFromGateway(path) {'),
    line(text, '    const POWERSHELL_V1 = '),
    line(text, '    const POWERSHELL_V2 = '),
    between(text, '    const CORRELATION = ', '    const IMPORT_BTN_CLASS').replace('async function sendToGateway(', 'async function originalSendToGateway('),
    between(text, '    const NOTIFICATION_SYSTEM_PATH = ', '    // --- The buttons ---\n    function addNotificationButtons'),
    between(text, '    const SOURCE_SYSTEMS_PATH = ', '    // --- The buttons ---\n    function addSourceSystemButtons'),
    between(text, '    let importBatch', '    // The special cases, all in one dialog').replace('async function pickImportFiles(', 'async function originalPickImportFiles('),
    between(text, '    async function overwriteAll(', '    // Picks files and imports each'),
    importFiles,
  ];
  return `${sections.join('\n')}\nreturn { importFiles, PLANNERS };`;
}

export interface HarnessOptions {
  gatewayUrl: string;
  portalUrl: string;
  token: string;
  /** The answers to the special cases. */
  answers?: Record<string, unknown>;
  /** Confirm the overview (then the import runs). */
  confirm: boolean;
  uuid: () => string;
  /** The time of Date.now(); setTimeout moves it on. */
  clock: { now: number };
}

export interface HarnessResult {
  /** The entries as the overview showed them before the run. */
  planned: Array<{ group: string; label: string; status: string; details: string[] }>;
  /** After the run. */
  after: Array<{ group: string; label: string; status: string; details: string[] }>;
  decisions: Array<{ key: string; default: unknown }>;
  finish: string | null;
}

const snapshot = (entries: any[]) =>
  entries.map((e) => ({ group: e.group, label: e.label, status: e.status, details: [...e.details] }));

/** Imports files as the userscript's "Import HelloID export files…" with Overwrite all. */
export async function runUserscriptImport(picked: Array<{ name: string; text: string }>, options: HarnessOptions): Promise<HarnessResult> {
  const headers = (json: boolean) => ({
    Authorization: `Bearer ${options.token}`,
    Accept: 'application/json, text/plain, */*',
    Origin: options.portalUrl,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });
  const fetchFromGateway = async (path: string) => {
    const response = await fetch(options.gatewayUrl + path, { headers: headers(false) });
    if (!response.ok) throw new Error(`HelloID answered ${response.status} for ${path}`);
    return response.json();
  };
  const sendToGateway = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(options.gatewayUrl + path, {
      method,
      headers: headers(body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`HelloID answered ${response.status} for ${method} ${path}` + (detail ? `\n${detail}` : ''));
    }
    const answer = await response.text().catch(() => '');
    try {
      return JSON.parse(answer);
    } catch {
      return answer;
    }
  };
  const result: HarnessResult = { planned: [], after: [], decisions: [], finish: null };
  let shown: any[] = [];
  const stubs: Record<string, unknown> = {
    GM_getValue: (_key: string, fallback: unknown) => fallback,
    GM_info: { script: { version: 'test' } },
    location: { origin: options.portalUrl, reload: () => {} },
    crypto: { randomUUID: options.uuid },
    console: { warn: () => {}, log: () => {}, error: () => {} },
    // A clock that a timer moves on at once (the polls of the import end without waiting)
    setTimeout: (fn: () => void, ms = 0) => {
      options.clock.now += ms;
      queueMicrotask(fn);
      return 0;
    },
    Date: class extends Date {
      static override now() {
        return options.clock.now;
      }
    },
    gateway: { origin: options.gatewayUrl },
    pageWindow: {},
    fetchFromGateway,
    sendToGateway,
    fetchSystems: async () => {
      const systems = await fetchFromGateway('/service/provisioning-api/api/target-systems?showReferenceSystems=true');
      return Array.isArray(systems) ? systems : [];
    },
    pickImportFiles: async () => picked,
    showDialog: async (_title: string, _text: string, opts: any = {}) => (opts.alternative ? 'alternative' : true),
    chooseImport: async () => {
      throw new Error('chooseImport is not reached with Overwrite all');
    },
    chooseDecisions: async (decisions: any[]) => {
      result.decisions = decisions.map((d) => ({ key: d.key, default: d.default }));
      return Object.fromEntries(decisions.map((d) => [d.key, d.key in (options.answers ?? {}) ? options.answers![d.key] : d.default]));
    },
    showOverview: (_title: string, _intro: string, entries: any[]) => {
      shown = entries;
      result.planned = snapshot(entries);
      return {
        confirmed: Promise.resolve(options.confirm),
        render: () => {},
        finish: async (message: string) => {
          result.finish = message;
        },
      };
    },
    showProgress: () => ({ set() {}, failBusy() {}, close() {}, finish: async () => {} }),
    downloadFile: () => {},
    collectSystemExport: async () => ({}),
    collectSourceSystemExport: async () => ({}),
    collectNotificationSystemExport: async () => ({}),
    collectNotificationsExport: async () => ({}),
    exportFileName: (name: string) => name,
  };
  const names = Object.keys(stubs);
  const factory = new Function(...names, buildSource()) as (...args: unknown[]) => { importFiles: () => Promise<boolean> };
  const { importFiles } = factory(...names.map((n) => stubs[n]));
  await importFiles();
  // The backup line the userscript adds before it runs is not ported
  result.after = snapshot(shown.filter((e) => e.group !== 'Backup'));
  return result;
}
