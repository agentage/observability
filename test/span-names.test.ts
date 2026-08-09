import { describe, it, expect, vi } from 'vitest';
import { routeFromUrl, normalizeFetchSpanName, FetchSpanNameProcessor } from '../src/span-names.js';
import type { Span } from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';

describe('routeFromUrl', () => {
  it('drops origin and query', () => {
    expect(routeFromUrl('http://agentage-mcp-catalog_backend:3001/api/mcps?page=1&limit=24')).toBe(
      '/api/mcps'
    );
    expect(routeFromUrl('https://api.agentage.io/api/admin/system')).toBe('/api/admin/system');
  });

  it('collapses id-shaped segments', () => {
    expect(routeFromUrl('/api/mcps/6890a1b2c3d4e5f6a7b8c9d0/versions')).toBe(
      '/api/mcps/:id/versions'
    );
    expect(routeFromUrl('/users/42')).toBe('/users/:id');
    expect(routeFromUrl('/m/a3ce929d-0e0e-4736-aab7-ab4f8422d25c')).toBe('/m/:id');
  });

  it('keeps slugs and bare roots', () => {
    expect(routeFromUrl('http://backend:3001/')).toBe('/');
    expect(routeFromUrl('http://backend:3001')).toBe('/');
    expect(routeFromUrl('/mcp/model-context-protocol')).toBe('/mcp/model-context-protocol');
  });
});

describe('normalizeFetchSpanName', () => {
  it('rewrites fetch spans to {method} {route}', () => {
    expect(normalizeFetchSpanName('fetch GET http://b:3001/api/mcps?x=1')).toBe('GET /api/mcps');
    expect(normalizeFetchSpanName('fetch POST https://api.agentage.io/api/keys/123')).toBe(
      'POST /api/keys/:id'
    );
  });

  it('leaves non-fetch spans alone', () => {
    expect(normalizeFetchSpanName('GET /browse')).toBeNull();
    expect(normalizeFetchSpanName('render route (app) /')).toBeNull();
  });
});

describe('FetchSpanNameProcessor', () => {
  it('updates only matching span names on start', () => {
    const p = new FetchSpanNameProcessor();
    const updateName = vi.fn();
    const mk = (name: string) => ({ name, updateName }) as unknown as Span;
    p.onStart(mk('fetch GET http://b:3001/api/mcps?p=1'), {} as Context);
    expect(updateName).toHaveBeenCalledWith('GET /api/mcps');
    updateName.mockClear();
    p.onStart(mk('GET /browse'), {} as Context);
    expect(updateName).not.toHaveBeenCalled();
  });
});

describe('unmatched-route rename', () => {
  it('renames bare-method SERVER spans, leaves others', async () => {
    const { SpanKind } = await import('@opentelemetry/api');
    const p = new FetchSpanNameProcessor();
    const updateName = vi.fn();
    const mk = (name: string, kind: number) => ({ name, kind, updateName }) as unknown as Span;
    p.onStart(mk('GET', SpanKind.SERVER), {} as Context);
    expect(updateName).toHaveBeenCalledWith('GET (unmatched)');
    updateName.mockClear();
    p.onStart(mk('GET', SpanKind.CLIENT), {} as Context);
    p.onStart(mk('GET /docs', SpanKind.SERVER), {} as Context);
    expect(updateName).not.toHaveBeenCalled();
  });
});

describe('RSC fold', () => {
  it('folds RSC spans at END (Next names them late) and stamps next.rsc', () => {
    const p = new FetchSpanNameProcessor();
    const span = { name: 'RSC GET /browse', attributes: {} } as unknown as Span;
    p.onEnd(span);
    const m = span as unknown as { name: string; attributes: Record<string, unknown> };
    expect(m.name).toBe('GET /browse');
    expect(m.attributes['next.rsc']).toBe(true);
  });

  it('leaves non-RSC names untouched at end', () => {
    const p = new FetchSpanNameProcessor();
    const span = { name: 'GET /browse', attributes: {} } as unknown as Span;
    p.onEnd(span);
    expect((span as unknown as { name: string }).name).toBe('GET /browse');
  });
});

describe('readableRoute', () => {
  it('turns a stringified express RegExp back into a route', async () => {
    const { readableRoute } = await import('../src/span-names.js');
    expect(readableRoute('/v1/^\\/memories\\/([^/]+)\\/notes\\/(.+)$/')).toBe(
      '/v1/memories/:param/notes/:path'
    );
    expect(readableRoute('/v1/^\\/vaults\\/([^/]+)\\/notes\\/(.+)$/')).toBe(
      '/v1/vaults/:param/notes/:path'
    );
  });

  it('leaves an ordinary route untouched', async () => {
    const { readableRoute } = await import('../src/span-names.js');
    expect(readableRoute('/api/memories/:id/folders')).toBe('/api/memories/:id/folders');
    expect(readableRoute('/browse')).toBe('/browse');
  });
});

describe('request-path redaction', () => {
  const mkSpan = (kind: number, attributes: Record<string, unknown>) =>
    ({ name: 'GET /x', kind, attributes }) as unknown as Span;

  it('replaces a concrete content path with its route template', async () => {
    const { SpanKind } = await import('@opentelemetry/api');
    const p = new FetchSpanNameProcessor();
    const attributes: Record<string, unknown> = {
      'http.route': '/v1/^\\/memories\\/([^/]+)\\/notes\\/(.+)$/',
      'url.path': '/v1/memories/m/notes/00_INBOX/2026-08-04_bugs-y-decisiones.md',
      'url.full': 'https://memory.agentage.io/v1/memories/m/notes/00_INBOX/2026-08-04_bugs.md',
    };
    p.onEnd(mkSpan(SpanKind.SERVER, attributes));
    expect(attributes['url.path']).toBe('/v1/memories/:param/notes/:path');
    expect(attributes['http.route']).toBe('/v1/memories/:param/notes/:path');
    expect(attributes['url.full']).toBeUndefined();
    expect(JSON.stringify(attributes)).not.toContain('decisiones');
  });

  it('leaves an unmatched path verbatim - probes are not user content', async () => {
    const { SpanKind } = await import('@opentelemetry/api');
    const p = new FetchSpanNameProcessor();
    const attributes: Record<string, unknown> = {
      'http.route': '',
      'url.path': '/files/index.php',
    };
    p.onEnd(mkSpan(SpanKind.SERVER, attributes));
    expect(attributes['url.path']).toBe('/files/index.php');
  });

  it('leaves client spans alone', async () => {
    const { SpanKind } = await import('@opentelemetry/api');
    const p = new FetchSpanNameProcessor();
    const attributes: Record<string, unknown> = {
      'http.route': '/api/mcps',
      'url.path': '/api/mcps/abc',
      'url.full': 'http://b:3001/api/mcps/abc',
    };
    p.onEnd(mkSpan(SpanKind.CLIENT, attributes));
    expect(attributes['url.path']).toBe('/api/mcps/abc');
    expect(attributes['url.full']).toBe('http://b:3001/api/mcps/abc');
  });
});
