// ВАЖНО: это только изменённая часть обработчика 1С

async function handleExchangeRequest(req, res) {
  const rawMode = req.query.mode;
  const rawType = req.query.type;
  const mode = String(rawMode || '').trim().toLowerCase();
  const type = String(rawType || '').trim().toLowerCase();

  console.log('1C exchange request:', {
    method: req.method,
    path: req.path,
    query: req.query,
    type,
    mode
  });

  // ❗ фикс: не валимся если mode нет
  if (!mode) {
    return res.type('text/plain; charset=utf-8').send('success');
  }

  if (type && type !== 'catalog') {
    return res.type('text/plain; charset=utf-8').send('failure\nПоддерживается только type=catalog');
  }

  if (mode === 'checkauth') {
    return res.type('text/plain; charset=utf-8')
      .send(`success\n${EXCHANGE_SESSION_NAME}\n${EXCHANGE_SESSION_ID}`);
  }

  if (mode === 'init') {
    await resetExchangeDir();
    return res.type('text/plain; charset=utf-8')
      .send(`zip=no\nfile_limit=${MAX_EXCHANGE_FILE_SIZE}`);
  }

  if (mode === 'file') {
    await ensureExchangeDir();

    const filename = sanitizeExchangeFilename(req.query.filename || req.query.file || '');

    if (!filename) {
      return res.status(400)
        .type('text/plain; charset=utf-8')
        .send('failure\nНе передано имя файла');
    }

    const target = path.join(EXCHANGE_UPLOAD_DIR, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });

    const body = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');

    await fs.writeFile(target, body);

    console.log('1C file saved:', filename, body.length);

    return res.type('text/plain; charset=utf-8').send('success');
  }

  if (mode === 'import') {
    const result = await tryImportFromExchangeDir();

    console.log('1C import result:', result);

    return res.type('text/plain; charset=utf-8').send('success');
  }

  return res.type('text/plain; charset=utf-8')
    .send(`failure\nНеизвестный mode: ${mode}`);
}
