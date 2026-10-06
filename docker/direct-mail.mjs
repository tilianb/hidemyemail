import dns from 'node:dns/promises';
import net from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import { queueEncryptionKey, encryptState, decryptState, durableWrite } from './mail-queue.mjs';

const rsa = promisify(generateKeyPair);
const permanent = () => Object.assign(new Error('Direct mail permanently rejected'), { permanent: true });
const temporary = () => new Error('Direct mail temporarily unavailable');
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
function domainName(value) {
  const name = String(value).toLowerCase().replace(/\.$/, '');
  if (!DOMAIN.test(name)) throw permanent();
  return name;
}
function mailbox(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw permanent();
  const parsed = addressparser(value);
  if (parsed.length !== 1 || parsed[0].group || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(parsed[0].address ?? '')) throw permanent();
  const [local, domain] = parsed[0].address.split('@');
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) throw permanent();
  return `${local}@${domainName(domain)}`;
}
function rawMessage(value) {
  if (typeof value !== 'string' || !value || Buffer.from(value, 'base64').toString('base64') !== value) throw permanent();
  return Buffer.from(value, 'base64');
}
function headerFrom(raw) {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) throw permanent();
  const text = raw.subarray(0, end).toString('utf8');
  if (/[\0]|\r(?!\n)|(?<!\r)\n/.test(text)) throw permanent();
  const fields = [];
  for (const line of text.split('\r\n')) {
    if (/^[ \t]/.test(line)) {
      if (!fields.length) throw permanent();
      fields[fields.length - 1] += ' ' + line.trim();
    } else {
      if (!/^[!-9;-~]+:/.test(line)) throw permanent();
      fields.push(line);
    }
  }
  const from = fields.filter(line => /^from:/i.test(line));
  if (from.length !== 1) throw permanent();
  return mailbox(from[0].slice(5).trim());
}
const blocked = new net.BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(ip, prefix, 'ipv6');
function publicAddress(ip) {
  const family = net.isIP(ip);
  return family === 4 ? !blocked.check(ip, 'ipv4') : family === 6 && globalV6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}
async function deadline(promise, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(temporary()), ms); })]); }
  finally { clearTimeout(timer); }
}
async function defaultAddresses(host) {
  const values = await Promise.all([dns.resolve4(host), dns.resolve6(host)].map(async request => {
    try { return await request; } catch (error) { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error; }
  }));
  return values.flat();
}
async function defaultSign(raw, options) { return (await import('mailauth')).dkimSign(raw, options); }
async function defaultPolicy(domain, known, options) {
  return (await import('mailauth/lib/mta-sts.js')).getPolicy(domain, known, options);
}
function matchesPolicy(host, policy) {
  return policy.mx?.some(pattern => {
    pattern = pattern.toLowerCase().replace(/\.$/, '');
    if (!pattern.startsWith('*.')) return host === pattern;
    const suffix = pattern.slice(1), label = host.slice(0, -suffix.length);
    return host.endsWith(suffix) && label.length > 0 && !label.includes('.');
  });
}

export async function createDirectMail({ directory, encryptionKey, hostname, domains,
  resolveMx = dns.resolveMx, resolveAddresses = defaultAddresses, createTransport = nodemailer.createTransport,
  dkimSign = defaultSign, now = Date.now, getPolicy = defaultPolicy }) {
  const key = queueEncryptionKey(encryptionKey);
  hostname = domainName(hostname);
  if (typeof domains !== 'function') throw new Error('Owned domain provider required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = domain => createHash('sha256').update(domain).digest('hex');
  const inflight = new Map();
  async function domainKey(domain) {
    if (inflight.has(domain)) return inflight.get(domain);
    const pending = (async () => {
      const id = identity(domain), filename = `${id}.dkim`;
      try { return decryptState(key, id, await readFile(join(directory, filename))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const pair = await rsa('rsa', { modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } });
      const state = { privateKey: pair.privateKey, publicKey: pair.publicKey.toString('base64') };
      await durableWrite(directory, filename, encryptState(key, id, state)); return state;
    })();
    inflight.set(domain, pending);
    try { return await pending; } finally { inflight.delete(domain); }
  }
  async function records() {
    const result = [];
    for (const domain of new Set((await domains()).map(domainName))) {
      const pair = await domainKey(domain);
      result.push({ domain, name: `hme._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${pair.publicKey}` });
    }
    return result;
  }
  async function prepare(message) {
    const from = mailbox(message.from), to = mailbox(message.to), raw = rawMessage(message.rawBase64);
    const domain = from.split('@')[1];
    if (headerFrom(raw).split('@')[1] !== domain || !(await domains()).map(domainName).includes(domain)) throw permanent();
    const pair = await domainKey(domain);
    const signed = await dkimSign(raw, { strict: true, signatureData: [{ signingDomain: domain, selector: 'hme', privateKey: pair.privateKey }] });
    if (!signed?.signatures || signed.errors?.length || !signed.signatures.startsWith('DKIM-Signature:')
      || !signed.signatures.endsWith('\r\n') || signed.signatures.includes('\r\n\r\n')) throw permanent();
    return { from, to, rawBase64: Buffer.concat([Buffer.from(signed.signatures), raw]).toString('base64') };
  }
  async function safeAddresses(host) {
    const result = (await deadline(resolveAddresses(host))).map(value => typeof value === 'string' ? value : value.address);
    if (!result.length || result.some(ip => !publicAddress(ip))) throw temporary();
    return result;
  }
  async function policyFor(domain) {
    const id = `${identity(domain)}-sts`, filename = `${identity(domain)}.sts`;
    let known;
    try { known = decryptState(key, id, await readFile(join(directory, filename))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // mailauth pins HTTPS to the resolver's literal IP and verifies its domain certificate.
    const policy = await deadline(getPolicy(domain, known, { strict: true, timeout: 15000, maxPolicySize: 65536,
      resolver: async (host, type) => {
        if (type === 'A' || type === 'AAAA') {
          const addresses = await safeAddresses(host);
          const filtered = addresses.filter(ip => net.isIP(ip) === (type === 'A' ? 4 : 6));
          if (!filtered.length) throw Object.assign(temporary(), { code: 'ENODATA' });
          return filtered;
        }
        return deadline(dns.resolve(host, type));
      } }), 20000);
    const cachedEnforce = known?.mode === 'enforce' && Date.parse(known.expires) > now();
    if (policy.error) {
      if (cachedEnforce) return known;
      throw temporary(); // Never downgrade to cleartext because policy retrieval failed.
    }
    if (!['none', 'testing', 'enforce'].includes(policy.mode)) throw temporary();
    if (policy.expires) await durableWrite(directory, filename, encryptState(key, id, policy));
    return policy;
  }
  async function deliver(payload) {
    const from = mailbox(payload.from), to = mailbox(payload.to), raw = rawMessage(payload.rawBase64);
    const domain = to.split('@')[1];
    let mx;
    try { mx = await deadline(resolveMx(domain)); }
    catch (error) {
      if (error.code === 'ENOTFOUND') throw permanent();
      if (error.code !== 'ENODATA') throw temporary();
      mx = [];
    }
    if (mx.some(record => record.exchange === '.' || record.exchange === '')) throw permanent();
    if (!mx.length) mx = [{ priority: 0, exchange: domain }];
    // Random tie order, ascending preference. No external data enters filenames/logs.
    mx = mx.map(record => ({ ...record, exchange: domainName(record.exchange), tie: Math.random() }))
      .sort((a, b) => a.priority - b.priority || a.tie - b.tie);
    const policy = await policyFor(domain);
    for (const record of mx) {
      if (policy.mode === 'enforce' && !matchesPolicy(record.exchange, policy)) continue;
      let transport, dataReady = false;
      try {
        const addresses = await safeAddresses(record.exchange), ip = addresses[0];
        // SMTPConnection reports socket loss as CONN even after DATA. Track only
        // protocol readiness in a discard-only logger; never store message data.
        const logger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(level => [level, (meta, text, ...args) => {
          if (meta?.tnx === 'server' && /^354(?: |$)/.test(text === '%s' ? String(args[0]) : String(text))) dataReady = true;
        }]));
        transport = createTransport({ host: record.exchange, port: 25, name: hostname, secure: false,
          requireTLS: policy.mode === 'enforce', opportunisticTLS: false,
          tls: { rejectUnauthorized: true, servername: record.exchange },
          connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 240000,
          disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1, logger, transactionLog: true,
          getSocket(_options, callback) {
            const socket = net.connect({ host: ip, port: 25, family: net.isIP(ip) });
            let complete = false;
            const finish = (error) => {
              if (complete) return; complete = true; clearTimeout(timer);
              if (error) { socket.destroy(); callback(temporary()); }
              else callback(null, { connection: socket });
            };
            const timer = setTimeout(() => finish(temporary()), 30000);
            socket.once('error', finish); socket.once('connect', () => finish());
          },
        });
        const info = await transport.sendMail({ envelope: { from, to: [to] }, raw });
        if (info.rejected?.length) throw Object.assign(temporary(), info.rejectedErrors?.[0]);
        return;
      } catch (error) {
        const code = Number(error?.responseCode ?? 0);
        if (code >= 500 && code < 600) throw permanent();
        if (!(code >= 400 && code < 500) && (dataReady || error?.command === 'DATA' || error?.uncertain)) {
          throw Object.assign(new Error('Direct mail acceptance uncertain'), { uncertain: true });
        }
        // Definitive 4xx or pre-DATA connection failures may use the next MX.
      } finally { transport?.close?.(); }
    }
    throw temporary();
  }
  return { prepare, deliver, records };
}
