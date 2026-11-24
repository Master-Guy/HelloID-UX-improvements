// The identity providers on HelloID's sign-in page, so the login can open a provider directly
// (login.provider in config.json) instead of the page where the user picks one.
//
// The sign-in page is public: it is read with a plain GET, without cookies or credentials. Each
// provider is a link <a class="... sign-in-link ..." href="/...?returnUrl=%2F">name</a>.

import type { FetchLike } from './client.ts';
import { PORTAL } from './endpoints.ts';

export interface IdentityProvider {
  /** The text of the link, e.g. "Local". */
  name: string;
  /** The link as on the page, relative to the portal (with its returnUrl). */
  path: string;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** &amp;, &#39;, &#x27; and the other common entities decoded. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** The attributes of a start tag's inside (names lower case, values decoded). */
function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

/** The providers on the sign-in page: the links whose class list has `sign-in-link`. */
export function parseIdentityProviders(html: string): IdentityProvider[] {
  const providers: IdentityProvider[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attributes = parseAttributes(match[1]!);
    const classes = (attributes.get('class') ?? '').split(/\s+/);
    if (!classes.includes('sign-in-link')) continue;
    const path = attributes.get('href')?.trim();
    const name = decodeEntities(match[2]!.replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!path || !name) continue;
    providers.push({ name, path });
  }
  return providers;
}

/** The provider with this name: case-insensitive after trimming, the whole name. */
export function findIdentityProvider(providers: readonly IdentityProvider[], name: string): IdentityProvider | undefined {
  const wanted = name.trim().toLowerCase();
  return providers.find((provider) => provider.name.trim().toLowerCase() === wanted);
}

/** The URL with username=<value> added as a query parameter (before any #fragment). */
export function withUsername(url: string, username: string): string {
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const separator = !base.includes('?') ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
  return `${base}${separator}username=${encodeURIComponent(username)}${hash}`;
}

/** The address Chrome opens for a provider: the portal plus the link's path. */
export function providerUrl(baseUrl: string, provider: IdentityProvider): string {
  return new URL(provider.path, `${baseUrl}/`).href;
}

/**
 * Reads the sign-in page of a portal (GET <baseUrl>/, which redirects to it without a login; no
 * cookies, no credentials) and returns its identity providers. Throws when the page cannot be read
 * or has none.
 */
export async function fetchIdentityProviders(
  baseUrl: string,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<IdentityProvider[]> {
  const doFetch = options.fetch ?? fetch;
  const url = baseUrl + PORTAL.start;
  const response = await doFetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    credentials: 'omit',
    signal: options.signal,
  });
  const html = await response.text();
  if (response.status < 200 || response.status > 299) {
    throw new Error(`the sign-in page (${url}) answered ${response.status}`);
  }
  const providers = parseIdentityProviders(html);
  if (providers.length === 0) throw new Error(`no identity providers (sign-in links) found on the sign-in page (${response.url || url})`);
  return providers;
}
