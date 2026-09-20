export function remoteOrdersReader(env = process.env) {
  if (!env.INBOX_ORDERS_URL || !env.INBOX_ORDERS_READ_TOKEN) return undefined;
  const url = new URL(env.INBOX_ORDERS_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Укажите HTTPS URL API заказов без секретов в адресе');
  return async () => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${env.INBOX_ORDERS_READ_TOKEN}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Источник заказов недоступен');
    const maximum = 20 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maximum) throw new Error('Слишком большой список заказов');
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > maximum) { await reader.cancel(); throw new Error('Слишком большой список заказов'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (payload.source !== 'zakaz-amvera' || !Array.isArray(payload.orders)) throw new Error('Некорректный источник заказов');
    return payload.orders;
  };
}
