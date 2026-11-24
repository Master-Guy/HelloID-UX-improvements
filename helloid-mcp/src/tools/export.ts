// helloid_export_everything: the userscript's "Export everything" backup file. The file is large
// (megabytes), so it is not put in the answer: the server keeps it in memory for 30 minutes and the
// answer has a resource link to it (helloid-export://<id>), readable by the MCP session that made it.
// The answer itself has a short summary (counts per kind, what could not be read).

import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EXPORT_URI_SCHEME, exportKind } from '../helloid/exports.ts';
import type { AppContext } from './context.ts';
import { defineTool, exporterFor, readAnnotations, type ToolGroup } from './helpers.ts';

export const exportEverything = defineTool({
  name: 'helloid_export_everything',
  title: 'Export everything',
  description:
    'Makes a full backup of an environment, the same file as the userscript\'s "Export everything": every target system, ' +
    'source system, notification system, notification, business rule, toxic policy, custom event and schedule, and the ' +
    'settings (source configuration, aggregation, person lifecycle, excluded persons, reconciliation). Secrets are masked ' +
    'as "***". The file is kept by the server for 30 minutes and returned as a resource link (read it with the MCP ' +
    'resource read of this session); the answer has a summary. Takes a while (progress is sent). The file has the ' +
    'personal data of the excluded persons. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {},
  output: {
    uri: z.string().describe('The resource with the backup file (JSON)'),
    fileName: z.string().describe('A file name for it, as the userscript names it'),
    sizeBytes: z.number(),
    expiresAt: z.string().describe('ISO time until the server keeps it'),
    complete: z.boolean().describe('false: some items could not be read (couldNotRead)'),
    couldNotRead: z.array(z.string()),
    files: z.number().describe('The number of export files in the backup'),
    counts: z.record(z.string(), z.number()).describe('The number of files per kind (contents)'),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const exporter = exporterFor(call, context, true);
    const backup = await exporter.everything((p) => {
      void call.progress(p.partIndex + 1, `${p.part}: ${p.done + 1}/${p.total}`);
    });
    const counts: Record<string, number> = {};
    for (const file of backup.files) {
      const kind = exportKind(file) ?? 'other';
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    const host = new URL(call.environment.config.baseUrl).hostname;
    const fileName = `HelloID backup - ${host} - ${new Date(context.now()).toISOString().slice(0, 10)}.json`;
    const stored = context.exports.add({
      environment: call.environment.name,
      sessionId: call.sessionId,
      fileName,
      text: JSON.stringify(backup, null, 2),
    });
    const couldNotRead: string[] = backup.couldNotRead ?? [];
    return {
      summary:
        `Backup of '${call.environment.name}': ${backup.files.length} export file(s), ${stored.sizeBytes} bytes, secrets masked. ` +
        (couldNotRead.length ? `Not in it (could not be read): ${couldNotRead.join('; ')}. ` : '') +
        `Read it from ${stored.uri} (kept 30 minutes, this MCP session only).`,
      structured: {
        uri: stored.uri,
        fileName,
        sizeBytes: stored.sizeBytes,
        expiresAt: new Date(stored.expiresAt).toISOString(),
        complete: backup.complete,
        couldNotRead,
        files: backup.files.length,
        counts,
      },
      content: [
        {
          type: 'resource_link',
          uri: stored.uri,
          name: fileName,
          mimeType: 'application/json',
          description: `HelloID backup of '${call.environment.name}' (secrets masked)`,
          size: stored.sizeBytes,
        },
      ],
    };
  },
});

/** The resource helloid-export://<id>: an export made by helloid_export_everything in this MCP session. */
export function registerExportResource(server: McpServer, context: AppContext): void {
  server.registerResource(
    'helloid-export',
    new ResourceTemplate(`${EXPORT_URI_SCHEME}://{id}`, {
      list: async (extra) => ({
        resources: context.exports.list(extra.sessionId).map((e) => ({
          uri: e.uri,
          name: e.fileName,
          mimeType: 'application/json',
          size: e.sizeBytes,
        })),
      }),
    }),
    {
      title: 'HelloID backup',
      description: 'A backup made by helloid_export_everything in this MCP session (kept 30 minutes).',
      mimeType: 'application/json',
    },
    async (uri, variables, extra) => {
      const id = String(Array.isArray(variables.id) ? variables.id[0] : variables.id);
      const stored = context.exports.get(id, extra.sessionId);
      if (!stored) {
        throw new Error(
          `There is no export '${id}' for this MCP session (exports are kept 30 minutes, are lost on a restart, and can only ` +
            'be read by the session that made them). Run helloid_export_everything again.',
        );
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: stored.text }] };
    },
  );
}

export const exportTools: ToolGroup = [exportEverything];
