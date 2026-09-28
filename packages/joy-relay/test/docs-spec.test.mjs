// The OpenAPI spec the relay serves at /openapi.json: every route described,
// path parameters named, and the app's TypeScript types attached where the
// app calls the route (src/openapi.types.json, scripts/openapi-types).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createNotify } from '../src/notify.mjs';
import { createV2Router } from '../src/v2.mjs';
import { createTunnel } from '../src/tunnel.mjs';
import { createAttachments } from '../src/attachments.mjs';
import { buildRelaySpec } from '../src/docs.mjs';

let spec;
beforeAll(async () => {
  const db = await openDb(':memory:');
  const notify = createNotify();
  const v2 = createV2Router({
    core: createCore(db, notify), auth: { verifyToken: async () => null }, notify, db,
    tunnel: createTunnel({ notify }), attachments: createAttachments(db),
  });
  spec = buildRelaySpec({ version: '0.0.0', host: 'http://relay.test', routeTable: { routes: v2.routeTable() } });
});

const ops = () => Object.entries(spec.paths).flatMap(([path, byMethod]) => Object.entries(byMethod).map(([method, op]) => ({ path, method, op })));

describe('relay OpenAPI spec', () => {
  it('describes every route and names every path parameter', () => {
    for (const { path, method, op } of ops()) {
      expect(op.summary, `${method} ${path}`).toBeTruthy();
      expect(path, `${method} ${path}`).not.toMatch(/\{p\d+\}/);
    }
    expect(spec.paths['/joy/v2/push-tokens/{token}'].delete.summary).toMatch(/push token/i);
  });

  it('attaches the app\'s types to the routes it calls, and every $ref resolves', () => {
    const machines = spec.paths['/joy/v2/machines'].get;
    expect(JSON.stringify(machines.responses['200'])).toContain('#/components/schemas/V2Machine');
    expect(machines['x-types-from'][0]).toMatch(/packages\/joy-app\/sources\//);
    const send = spec.paths['/joy/v2/sessions/{sessionId}/messages'].post;
    expect(send.requestBody.content['application/json'].schema.properties.ciphertext).toBeTruthy();
    const refs = [...JSON.stringify(spec).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    for (const name of refs) expect(spec.components.schemas[name], name).toBeTruthy();
  });

  it('openapi.types.json matches the app\'s types (else: node scripts/openapi-types/gen-relay.mjs)', async () => {
    const { generateRelayTypes } = await import('../../../scripts/openapi-types/gen-relay.mjs');
    const committed = JSON.parse(fs.readFileSync(new URL('../src/openapi.types.json', import.meta.url), 'utf8'));
    expect(generateRelayTypes()).toEqual(committed);
  }, 60_000);
});
