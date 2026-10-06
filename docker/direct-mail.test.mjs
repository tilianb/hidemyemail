import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createDirectMail } from './direct-mail.mjs';

const message = { from: 'Alias <alias@example.com>', to: 'person@recipient.net',
  rawBase64: Buffer.from('From: Alias <alias@example.com>\r\nTo: person@recipient.net\r\nSubject: hello\r\n\r\nfinal body').toString('base64') };
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hme-direct-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, encryptionKey: Buffer.alloc(32, 3).toString('base64'), hostname: 'mail.example.com',
    domains: async () => ['example.com'], resolveMx: async () => [{ priority: 10, exchange: 'mx.recipient.net' }],
    resolveAddresses: async () => ['8.8.8.8'], getPolicy: async () => ({ mode: 'none' }),
    dkimSign: async () => ({ signatures: 'DKIM-Signature: test\r\n', errors: [] }), ...extra };
}
test('durable encrypted RSA keys persist, exact domain signing prepends without blank line', async t => {
  let input, opts;
  const options = await fixture(t, { dkimSign: async (raw, config) => { input = raw; opts = config; return { signatures: 'DKIM-Signature: test\r\n' }; } });
  const direct = await createDirectMail(options);
  const [record] = await direct.records();
  assert.equal(record.name, 'hme._domainkey.example.com');
  assert.match(record.value, /^v=DKIM1; k=rsa; p=/);
  for (const file of await readdir(options.directory)) assert.ok(!(await readFile(join(options.directory, file))).includes(Buffer.from('PRIVATE KEY')));
  assert.deepEqual(await (await createDirectMail(options)).records(), [record]);
  const payload = await direct.prepare(message);
  assert.equal(payload.from, 'alias@example.com');
  assert.equal(Buffer.from(payload.rawBase64, 'base64').toString(), 'DKIM-Signature: test\r\n' + Buffer.from(message.rawBase64, 'base64').toString());
  assert.deepEqual(input, Buffer.from(message.rawBase64, 'base64'));
  assert.equal(opts.strict, true); assert.equal(opts.signatureData[0].signingDomain, 'example.com');
});
test('spoofed, duplicate, group and unowned From headers and empty signatures fail closed', async t => {
  const direct = await createDirectMail(await fixture(t));
  for (const from of ['a@evil.net', 'a@sub.example.com', 'a@example.com, b@example.com', 'Friends: a@example.com;', 'a@example.com\r\nFrom: b@example.com']) {
    await assert.rejects(direct.prepare({ ...message, rawBase64: Buffer.from(`From: ${from}\r\n\r\nbody`).toString('base64') }));
  }
  const unsigned = await createDirectMail(await fixture(t, { dkimSign: async () => ({ signatures: '', errors: [] }) }));
  await assert.rejects(unsigned.prepare(message));
});
test('MX delivery preserves envelope/MIME, verifies TLS and pins target via socket hook', async t => {
  let config, sent;
  const direct = await createDirectMail(await fixture(t, { createTransport: options => {
    config = options; return { sendMail: async msg => { sent = msg; return { accepted: [message.to] }; }, close() {} };
  } }));
  await direct.deliver({ ...message, from: 'alias@example.com' });
  assert.equal(config.port, 25); assert.equal(config.name, 'mail.example.com'); assert.equal(config.auth, undefined);
  assert.equal(config.tls.rejectUnauthorized, true); assert.equal(config.tls.servername, 'mx.recipient.net');
  assert.equal(typeof config.getSocket, 'function');
  assert.deepEqual(sent.envelope, { from: 'alias@example.com', to: [message.to] });
  assert.deepEqual(sent.raw, Buffer.from(message.rawBase64, 'base64'));
});
test('socket hook connects to validated literal IP without a second DNS lookup', async t => {
  let config, target;
  const socket = new EventEmitter(); socket.destroy = () => {};
  t.mock.method(net, 'connect', options => { target = options; queueMicrotask(() => socket.emit('connect')); return socket; });
  const direct = await createDirectMail(await fixture(t, { createTransport: options => {
    config = options; return { sendMail: async () => ({}), close() {} };
  } }));
  await direct.deliver(message);
  const result = await new Promise((resolve, reject) => config.getSocket({}, (error, value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(target, { host: '8.8.8.8', port: 25, family: 4 });
  assert.equal(result.connection, socket);
});
test('private, reserved, mapped IPv6 and mixed address sets never reach transport', async t => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1']) {
    const direct = await createDirectMail(await fixture(t, { resolveAddresses: async () => ['8.8.8.8', address], createTransport: () => { assert.fail('unsafe transport'); } }));
    await assert.rejects(direct.deliver(message));
  }
});
test('null MX and NXDOMAIN are permanent; ENODATA uses implicit MX', async t => {
  for (const resolveMx of [async () => [{ priority: 0, exchange: '.' }], async () => { throw Object.assign(new Error(), { code: 'ENOTFOUND' }); }]) {
    const direct = await createDirectMail(await fixture(t, { resolveMx }));
    await assert.rejects(direct.deliver(message), e => e.permanent === true);
  }
  let host;
  const direct = await createDirectMail(await fixture(t, { resolveMx: async () => { throw Object.assign(new Error(), { code: 'ENODATA' }); },
    createTransport: config => { host = config.host; return { sendMail: async () => ({}), close() {} }; } }));
  await direct.deliver(message); assert.equal(host, 'recipient.net');
});
test('temporary failures try alternate MX; DATA ambiguity never does; SMTP 5xx permanent', async t => {
  for (const [failure, attempts] of [[{ responseCode: 450 }, 2], [{ code: 'ECONNECTION' }, 2], [{ command: 'DATA' }, 1], [{ responseCode: 550, command: 'RCPT TO' }, 1]]) {
    let calls = 0;
    const direct = await createDirectMail(await fixture(t, { resolveMx: async () => [{ priority: 10, exchange: 'a.net' }, { priority: 20, exchange: 'b.net' }],
      createTransport: () => ({ sendMail: async () => { calls++; if (calls === 1) throw Object.assign(new Error(), failure); return {}; }, close() {} }) }));
    if (attempts === 1) await assert.rejects(direct.deliver(message), e => failure.responseCode === 550 ? e.permanent : e.uncertain);
    else await direct.deliver(message);
    assert.equal(calls, attempts);
  }
});
test('socket loss after server DATA readiness is uncertain even when nodemailer says CONN', async t => {
  let calls = 0;
  const direct = await createDirectMail(await fixture(t, { createTransport: config => ({
    sendMail: async () => { calls++; config.logger.debug({ tnx: 'server' }, '%s', '354 send data'); throw Object.assign(new Error(), { command: 'CONN', code: 'ECONNECTION' }); }, close() {} }) }));
  await assert.rejects(direct.deliver(message), e => e.uncertain); assert.equal(calls, 1);
});
test('MTA-STS enforce requires TLS and matching MX; policy errors are not silently ignored', async t => {
  let config;
  const direct = await createDirectMail(await fixture(t, { getPolicy: async () => ({ mode: 'enforce', mx: ['*.recipient.net'], expires: new Date(Date.now() + 60000).toISOString() }),
    createTransport: options => { config = options; return { sendMail: async () => ({}), close() {} }; } }));
  await direct.deliver(message); assert.equal(config.requireTLS, true);
  for (const policy of [{ mode: 'enforce', mx: ['other.net'] }, { mode: 'none', error: new Error('lookup failed') }]) {
    const failing = await createDirectMail(await fixture(t, { getPolicy: async () => policy, createTransport: () => assert.fail('policy bypass') }));
    await assert.rejects(failing.deliver(message));
  }
});
test('enforce policy survives restart and remains enforced when discovery fails', async t => {
  const options = await fixture(t, { getPolicy: async () => ({ mode: 'enforce', mx: ['mx.recipient.net'], expires: new Date(Date.now() + 60000).toISOString() }),
    createTransport: () => ({ sendMail: async () => ({}), close() {} }) });
  await (await createDirectMail(options)).deliver(message);
  let required;
  const restarted = await createDirectMail({ ...options, getPolicy: async (_domain, known) => {
    assert.equal(known.mode, 'enforce'); return { mode: 'none', error: new Error('DNS failed') };
  }, createTransport: config => { required = config.requireTLS; return { sendMail: async () => ({}), close() {} }; } });
  await restarted.deliver(message); assert.equal(required, true);
});
test('policy resolver protects HTTPS fetch from private targets too', async t => {
  const direct = await createDirectMail(await fixture(t, { resolveAddresses: async () => ['169.254.169.254'],
    getPolicy: async (_domain, _known, options) => { await options.resolver('mta-sts.recipient.net', 'A'); return { mode: 'none' }; },
    createTransport: () => assert.fail('unsafe transport') }));
  await assert.rejects(direct.deliver(message));
});
