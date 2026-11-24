// What every tool can use: the config, the sessions, the browser, the safety machinery and the
// audit log. One AppContext per server process; every MCP session shares it.

import type { AuditWriter } from '../audit.ts';
import type { Config } from '../config.ts';
import type { BrowserService } from '../helloid/browser.ts';
import { type FetchLike, HelloIdClient } from '../helloid/client.ts';
import type { ExportStore } from '../helloid/exports.ts';
import type { SessionStore } from '../helloid/session.ts';
import type { Logger } from '../log.ts';
import type { EnvironmentLocks, PlanStore } from '../safety.ts';

export interface AppContext {
  config: Config;
  sessions: SessionStore;
  browser: BrowserService;
  plans: PlanStore;
  locks: EnvironmentLocks;
  audit: AuditWriter;
  logger: Logger;
  /** Exports kept in memory for reading as an MCP resource (helloid_export_everything). */
  exports: ExportStore;
  /** Who made an export file ("helloid-mcp <version>"). */
  exportedBy: string;
  /** Time between polls while waiting for an evaluation run. */
  evaluationPollMs: number;
  now: () => number;
  /** The client of an environment (a known name), sharing its in-memory session. */
  clientFor(environment: string): HelloIdClient;
}

/** A clientFor() for a config and session store. */
export function makeClientFactory(
  config: Config,
  sessions: SessionStore,
  options: { fetch?: FetchLike; now?: () => number } = {},
): (environment: string) => HelloIdClient {
  // One client per environment, so concurrent calls share one token renewal
  const clients = new Map<string, HelloIdClient>();
  return (environment) => {
    let client = clients.get(environment);
    if (!client) {
      const environmentConfig = config.environments[environment];
      if (!environmentConfig) throw new Error(`Unknown environment '${environment}'.`);
      client = new HelloIdClient(environment, environmentConfig, sessions.get(environment, environmentConfig.baseUrl), options);
      clients.set(environment, client);
    }
    return client;
  };
}
