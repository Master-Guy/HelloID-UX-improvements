// All tool groups. A later phase adds its area as src/tools/<area>.ts exporting a ToolGroup, and
// lists it here.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.ts';
import { actionChangeTools } from './action-changes.ts';
import { actionTools } from './actions.ts';
import { compareTools } from './compare.ts';
import { editTools } from './edit.ts';
import { register, type ToolGroup } from './helpers.ts';
import { deleteTools } from './delete.ts';
import { dryRunTools } from './dryrun.ts';
import { evaluationTools } from './evaluation.ts';
import { exportTools } from './export.ts';
import { healthTools } from './health.ts';
import { importTools } from './import.ts';
import { notificationTools } from './notifications.ts';
import { personTools } from './persons.ts';
import { reportTools } from './reports.ts';
import { rulePublishTools } from './rule-publish.ts';
import { ruleTools } from './rules.ts';
import { sessionTools } from './session.ts';
import { settingTools } from './settings.ts';
import { systemTools } from './systems.ts';

export const TOOL_GROUPS: ReadonlyArray<ToolGroup> = [
  sessionTools,
  systemTools,
  ruleTools,
  notificationTools,
  settingTools,
  personTools,
  evaluationTools,
  exportTools,
  reportTools,
  importTools,
  deleteTools,
  actionTools,
  healthTools,
  actionChangeTools,
  editTools,
  rulePublishTools,
  compareTools,
  dryRunTools,
];

/** Registers every tool of every group on an MCP server. */
export function registerAllTools(server: McpServer, context: AppContext, groups: ReadonlyArray<ToolGroup> = TOOL_GROUPS): void {
  const names = new Set<string>();
  for (const group of groups) {
    for (const tool of group) {
      if (names.has(tool.name)) throw new Error(`Tool ${tool.name} is defined twice.`);
      names.add(tool.name);
      register(server, context, tool);
    }
  }
}
