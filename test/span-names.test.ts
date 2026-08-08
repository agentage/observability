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
