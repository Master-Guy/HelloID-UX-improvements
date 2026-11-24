// Session and browser tools: list the environments and their identity providers, log in and out,
// show/hide/close Chrome.

import { z } from 'zod';
import { findIdentityProvider } from '../helloid/signin.ts';
import { effectiveMode } from '../safety.ts';
import { defineTool, readAnnotations, type ToolGroup } from './helpers.ts';

// None of these tools changes anything in HelloID; they work in every mode.
const sessionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const environmentInfo = z.object({
  name: z.string().describe('The name used in every tool call'),
  baseUrl: z.string().describe('The portal'),
  mode: z.enum(['read', 'plan', 'write']).describe('The mode that applies (safety.readOnly makes every environment "read")'),
  configuredMode: z.enum(['read', 'plan', 'write']).describe('The mode in config.json'),
  allowEvaluate: z.boolean(),
  allowDelete: z.boolean(),
  allowRevokingRuleDelete: z.boolean(),
  allowRevokingRulePublish: z.boolean(),
  allowRetryActions: z.boolean(),
  allowApproveBlocked: z.boolean(),
  allowEnforce: z.boolean(),
  allowDryRun: z.boolean().describe('The dry-run tools (target system scripts run by HelloID with DryRun on), whatever the mode'),
  loggedIn: z.boolean(),
  sessionState: z.enum(['logged-out', 'logged-in', 'expired']).describe('"expired": log in again with helloid_login'),
  tokenValidUntil: z.string().nullable().describe('ISO time the current token expires (it is renewed automatically while the login lasts)'),
  gateway: z.string().nullable().describe('The provisioning gateway origin, once logged in'),
});

export const listEnvironments = defineTool({
  name: 'helloid_list_environments',
  title: 'List HelloID environments',
  description:
    'Lists the HelloID environments in config.json with their mode (read / plan / write), their flags ' +
    '(allowEvaluate, allowDelete, allowRevokingRuleDelete, allowRevokingRulePublish, allowRetryActions, allowApproveBlocked, allowEnforce, allowDryRun), and whether the server is logged in to each (and until when ' +
    'the token is valid). Changes nothing. Works in every mode.',
  access: 'none',
  environment: false,
  input: {},
  output: {
    readOnly: z.boolean().describe('safety.readOnly: when true, every environment is "read"'),
    chromeOpen: z.boolean().describe('Whether the server\'s Chrome window is open'),
    environments: z.array(environmentInfo),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(_call, context) {
    const environments = Object.entries(context.config.environments).map(([name, config]) => {
      const session = context.sessions.peek(name);
      const state = session?.state ?? 'logged-out';
      return {
        name,
        baseUrl: config.baseUrl,
        mode: effectiveMode(context.config, config),
        configuredMode: config.mode,
        allowEvaluate: config.allowEvaluate,
        allowDelete: config.allowDelete,
        allowRevokingRuleDelete: config.allowRevokingRuleDelete,
        allowRevokingRulePublish: config.allowRevokingRulePublish,
        allowRetryActions: config.allowRetryActions,
        allowApproveBlocked: config.allowApproveBlocked,
        allowEnforce: config.allowEnforce,
        allowDryRun: config.allowDryRun,
        loggedIn: state === 'logged-in',
        sessionState: state,
        tokenValidUntil:
          state === 'logged-in' && session?.tokenExpires ? new Date(session.tokenExpires).toISOString() : null,
        gateway: state === 'logged-in' ? (session?.gateway ?? null) : null,
      };
    });
    const loggedIn = environments.filter((e) => e.loggedIn).map((e) => e.name);
    return {
      summary:
        `${environments.length} environment(s); logged in to ${loggedIn.length ? loggedIn.join(', ') : 'none'}.` +
        (context.config.safety.readOnly ? ' safety.readOnly is on: every environment is "read".' : ''),
      structured: { readOnly: context.config.safety.readOnly, chromeOpen: context.browser.isOpen, environments },
    };
  },
});

export const listIdentityProviders = defineTool({
  name: 'helloid_list_identity_providers',
  title: 'List the identity providers of an environment',
  description:
    'Lists the identity providers on the sign-in page of an environment (the page is public: no login needed), with ' +
    'the name to use as login.provider in config.json, and which provider is configured and whether the page has it. ' +
    'With login.provider set, helloid_login opens that provider directly. Changes nothing. Works in every mode.',
  access: 'none',
  environment: true,
  input: {},
  output: {
    environment: z.string(),
    providers: z
      .array(
        z.object({
          name: z.string().describe('The name on the sign-in page (login.provider matches it case-insensitively)'),
          path: z.string().describe('The link of the provider, relative to the portal'),
        }),
      )
      .describe('The identity providers in the order of the sign-in page'),
    configured: z.string().nullable().describe('login.provider of the environment in config.json; null when not set'),
    found: z.boolean().nullable().describe('Whether the sign-in page has the configured provider; null when none is configured'),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const { name, config } = call.environment;
    const providers = await context.browser.identityProviders(name, { signal: call.signal });
    const configured = config.login?.provider ?? null;
    const match = configured === null ? undefined : findIdentityProvider(providers, configured);
    const found = configured === null ? null : match !== undefined;
    return {
      summary:
        `${providers.length} identity provider(s) on the sign-in page of '${name}': ${providers.map((p) => p.name).join(', ')}.` +
        (configured === null
          ? ' No login.provider is configured.'
          : found
            ? ` login.provider '${configured}' is '${match!.name}'.`
            : ` login.provider '${configured}' is not among them: helloid_login will fail until it is changed.`),
      structured: { environment: name, providers, configured, found },
    };
  },
});

export const login = defineTool({
  name: 'helloid_login',
  title: 'Log in to HelloID',
  description:
    'Starts the interactive login for an environment: opens (or reuses) its tab in the server\'s Chrome window and brings ' +
    'the window to the front. The user logs in there (Microsoft account, MFA); the server never sees the password. ' +
    'Returns when logged in, or after 10 minutes with a timeout. After the login Chrome is closed (config chrome.closeAfterLogin, ' +
      'default true; the session stays in the server). Changes nothing in HelloID. Works in every mode.',
  access: 'none',
  environment: true,
  input: {},
  output: {
    environment: z.string(),
    tokenValidUntil: z.string().nullable(),
    gateway: z.string(),
  },
  annotations: sessionAnnotations,
  async handler(call, context) {
    const environment = call.environment;
    const result = await context.browser.login(environment.name, {
      signal: call.signal,
      onProgress: (elapsedMs) => {
        void call.progress(Math.round(elapsedMs / 1000), `Waiting for the login to '${environment.name}' in Chrome`);
      },
    });
    return {
      summary:
        `Logged in to '${environment.name}'` +
        (result.tokenValidUntil ? `; the token is valid until ${result.tokenValidUntil} and is renewed automatically.` : '.'),
      structured: {
        environment: result.environment,
        tokenValidUntil: result.tokenValidUntil ?? null,
        gateway: result.gateway,
      },
    };
  },
});

export const logout = defineTool({
  name: 'helloid_logout',
  title: 'Forget a HelloID session',
  description:
    'Forgets the server\'s in-memory session (cookies and token) of an environment. The login in the Chrome window is ' +
    'not touched. Changes nothing in HelloID. Works in every mode.',
  access: 'none',
  environment: true,
  input: {},
  output: {
    environment: z.string(),
    wasLoggedIn: z.boolean(),
  },
  annotations: sessionAnnotations,
  async handler(call) {
    const { session, name } = call.environment;
    const wasLoggedIn = session.loggedIn;
    session.forget();
    return {
      summary: wasLoggedIn ? `Forgot the session of '${name}'.` : `There was no session of '${name}' to forget.`,
      structured: { environment: name, wasLoggedIn },
    };
  },
});

export const browserShow = defineTool({
  name: 'helloid_browser_show',
  title: 'Show the Chrome window',
  description:
    'Restores and focuses the server\'s Chrome window. When Chrome is closed, starts it again with the server\'s cookies ' +
    'and one tab per logged-in environment, so the user is still logged in. Changes nothing in HelloID. Works in every mode.',
  access: 'none',
  environment: false,
  input: {},
  output: {
    launched: z.boolean().describe('Whether Chrome had to be started'),
    tabsOpened: z.array(z.string()).describe('The environments a tab was opened for'),
  },
  annotations: sessionAnnotations,
  async handler(_call, context) {
    const result = await context.browser.show();
    return {
      summary: result.launched
        ? `Started Chrome${result.tabsOpened.length ? ` with tabs for ${result.tabsOpened.join(', ')}` : ''}.`
        : 'The Chrome window is shown.',
      structured: result,
    };
  },
});

export const browserHide = defineTool({
  name: 'helloid_browser_hide',
  title: 'Minimize the Chrome window',
  description: 'Minimizes the server\'s Chrome window. Changes nothing in HelloID. Works in every mode.',
  access: 'none',
  environment: false,
  input: {},
  output: { chromeOpen: z.boolean().describe('false: Chrome was not open, so there was nothing to minimize') },
  annotations: sessionAnnotations,
  async handler(_call, context) {
    const open = await context.browser.hide();
    return {
      summary: open ? 'The Chrome window is minimized.' : 'Chrome is not open.',
      structured: { chromeOpen: open },
    };
  },
});

export const browserClose = defineTool({
  name: 'helloid_browser_close',
  title: 'Close the Chrome window',
  description:
    'Closes the server\'s Chrome. The server keeps working from its in-memory sessions; helloid_browser_show starts it ' +
    'again. Changes nothing in HelloID. Works in every mode.',
  access: 'none',
  environment: false,
  input: {},
  output: { closed: z.boolean().describe('false: Chrome was not open') },
  annotations: sessionAnnotations,
  async handler(_call, context) {
    const closed = await context.browser.close();
    return {
      summary: closed ? 'Chrome is closed; the sessions stay in the server.' : 'Chrome was not open.',
      structured: { closed },
    };
  },
});

export const sessionTools: ToolGroup = [
  listEnvironments,
  listIdentityProviders,
  login,
  logout,
  browserShow,
  browserHide,
  browserClose,
];
