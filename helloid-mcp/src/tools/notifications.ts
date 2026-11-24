// Read tools for notifications, notification systems and custom events. Secrets in notification
// systems and notification template data are masked as the userscript's export masks them.

import { z } from 'zod';
import { NotFoundError } from '../helloid/exports.ts';
import {
  bool,
  defineTool,
  exporterFor,
  num,
  page,
  pageOutput,
  pageText,
  pagingInput,
  readAnnotations,
  str,
  type ToolGroup,
} from './helpers.ts';

const exportObject = z.record(z.string(), z.unknown());

const notificationRow = z.object({
  identifier: z.string().nullable(),
  name: z.string().nullable(),
  event: z.string().nullable(),
  enabled: z.boolean().nullable(),
  systemId: z.string().nullable().describe('The target system of its event, if any'),
  notificationSystemId: z.string().nullable(),
  lastChange: z.string().nullable(),
});

export const listNotifications = defineTool({
  name: 'helloid_list_notifications',
  title: 'List notifications',
  description:
    'Lists the notification configurations (enabled and disabled): ID, name, event, enabled, target system and notification ' +
    'system, in pages. helloid_get_notification gives one in full. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(notificationRow, 'The notifications'),
  annotations: readAnnotations,
  async handler(call, context) {
    const rows = (await exporterFor(call, context).listNotifications()).map((n) => ({
      identifier: str(n?.identifier),
      name: str(n?.name),
      event: str(n?.event),
      enabled: bool(n?.enabled),
      systemId: str(n?.systemId),
      notificationSystemId: str(n?.notificationSystemId),
      lastChange: str(n?.lastChange),
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'notification(s)'), structured: result };
  },
});

export const getNotification = defineTool({
  name: 'helloid_get_notification',
  title: 'Get a notification',
  description:
    'Gets one notification configuration as the userscript\'s export makes it: with the names of its target system, ' +
    'notification system, template and custom event, and its template data with secrets masked as "***". ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { identifier: z.string().min(1).describe('The notification ID (identifier in helloid_list_notifications)') },
  output: { notification: exportObject.describe('The notification, as in the userscript\'s notifications export') },
  annotations: readAnnotations,
  async handler(call, context) {
    const file = await exporterFor(call, context).notifications([call.args.identifier]);
    const notification = file.notifications[0];
    return {
      summary: `Notification "${notification?.name}" (${notification?.event ?? '?'}, ${notification?.enabled ? 'enabled' : 'disabled'}). Secrets are masked.`,
      structured: { notification },
    };
  },
});

const notificationSystemRow = z.object({
  systemId: z.string().nullable(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  isBuiltin: z.boolean().nullable(),
});

export const listNotificationSystems = defineTool({
  name: 'helloid_list_notification_systems',
  title: 'List notification systems',
  description:
    'Lists the notification systems (what sends the notifications, e.g. the built-in Email): ID, name, description, ' +
    'built-in, in pages. helloid_get_notification_system gives one in full. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(notificationSystemRow, 'The notification systems'),
  annotations: readAnnotations,
  async handler(call, context) {
    const rows = (await exporterFor(call, context).listNotificationSystems()).map((s) => ({
      systemId: str(s?.systemId),
      displayName: str(s?.displayName),
      description: str(s?.description),
      isBuiltin: bool(s?.isBuiltin),
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'notification system(s)'), structured: result };
  },
});

export const getNotificationSystem = defineTool({
  name: 'helloid_get_notification_system',
  title: 'Get a notification system',
  description:
    'Gets one notification system as the userscript\'s export makes it: its configuration (secrets masked as "***"), ' +
    'templates and agent selection. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { systemId: z.string().min(1).describe('The notification system ID (helloid_list_notification_systems)') },
  output: { system: exportObject.describe('The export file of the notification system (secrets masked)') },
  annotations: readAnnotations,
  async handler(call, context) {
    const system = await exporterFor(call, context).notificationSystem(call.args.systemId);
    return { summary: `Notification system "${system.displayName}". Secrets are masked.`, structured: { system } };
  },
});

const customEventRow = z.object({
  customEventId: z.string().nullable(),
  name: z.string().nullable(),
  systemId: z.string().nullable(),
  action: z.number().nullable(),
});

export const listCustomEvents = defineTool({
  name: 'helloid_list_custom_events',
  title: 'List custom events',
  description:
    'Lists the custom events of the notifications: ID, name, system and action, in pages. helloid_get_custom_event gives ' +
    'one with its conditions. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(customEventRow, 'The custom events'),
  annotations: readAnnotations,
  async handler(call, context) {
    const rows = (await exporterFor(call, context).listCustomEvents()).map((e) => ({
      customEventId: str(e?.customEventId),
      name: str(e?.name),
      systemId: str(e?.systemId),
      action: num(e?.action),
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'custom event(s)'), structured: result };
  },
});

export const getCustomEvent = defineTool({
  name: 'helloid_get_custom_event',
  title: 'Get a custom event',
  description:
    'Gets one custom event as the userscript\'s export makes it: the event with its conditions, and the name of its system. ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { customEventId: z.string().min(1).describe('The custom event ID (helloid_list_custom_events)') },
  output: { customEvent: exportObject.describe('The export file of the custom event') },
  annotations: readAnnotations,
  async handler(call, context) {
    const exporter = exporterFor(call, context);
    const [events, systems] = await Promise.all([exporter.listCustomEvents(), exporter.systemDirectory()]);
    const event = events.find((e) => e?.customEventId === call.args.customEventId);
    if (!event) throw new NotFoundError(`There is no custom event '${call.args.customEventId}' in '${call.environment.name}'.`);
    const customEvent = exporter.customEvent(event, systems);
    return { summary: `Custom event "${event.name}"${customEvent.systemName ? ` of "${customEvent.systemName}"` : ''}.`, structured: { customEvent } };
  },
});

export const notificationTools: ToolGroup = [
  listNotifications,
  getNotification,
  listNotificationSystems,
  getNotificationSystem,
  listCustomEvents,
  getCustomEvent,
];
