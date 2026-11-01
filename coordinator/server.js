import http from 'node:http';
import { validateEvent } from '../shared/event.js';

const MAX_BODY = 16 * 1024;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({ store, log = () => {} }) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });

      if (req.method === 'POST' && req.url === '/v1/events') {
        const deviceId = req.headers['x-device-id'];
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!store.authenticate(deviceId, token)) {
          log(`401 device=${String(deviceId).slice(0, 40)}`);
          return send(res, 401, { error: 'unauthorized' });
        }

        let event;
        try {
          event = JSON.parse(await readBody(req));
        } catch (err) {
          if (err.code === 413) return send(res, 413, { error: 'body too large' });
          return send(res, 400, { error: 'invalid JSON' });
        }

        const errors = validateEvent(event);
        if (errors.length) return send(res, 400, { error: 'invalid event', details: errors });
        if (event.device_id !== deviceId) {
          return send(res, 403, { error: 'event device_id does not match the authenticated device' });
        }
        if (!store.getTask(event.task_id)) {
          return send(res, 422, { error: `unknown task ${event.task_id}` });
        }

        const result = store.insertEvent(event); // durable before we answer
        if (result === 'conflict') {
          return send(res, 409, { error: 'event_id already used with a different payload' });
        }
        log(`${result} ${event.event_id} task=${event.task_id} device=${deviceId}`);
        return send(res, 200, { status: result === 'created' ? 'accepted' : 'duplicate', event_id: event.event_id });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log(`500 ${err.stack ?? err}`);
      return send(res, 500, { error: 'internal error' });
    }
  });
}
