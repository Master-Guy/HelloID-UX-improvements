import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FetchLike } from '../src/helloid/client.ts';
import {
  decodeEntities,
  fetchIdentityProviders,
  findIdentityProvider,
  parseIdentityProviders,
  providerUrl,
  withUsername,
} from '../src/helloid/signin.ts';
import { SIGN_IN_HTML } from './fake-helloid.ts';

describe('sign-in page', () => {
  it('parses the providers: multi-line class, images, entities, extra whitespace', () => {
    assert.deepEqual(parseIdentityProviders(SIGN_IN_HTML), [
      { name: 'AD - fake.local', path: '/directoryauthentication/login/0a1b2c3d-0000-4000-8000-00000000a1b2?returnUrl=%2F' },
      { name: 'Contoso & Partners', path: '/directoryauthentication/login/0a1b2c3d-0000-4000-8000-00000000c3d4?returnUrl=%2F' },
      { name: 'Local', path: '/authentication/admlogin?returnUrl=%2F' },
    ]);
  });

  it('takes only links whose class list has sign-in-link', () => {
    const html = `
      <a class="not-a-sign-in-link" href="/x">X</a>
      <a href='/a?returnUrl=%2F&amp;b=1' CLASS='sign-in-link'><span>Fake</span>
         <b>IdP</b>&nbsp;&#40;one&#x29;</a>
      <a class="sign-in-link">No href</a>
      <a class="btn sign-in-link" href="/empty"><img src="x" /></a>`;
    assert.deepEqual(parseIdentityProviders(html), [{ name: 'Fake IdP (one)', path: '/a?returnUrl=%2F&b=1' }]);
    assert.deepEqual(parseIdentityProviders('<html><body>No links</body></html>'), []);
  });

  it('decodes entities', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27; &unknown;'), 'a & b <c> "d" \'e\' &unknown;');
  });

  it('matches a name case-insensitively after trimming, the whole name only', () => {
    const providers = parseIdentityProviders(SIGN_IN_HTML);
    assert.equal(findIdentityProvider(providers, '  local ')?.path, '/authentication/admlogin?returnUrl=%2F');
    assert.equal(findIdentityProvider(providers, 'CONTOSO & PARTNERS')?.name, 'Contoso & Partners');
    assert.equal(findIdentityProvider(providers, 'Contoso'), undefined, 'not partial');
    assert.equal(findIdentityProvider(providers, 'Loc'), undefined);
  });

  it('adds username as a query parameter, keeping the others', () => {
    assert.equal(
      withUsername('https://portal.example.test/authentication/admlogin?returnUrl=%2F', 'someone@fake.example.test'),
      'https://portal.example.test/authentication/admlogin?returnUrl=%2F&username=someone%40fake.example.test',
    );
    assert.equal(withUsername('https://portal.example.test/', 'a b'), 'https://portal.example.test/?username=a%20b');
    assert.equal(withUsername('https://portal.example.test/x?y=1#top', 'u'), 'https://portal.example.test/x?y=1&username=u#top');
    assert.equal(
      providerUrl('https://portal.example.test', { name: 'Local', path: '/authentication/admlogin?returnUrl=%2F' }),
      'https://portal.example.test/authentication/admlogin?returnUrl=%2F',
    );
  });

  it('fetches the page without cookies or credentials, following redirects', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(SIGN_IN_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as FetchLike;
    const providers = await fetchIdentityProviders('https://portal.example.test', { fetch: fakeFetch });
    assert.equal(providers.length, 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://portal.example.test/');
    assert.equal(calls[0]!.init?.redirect, 'follow');
    assert.equal(calls[0]!.init?.credentials, 'omit');
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('authorization'), null);
  });

  it('fails on an error status or a page without providers', async () => {
    const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as FetchLike;
    await assert.rejects(fetchIdentityProviders('https://portal.example.test', { fetch: answer(503, 'down') }), /answered 503/);
    await assert.rejects(
      fetchIdentityProviders('https://portal.example.test', { fetch: answer(200, '<html>Something else</html>') }),
      /no identity providers/,
    );
  });
});
