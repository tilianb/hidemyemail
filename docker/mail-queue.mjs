import { mkdir, readdir, readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';

export function queueEncryptionKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Invalid encryption key');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid encryption key');
  return key;
}
export function encryptState(key, id, state) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}
export function decryptState(key, id, data) {
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
}
export async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function durableWrite(directory, filename, data) {
  const partial = join(directory, `.hme-partial-${randomUUID()}`);
  const handle = await open(partial, 'wx', 0o600);
  try {
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(partial, join(directory, filename)); await syncDirectory(directory);
  } finally { await unlink(partial).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function createMailQueue({ directory, encryptionKey, maxBytes = 1024 ** 3,
  process, now = Date.now, retryMs = 60000, maxAgeMs = 5 * 86400000 }) {
  const key = queueEncryptionKey(encryptionKey);
  if (typeof process !== 'function' || !Number.isFinite(maxBytes) || maxBytes <= 0
    || !Number.isFinite(retryMs) || retryMs <= 0 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('Invalid queue options');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of await readdir(directory)) {
    if (file.startsWith('.hme-partial-')) await unlink(join(directory, file));
  }
  const files = async () => (await readdir(directory)).filter(f => /^[0-9a-f-]{36}\.mail$/.test(f));
  const load = async file => decryptState(key, file.slice(0, -5), await readFile(join(directory, file)));
  let serial = Promise.resolve(), active, timer;
  const exclusive = fn => {
    const result = serial.then(fn); serial = result.catch(() => {}); return result;
  };
  async function enqueue(kind, payload) {
    if (!['inbound', 'outbound'].includes(kind)) throw new Error('Invalid queue kind');
    // Serialize before yielding: caller mutations cannot change the durable payload.
    const snapshot = JSON.parse(JSON.stringify(payload));
    return exclusive(async () => {
      const id = randomUUID(), createdAt = now();
      const data = encryptState(key, id, { kind, payload: snapshot, createdAt, nextAttemptAt: createdAt, attempts: 0, lastError: null, failed: false });
      let size = 0;
      for (const file of await files()) size += (await stat(join(directory, file))).size;
      if (size + data.length > maxBytes) throw new Error('Mail queue capacity exceeded');
      await durableWrite(directory, `${id}.mail`, data); return id;
    });
  }
  function drain() {
    if (active) return active;
    active = (async () => {
      for (const file of await files()) {
        const state = await load(file), id = file.slice(0, -5);
        if (state.failed) continue;
        // Age is measured from durable admission, not from a retry deadline.
        if (now() - state.createdAt >= maxAgeMs) {
          state.failed = true; state.lastError = 'expired';
        } else {
          if (state.nextAttemptAt > now()) continue;
          try {
            await process(state.kind, state.payload, id);
            // A crash after external acceptance but before unlink can redeliver:
            // this is deliberately at-least-once, not an exactly-once claim.
            await exclusive(async () => { await unlink(join(directory, file)); await syncDirectory(directory); });
            continue;
          } catch (error) {
            state.attempts++;
            state.failed = error?.permanent === true;
            state.lastError = state.failed ? 'permanent' : error?.uncertain ? 'uncertain' : 'temporary';
            const backoff = Math.min(3600000, retryMs * 2 ** Math.min(state.attempts - 1, 30));
            state.nextAttemptAt = now() + Math.max(backoff, error?.uncertain ? 300000 : 0);
          }
        }
        await exclusive(() => durableWrite(directory, file, encryptState(key, id, state)));
      }
    })().finally(() => { active = undefined; });
    return active;
  }
  async function status() {
    return exclusive(async () => {
      const result = { inbound: 0, outbound: 0, failed: 0, oldestPendingAt: null };
      for (const file of await files()) {
        const state = await load(file);
        if (state.failed) result.failed++;
        else {
          result[state.kind]++;
          result.oldestPendingAt = Math.min(result.oldestPendingAt ?? Infinity, state.createdAt);
        }
      }
      return result;
    });
  }
  return { enqueue, drain, status,
    start() {
      if (timer) return;
      // Background corruption is retained and visible through explicit status/drain.
      timer = setInterval(() => { void drain().catch(() => {}); }, Math.min(retryMs, 60000));
      timer.unref(); void drain().catch(() => {});
    },
    async stop() { clearInterval(timer); timer = undefined; await active; await serial; },
  };
}
