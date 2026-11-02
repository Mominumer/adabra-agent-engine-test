import http from 'node:http';
import { validateEvent } from '../shared/event.js';
import { validateReviewResult } from '../shared/review-result.js';

const MAX_BODY = 16 * 1024;
export const DEFAULT_LEASE_MS = 180_000; // claim expires after 3 min without renewal

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

const TASK_RE = /^[A-Z][A-Z0-9]*-\d{1,9}$/;
const RUN_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function createServer({ store, log = () => {}, now = () => Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  // Parses and validates a claim request body; sends the error response itself and returns null if invalid.
  async function claimBody(req, res, { needGeneration }) {
    let b;
    try {
      b = JSON.parse(await readBody(req));
    } catch (err) {
      send(res, err.code === 413 ? 413 : 400, { error: err.code === 413 ? 'body too large' : 'invalid JSON' });
      return null;
    }
    const ok =
      b && typeof b === 'object' &&
      TASK_RE.test(b.task_id) &&
      RUN_RE.test(b.run_id) &&
      (!needGeneration || (Number.isInteger(b.generation) && b.generation >= 1));
    if (!ok) {
      send(res, 400, { error: 'invalid claim request' });
      return null;
    }
    return b;
  }

  const claimResponse = (res, r, extra = {}) => {
    if (r.ok) return send(res, 200, { status: 'ok', generation: r.generation, expires_at: r.expires_at, ...extra });
    const code = r.reason === 'unknown_task' ? 422 : 409; // claimed, assigned, closed, expired ... all conflicts
    return send(res, code, { error: r.reason, owner: r.owner, expires_at: r.expires_at });
  };

  const refuseRole = (res, deviceId, needed) => {
    log(`403 device=${String(deviceId).slice(0, 40)}: needs role ${needed}`);
    return send(res, 403, { error: `this needs a ${needed} device` });
  };

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });

      if (req.method === 'GET' && req.url === '/v1/tasks/mine') {
        const deviceId = req.headers['x-device-id'];
        const auth = req.headers.authorization ?? '';
        if (!store.authenticate(deviceId, auth.startsWith('Bearer ') ? auth.slice(7) : '')) {
          log(`401 device=${String(deviceId).slice(0, 40)}`);
          return send(res, 401, { error: 'unauthorized' });
        }
        if (store.deviceRole(deviceId) !== 'builder') return refuseRole(res, deviceId, 'builder');
        return send(res, 200, { tasks: store.tasksFor(deviceId, now()) });
      }

      if (req.method === 'POST' && req.url.startsWith('/v1/')) {
        const deviceId = req.headers['x-device-id'];
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!store.authenticate(deviceId, token)) {
          log(`401 device=${String(deviceId).slice(0, 40)}`);
          return send(res, 401, { error: 'unauthorized' });
        }

        // Roles are separate on purpose: a builder cannot pass its own review, and a reviewer cannot act as a builder.
        // Decided here, before the body is read, with everything that is not for reviewers open to builders only.
        const role = store.deviceRole(deviceId);
        if (req.url === '/v1/review-results') {
          if (role !== 'reviewer') return refuseRole(res, deviceId, 'reviewer');
          let result;
          try {
            result = JSON.parse(await readBody(req));
          } catch (err) {
            if (err.code === 413) return send(res, 413, { error: 'body too large' });
            return send(res, 400, { error: 'invalid JSON' });
          }
          const errors = validateReviewResult(result);
          if (errors.length) return send(res, 400, { error: 'invalid review result', details: errors });
          const r = store.recordReviewResult(result, deviceId, now());
          log(`review ${result.result_id} task=${result.task_id} pr=${result.pr} device=${deviceId}: ${r.outcome}${r.verdict ? ` ${r.verdict}` : ''}${r.returned_to ? ` returned to ${r.returned_to}` : ''}`);
          if (r.outcome === 'unknown_task') return send(res, 422, { error: `unknown task ${result.task_id}` });
          if (r.outcome === 'conflict') return send(res, 409, { error: 'result_id already used with a different payload' });
          return send(res, 200, { status: r.outcome, result_id: result.result_id });
        }
        if (role !== 'builder') return refuseRole(res, deviceId, 'builder');

        if (req.url === '/v1/claims') {
          const b = await claimBody(req, res, { needGeneration: false });
          if (!b) return;
          const r = store.claimTask(b.task_id, deviceId, b.run_id, now(), leaseMs);
          log(`claim ${b.task_id} by ${deviceId}: ${r.ok ? `granted gen ${r.generation}` : r.reason}`);
          return claimResponse(res, r, { lease_ms: leaseMs });
        }
        if (req.url === '/v1/claims/renew') {
          const b = await claimBody(req, res, { needGeneration: true });
          if (!b) return;
          const r = store.renewClaim(b.task_id, deviceId, b.run_id, b.generation, now(), leaseMs);
          if (!r.ok) log(`renew ${b.task_id} by ${deviceId} refused: ${r.reason}`);
          return claimResponse(res, r, { lease_ms: leaseMs });
        }
        if (req.url === '/v1/claims/release') {
          const b = await claimBody(req, res, { needGeneration: true });
          if (!b) return;
          const r = store.releaseClaim(b.task_id, deviceId, b.run_id, b.generation);
          log(`release ${b.task_id} by ${deviceId}: ${r.ok ? 'ok' : r.reason}`);
          return r.ok ? send(res, 200, { status: 'ok' }) : send(res, 409, { error: r.reason });
        }

        if (req.url === '/v1/events') {
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

          // Retransmissions are acknowledged without re-checking the claim: the event was accepted once already.
          const seen = store.eventStatus(event);
          if (seen === 'conflict') return send(res, 409, { error: 'event_id already used with a different payload' });
          if (seen === 'duplicate') {
            log(`duplicate ${event.event_id} task=${event.task_id} device=${deviceId}`);
            return send(res, 200, { status: 'duplicate', event_id: event.event_id });
          }

          if (!store.eventMatchesClaim(event)) {
            const task = store.getTask(event.task_id);
            log(`fenced ${event.event_id} task=${event.task_id} device=${deviceId} gen=${event.claim_generation}`);
            return send(res, 409, { error: 'stale or missing claim', current_generation: task.generation });
          }

          store.insertEvent(event); // durable before we answer
          log(`created ${event.event_id} task=${event.task_id} device=${deviceId}`);
          return send(res, 200, { status: 'accepted', event_id: event.event_id });
        }
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log(`500 ${err.stack ?? err}`);
      return send(res, 500, { error: 'internal error' });
    }
  });
}
