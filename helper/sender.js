// Sends due outbox events to the coordinator.
// 2xx            -> acknowledged (the coordinator stored it durably)
// 400/403/409/422 -> rejected, will not be retried (retrying cannot help)
// 401            -> kept pending: usually a token/enrollment problem a human must fix
// network, 5xx, 408, 429 -> retry with backoff
export async function flush({ outbox, url, deviceId, token, now = Date.now(), timeoutMs = 5000, log = () => {} }) {
  const results = { acked: 0, rejected: 0, retry: 0 };
  for (const row of outbox.due(now)) {
    let res;
    try {
      res = await fetch(`${url.replace(/\/$/, '')}/v1/events`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-device-id': deviceId,
          authorization: `Bearer ${token}`,
        },
        body: row.payload,
      });
    } catch (err) {
      outbox.retryLater(row.event_id, `network: ${err.cause?.code ?? err.message}`, now);
      results.retry++;
      log(`retry ${row.event_id}: network error`);
      continue;
    }

    if (res.ok) {
      outbox.ack(row.event_id);
      results.acked++;
    } else if ([400, 403, 409, 422].includes(res.status)) {
      outbox.reject(row.event_id, `${res.status} ${(await res.text()).slice(0, 200)}`);
      results.rejected++;
      log(`rejected ${row.event_id}: ${res.status}`);
    } else {
      outbox.retryLater(row.event_id, `http ${res.status}`, now);
      results.retry++;
      log(`retry ${row.event_id}: http ${res.status}`);
    }
  }
  return results;
}
