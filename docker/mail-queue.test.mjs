import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailQueue } from './mail-queue.mjs';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hme-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, encryptionKey, process: async () => {}, ...options };
}
test('encrypted durable queue survives restart with full payload and safe status', async t => {
  const options = await fixture(t);
  const queue = await createMailQueue(options);
  const payload = { from: 'secret@example.com', rawBase64: 'private MIME contents' };
  const id = await queue.enqueue('inbound', payload);
  const file = await readFile(join(options.directory, `${id}.mail`));
  assert.ok(!file.includes(Buffer.from('secret@example.com')));
  assert.ok(!file.includes(Buffer.from('private MIME contents')));
  assert.equal((await queue.status()).inbound, 1);
  let received;
  const restarted = await createMailQueue({ ...options, process: async (...args) => { received = args; } });
  await restarted.drain();
  assert.deepEqual(received, ['inbound', payload, id]);
  assert.equal((await restarted.status()).inbound, 0);
});
test('tampering is surfaced, never processed', async t => {
  let called = false;
  const options = await fixture(t, { process: async () => { called = true; } });
  const queue = await createMailQueue(options);
  const id = await queue.enqueue('outbound', {});
  const path = join(options.directory, `${id}.mail`);
  const data = await readFile(path); data[data.length - 1] ^= 1; await writeFile(path, data);
  await assert.rejects(queue.drain());
  assert.equal(called, false);
});
test('parallel enqueue capacity is serialized and own partial files cleaned', async t => {
  const options = await fixture(t, { maxBytes: 300 });
  await writeFile(join(options.directory, '.hme-partial-abandoned'), 'partial');
  const queue = await createMailQueue(options);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => queue.enqueue('inbound', { data: 'x'.repeat(100) })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(!(await readdir(options.directory)).some(f => f.startsWith('.hme-partial-')));
});
test('retry, uncertain minimum, permanent retention, and age expiry', async t => {
  let time = 1000, calls = 0, failure = {};
  const options = await fixture(t, { now: () => time, retryMs: 10, maxAgeMs: 1000000,
    process: async () => { calls++; throw Object.assign(new Error('sensitive address'), failure); } });
  const queue = await createMailQueue(options);
  await queue.enqueue('outbound', {});
  await queue.drain(); await queue.drain(); assert.equal(calls, 1);
  time += 10; failure = { uncertain: true }; await queue.drain(); assert.equal(calls, 2);
  time += 299999; await queue.drain(); assert.equal(calls, 2);
  time++; failure = { permanent: true }; await queue.drain();
  assert.equal((await queue.status()).failed, 1);
  time += 2000000; await queue.drain(); assert.equal(calls, 3);
  await queue.enqueue('inbound', {}); time += 1000001; await queue.drain();
  assert.equal((await queue.status()).failed, 2);
});
test('stop waits for single active drain', async t => {
  let release, entered;
  const ready = new Promise(r => { entered = r; });
  const options = await fixture(t, { process: async () => { entered(); await new Promise(r => { release = r; }); } });
  const queue = await createMailQueue(options); await queue.enqueue('inbound', {});
  queue.start(); await ready;
  let stopped = false; const stop = queue.stop().then(() => { stopped = true; });
  await new Promise(r => setImmediate(r)); assert.equal(stopped, false);
  release(); await stop; assert.equal((await queue.status()).inbound, 0);
});
