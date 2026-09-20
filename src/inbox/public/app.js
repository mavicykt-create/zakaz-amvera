'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const API = '/inbox/api';
  const SOURCES = {
    mail: { label: 'Почта', mark: '@' },
    sber: { label: 'Сбербанк', mark: 'С' },
    tochka: { label: 'Точка Банк', mark: 'Т' },
    whatsapp: { label: 'WhatsApp', mark: 'W' },
    max: { label: 'MAX', mark: 'M' },
    milku: { label: 'milku.ru', mark: 'm' },
    flexbe: { label: 'Flexbe', mark: 'f' },
    'zakaz-amvera': { label: 'Онлайн-заказы', mark: 'Z' },
    manual: { label: 'Мои дела', mark: '✓' },
  };
  const COLUMNS = [
    { id: 'new', label: 'Новые', empty: 'Входящие появятся здесь', hint: 'Письма, сообщения, заказы и новые дела' },
    { id: 'working', label: 'В работе', empty: 'Можно начать с малого', hint: 'Возьмите новое дело в работу' },
    { id: 'waiting', label: 'Жду ответа', empty: 'Здесь будут ожидания', hint: 'Добавьте срок следующей проверки' },
    { id: 'done', label: 'Выполнено', empty: 'Место для завершённых дел', hint: 'История остаётся под рукой' },
  ];
  const CONNECTION_STATUS = { not_configured: 'Не настроено', waiting: 'Ожидаем данные', ok: 'Работает', error: 'Есть проблема' };
  const state = {
    session: null, cards: [], connections: [], timeZone: 'Asia/Yakutsk', source: '', focus: 'all', query: '', unreadOnly: false,
    stream: null, connected: false, reminders: false, notified: new Set(), detailId: null,
    detailRequest: 0, detailDirty: false, fetching: false, refreshAgain: false, epoch: 0, serverOffset: 0,
  };
  let toastTimer;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(kind) {
    const paths = {
      clock: ['M12 8v4l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
      chat: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z'],
      inbox: ['M4 4h16l2 11v5H2v-5L4 4Z', 'M2 15h6l2 3h4l2-3h6'],
      attachment: ['m21 11-9 9a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7L9 17.4a2 2 0 0 1-2.8-2.8L15 5.8'],
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths[kind] || paths.inbox) {
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function sourceInfo(source) { return SOURCES[source] || { label: String(source || 'Источник'), mark: '·' }; }
  function sourceMark(source) {
    const mark = el('span', 'source-mark', sourceInfo(source).mark);
    if (Object.hasOwn(SOURCES, source)) mark.classList.add(source);
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  function sourceBadge(source) {
    const badge = el('span', 'source-badge');
    badge.append(sourceMark(source), el('span', '', sourceInfo(source).label));
    return badge;
  }
  function showError(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
  }
  function now() { return Date.now() + state.serverOffset; }
  function dateValue(value) { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date : null; }
  function formatDate(value, options = {}) {
    const date = dateValue(value);
    if (!date) return '—';
    return new Intl.DateTimeFormat('ru-RU', { timeZone: state.timeZone, day: 'numeric', month: 'short', ...options }).format(date);
  }
  function formatTime(value) { return formatDate(value, { day: undefined, month: undefined, hour: '2-digit', minute: '2-digit' }); }
  function fullDate(value) { return formatDate(value, { year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function dateParts(value) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: state.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(value));
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }
  function dayKey(value) {
    const date = dateValue(value);
    if (!date) return '';
    const p = dateParts(date);
    return `${p.year}-${p.month}-${p.day}`;
  }
  function toLocalInput(value) {
    if (!dateValue(value)) return '';
    const p = dateParts(value);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  function fromLocalInput(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) throw new Error('Укажите корректную дату и время.');
    const [, year, month, day, hour, minute] = match.map(Number);
    const wallTime = Date.UTC(year, month - 1, day, hour, minute);
    let instant = wallTime;
    for (let i = 0; i < 3; i++) {
      const p = dateParts(instant);
      const mapped = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      instant += wallTime - mapped;
    }
    if (toLocalInput(instant) !== value) throw new Error('Это время недоступно в выбранном часовом поясе. Укажите другое.');
    return new Date(instant).toISOString();
  }
  function isOpen(card) { return card.status !== 'done'; }
  function isOverdue(card) { return isOpen(card) && dateValue(card.dueAt) && new Date(card.dueAt).getTime() <= now(); }
  function isToday(card) { return isOpen(card) && dayKey(card.dueAt) === dayKey(now()); }

  async function api(path, { method = 'GET', body, login = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.session?.csrfToken) headers['x-csrf-token'] = state.session.csrfToken;
    let response;
    try { response = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' }); }
    catch { throw new Error('Не удалось связаться с сервером. Проверьте соединение.'); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 429 ? 'Слишком много попыток. Подождите немного и попробуйте снова.' : response.status === 401 ? 'Проверьте пароль и шестизначный код.' : response.status === 403 ? 'Сессия обновилась. Войдите снова, чтобы сохранить изменения.' : response.status === 404 ? 'Дело не найдено. Обновите доску.' : response.status === 413 ? 'Слишком много текста. Сократите запись.' : response.status >= 500 ? 'Сервис временно недоступен. Попробуйте ещё раз.' : 'Не удалось сохранить. Проверьте заполненные поля.');
      error.status = response.status;
      if ((response.status === 401 || response.status === 403) && !login && state.session) {
        endSession();
        showLogin('login');
        showError('login-error', 'Сессия завершилась. Войдите снова.');
      }
      throw error;
    }
    return payload;
  }

  function endSession() {
    state.epoch++;
    state.session = null;
    state.stream?.close();
    state.stream = null;
    state.connected = false;
    state.cards = [];
    state.connections = [];
    state.detailId = null;
    state.detailRequest++;
    state.notified.clear();
    state.reminders = false;
    state.source = ''; state.focus = 'all'; state.query = ''; state.unreadOnly = false;
    state.fetching = false;
    state.refreshAgain = false;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    $('workspace').hidden = true;
    $('password').value = '';
    $('code').value = '';
    $('task-form').reset();
    $('note-form').reset();
    $('detail-form').reset();
    $('detail-title').textContent = '';
    $('detail-sender').textContent = '';
    $('search').value = '';
    $('source-filter').value = '';
    $('reminders').querySelector('span').textContent = 'Напоминания';
    $('reminder-hint').hidden = true;
    $('detail-events').replaceChildren();
    $('detail-notes').replaceChildren();
    $('board').replaceChildren();
  }
  function showLogin(mode) {
    $('boot').hidden = true;
    $('workspace').hidden = true;
    $('login-screen').hidden = false;
    $('login-form').hidden = mode !== 'login';
    $('setup-pending').hidden = mode !== 'setup';
    $('boot-error').hidden = mode !== 'error';
    if (mode === 'login') $('password').focus();
  }
  async function beginSession(session) {
    state.session = session;
    state.epoch++;
    try { new Intl.DateTimeFormat('ru-RU', { timeZone: session.timeZone || 'Asia/Yakutsk' }); state.timeZone = session.timeZone || 'Asia/Yakutsk'; }
    catch { state.timeZone = 'Asia/Yakutsk'; }
    $('boot').hidden = true;
    $('login-screen').hidden = true;
    $('workspace').hidden = false;
    $('password').value = '';
    $('code').value = '';
    renderBoard();
    await refreshBoard();
    if (state.session) connectStream();
  }
  async function boot() {
    $('boot').hidden = false;
    $('login-screen').hidden = true;
    try { await beginSession(await api('/session', { login: true })); }
    catch (error) { showLogin(error.status === 401 ? 'login' : error.status === 503 ? 'setup' : 'error'); }
  }

  async function refreshBoard() {
    if (!state.session) return;
    if (state.fetching) { state.refreshAgain = true; return; }
    state.fetching = true;
    const epoch = state.epoch;
    try {
      const data = await api('/board');
      if (!state.session || epoch !== state.epoch) return;
      state.cards = Array.isArray(data.cards) ? data.cards : [];
      state.connections = Array.isArray(data.connections) ? data.connections : [];
      if (dateValue(data.now)) state.serverOffset = new Date(data.now).getTime() - Date.now();
      if (data.timeZone) { try { new Intl.DateTimeFormat('ru-RU', { timeZone: data.timeZone }); state.timeZone = data.timeZone; } catch { /* Keep the authenticated timezone. */ } }
      $('board-error').hidden = true;
      $('board-updated').textContent = `Обновлено в ${formatTime(now())}`;
      renderBoard();
      renderConnections();
      checkReminders();
      if (state.detailId && $('detail-dialog').open) refreshDetail(true);
    } catch (error) {
      if (state.session && epoch === state.epoch) {
        $('board-error').hidden = false;
        $('empty-intro').hidden = true;
        if (!state.connected) setSync(false, 'Нет связи с сервером');
      }
    } finally {
      if (epoch === state.epoch) {
        state.fetching = false;
        if (state.refreshAgain) { state.refreshAgain = false; refreshBoard(); }
      }
    }
  }

  function setSync(connected, label) {
    state.connected = connected;
    $('sync-status').classList.toggle('connected', connected);
    $('sync-status').classList.toggle('disconnected', !connected);
    $('sync-label').textContent = label || (connected ? 'Доска обновляется' : 'Восстанавливаем связь…');
  }
  function connectStream() {
    state.stream?.close();
    if (!window.EventSource) { setSync(false, 'Обновляем раз в минуту'); return; }
    const stream = new EventSource(`${API}/stream`);
    state.stream = stream;
    stream.addEventListener('ready', () => { if (state.stream === stream) { setSync(true); refreshBoard(); } });
    stream.addEventListener('change', () => { if (state.stream === stream) { setSync(true); refreshBoard(); } });
    stream.onopen = () => { if (state.stream === stream) setSync(true); };
    stream.onerror = () => { if (state.stream === stream) { setSync(false); refreshBoard(); } };
  }

  function filteredCards() {
    const query = state.query.trim().toLocaleLowerCase('ru-RU');
    return state.cards.filter((card) => {
      if (state.source && card.source !== state.source) return false;
      if (state.unreadOnly && !card.unread) return false;
      if (state.focus === 'today' && !isToday(card)) return false;
      if (state.focus === 'overdue' && !isOverdue(card)) return false;
      if (state.focus === 'waiting' && card.status !== 'waiting') return false;
      if (query && ![card.title, card.sender, card.preview, sourceInfo(card.source).label].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU').includes(query)) return false;
      return true;
    });
  }

  function renderNavigation() {
    const fragment = document.createDocumentFragment();
    for (const [source, info] of Object.entries(SOURCES)) {
      const button = el('button', `source-nav${state.source === source ? ' active' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.source === source));
      const count = state.cards.filter((card) => card.source === source && (isOpen(card) || card.unread)).length;
      button.append(sourceMark(source), el('span', '', info.label), el('span', 'source-count', count || '—'));
      button.addEventListener('click', () => { state.source = state.source === source ? '' : source; $('source-filter').value = state.source; renderBoard(); });
      fragment.append(button);
    }
    $('source-navigation').replaceChildren(fragment);
    $('all-incoming').classList.toggle('active', !state.source);
  }

  function renderBoard() {
    const cards = filteredCards();
    const open = state.cards.filter(isOpen).length;
    const overdue = state.cards.filter(isOverdue).length;
    $('heading-count').textContent = cards.length;
    $('nav-count').textContent = open;
    $('metric-open').textContent = open;
    $('metric-today').textContent = state.cards.filter(isToday).length;
    $('metric-overdue').textContent = overdue;
    $('metric-overdue').classList.toggle('nonzero', overdue > 0);
    $('metric-waiting').textContent = state.cards.filter((card) => card.status === 'waiting').length;
    $('unread-count').textContent = state.cards.filter((card) => card.unread).length;
    $('unread-filter').classList.toggle('active', state.unreadOnly);
    $('unread-filter').setAttribute('aria-pressed', String(state.unreadOnly));
    for (const metric of document.querySelectorAll('.metric')) {
      const selected = metric.dataset.focus === state.focus;
      metric.classList.toggle('selected', selected);
      metric.setAttribute('aria-pressed', String(selected));
    }
    $('reset-filters').hidden = !(state.source || state.query || state.focus !== 'all' || state.unreadOnly);
    $('empty-intro').hidden = state.cards.length > 0 || !$('board-error').hidden;
    $('today-label').textContent = new Intl.DateTimeFormat('ru-RU', { timeZone: state.timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now())).toLocaleUpperCase('ru-RU');
    const zoneLabel = state.timeZone === 'Asia/Yakutsk' ? 'Якутск · UTC+9' : state.timeZone;
    $('time-zone-label').textContent = `Время на доске: ${zoneLabel}`;
    for (const label of document.querySelectorAll('.due-time-zone')) label.textContent = state.timeZone === 'Asia/Yakutsk' ? 'время Якутска' : state.timeZone;
    renderNavigation();
    const fragment = document.createDocumentFragment();
    for (const column of COLUMNS) {
      const section = el('section', 'board-column');
      section.dataset.status = column.id;
      section.setAttribute('aria-label', column.label);
      const head = el('div', 'column-head');
      const list = cards.filter((card) => card.status === column.id);
      list.sort((a, b) => {
        if (a.unread && !b.unread) return -1;
        if (!a.unread && b.unread) return 1;
        if (column.id === 'done') return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
        if (isOverdue(a) && !isOverdue(b)) return -1;
        if (!isOverdue(a) && isOverdue(b)) return 1;
        if (a.dueAt && b.dueAt) return new Date(a.dueAt) - new Date(b.dueAt);
        if (a.dueAt) return -1;
        if (b.dueAt) return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      head.append(el('span', 'column-dot'), el('h2', '', column.label), el('span', 'column-count', list.length));
      if (column.id === 'new') {
        const add = el('button', 'column-add', '+');
        add.type = 'button';
        add.setAttribute('aria-label', 'Создать новое дело');
        add.addEventListener('click', openNewTask);
        head.append(add);
      }
      const container = el('div', 'column-cards');
      for (const card of list) container.append(renderCard(card));
      if (!list.length) {
        const empty = el('div', 'column-empty');
        empty.append(icon('inbox'), el('strong', '', state.source || state.query || state.focus !== 'all' || state.unreadOnly ? 'Нет дел по этому фильтру' : column.empty));
        if (!state.source && !state.query && state.focus === 'all' && !state.unreadOnly) empty.append(el('span', '', column.hint));
        container.append(empty);
      }
      section.append(head, container);
      fragment.append(section);
    }
    $('board').replaceChildren(fragment);
  }

  function renderCard(card) {
    const button = el('button', `task-card${isOverdue(card) ? ' overdue' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-label', `${card.title || 'Без названия'}. ${sourceInfo(card.source).label}${card.unread ? '. Есть непрочитанные сообщения' : ''}${isOverdue(card) ? '. Срок прошёл' : ''}`);
    const topline = el('div', 'card-topline');
    topline.append(sourceBadge(card.source), el('span', 'card-date', formatDate(card.createdAt)));
    button.append(topline, el('h3', '', card.title || 'Без названия'));
    if (card.unread) button.append(el('span', 'unread-badge', card.status === 'done' ? 'Новое в завершённом деле' : 'Новое сообщение'));
    if (card.sender) button.append(el('p', 'card-sender', card.sender));
    if (card.preview) button.append(el('p', 'card-preview', card.preview));
    const footer = el('div', 'card-footer');
    if (dateValue(card.dueAt)) {
      const due = el('span', `due-badge${isOverdue(card) ? ' is-overdue' : isToday(card) ? ' is-today' : ''}`);
      due.title = fullDate(card.dueAt);
      due.append(icon('clock'), el('span', '', `${isOverdue(card) ? 'Срок прошёл · ' : isToday(card) ? 'Сегодня · ' : ''}${isToday(card) ? formatTime(card.dueAt) : formatDate(card.dueAt)}`));
      footer.append(due);
    } else { footer.append(el('span', 'due-badge', card.status === 'done' ? 'Дело завершено' : 'Без срока')); }
    const count = el('span', 'event-count');
    count.title = 'Сообщений в карточке';
    count.append(icon('chat'), el('span', '', Number(card.eventCount) || 0));
    footer.append(count);
    button.append(footer);
    button.addEventListener('click', () => openDetail(card.id));
    return button;
  }

  function renderConnections() {
    const problems = state.connections.some((connection) => connection.status === 'error');
    const working = state.connections.some((connection) => connection.status === 'ok');
    $('connection-dot').className = `connection-dot${problems ? ' error' : working ? ' ok' : ''}`;
    $('connection-dot').title = problems ? 'Проверьте подключения' : working ? 'Есть работающие источники' : 'Источники ожидают настройки';
    const fragment = document.createDocumentFragment();
    if (!state.connections.length) fragment.append(el('p', 'empty-text', 'Источники пока не настроены. Состояние появится после получения данных от сервера.'));
    for (const connection of state.connections) {
      const row = el('div', 'connection-row');
      const detail = el('div');
      detail.append(el('div', 'connection-name', connection.label || sourceInfo(connection.id).label));
      detail.append(el('div', 'connection-time', connection.lastSuccess ? `Получено: ${fullDate(connection.lastSuccess)}` : 'Успешных получений пока нет'));
      const status = Object.hasOwn(CONNECTION_STATUS, connection.status) ? connection.status : 'not_configured';
      row.append(sourceMark(connection.id), detail, el('span', `connection-status ${status}`, CONNECTION_STATUS[status]));
      if (connection.message) row.append(el('p', 'connection-message', connection.message));
      fragment.append(row);
    }
    $('connection-list').replaceChildren(fragment);
  }

  function openNewTask() {
    $('task-form').reset();
    showError('task-error', '');
    $('task-dialog').showModal();
    $('task-title').focus();
  }
  function openConnections() { renderConnections(); $('connections-dialog').showModal(); refreshBoard(); }
  async function openDetail(id) {
    state.detailId = String(id);
    state.detailDirty = false;
    $('detail-content').hidden = true;
    $('detail-loading').hidden = false;
    $('detail-loading').textContent = 'Загружаем карточку…';
    $('note-form').reset();
    showError('note-error', '');
    showError('detail-save-error', '');
    if (!$('detail-dialog').open) $('detail-dialog').showModal();
    const data = await refreshDetail(false);
    if (data?.card?.unread && state.detailId === String(id)) {
      try { await api(`/cards/${encodeURIComponent(id)}`, { method: 'PATCH', body: { unread: false } }); await refreshBoard(); }
      catch { if (state.session) toast('Не удалось отметить сообщение прочитанным.'); }
    }
  }
  async function refreshDetail(preserveEdits) {
    const id = state.detailId;
    if (!id) return;
    const request = ++state.detailRequest;
    try {
      const data = await api(`/cards/${encodeURIComponent(id)}`);
      if (state.detailId !== id || request !== state.detailRequest || !state.session) return;
      renderDetail(data, preserveEdits && state.detailDirty);
      $('detail-loading').hidden = true;
      $('detail-content').hidden = false;
      return data;
    } catch (error) {
      if (state.detailId !== id || request !== state.detailRequest) return;
      if ($('detail-content').hidden) $('detail-loading').textContent = error.message;
      else showError('detail-save-error', 'Не удалось обновить историю. Проверьте соединение.');
    }
  }

  function renderDetail(data, preserveEdits) {
    const card = data.card || {};
    $('detail-source').replaceChildren(sourceBadge(card.source));
    $('detail-title').textContent = card.title || 'Без названия';
    $('detail-sender').textContent = [card.sender, card.createdAt ? `Создано ${fullDate(card.createdAt)}` : ''].filter(Boolean).join(' · ');
    if (!preserveEdits) {
      $('detail-status').value = COLUMNS.some((column) => column.id === card.status) ? card.status : 'new';
      $('detail-due').value = toLocalInput(card.dueAt);
    }
    const events = document.createDocumentFragment();
    for (const event of Array.isArray(data.events) ? data.events : []) {
      const item = el('article', 'event');
      const header = el('div', 'event-header');
      header.append(sourceBadge(event.source || card.source));
      if (event.sender) header.append(el('span', 'event-sender', event.sender));
      const time = el('time', '', fullDate(event.occurredAt));
      if (dateValue(event.occurredAt)) time.dateTime = new Date(event.occurredAt).toISOString();
      header.append(time);
      item.append(header, el('p', 'event-text', event.text || 'Сообщение без текста'));
      if (Array.isArray(event.attachments) && event.attachments.length) {
        const attachments = el('div', 'attachments');
        for (const attachment of event.attachments) attachments.append(renderAttachment(attachment));
        item.append(attachments);
      }
      events.append(item);
    }
    if (!events.childNodes.length) events.append(el('p', 'empty-text', 'Сообщений пока нет. Добавьте подробности в заметку.'));
    $('detail-events').replaceChildren(events);
    const notes = document.createDocumentFragment();
    for (const note of Array.isArray(data.notes) ? data.notes : []) {
      const item = el('article', 'note');
      const time = el('time', '', fullDate(note.createdAt));
      if (dateValue(note.createdAt)) time.dateTime = new Date(note.createdAt).toISOString();
      item.append(el('p', '', note.text || ''), time);
      notes.append(item);
    }
    if (!notes.childNodes.length) notes.append(el('p', 'empty-text', 'Сохраните договорённость или следующий шаг.'));
    $('detail-notes').replaceChildren(notes);
  }

  function renderAttachment(attachment) {
    let href = null;
    if (attachment.id) href = `${API}/attachments/${encodeURIComponent(attachment.id)}`;
    else if (attachment.url) {
      try { const url = new URL(attachment.url); if (url.protocol === 'https:' && !url.username && !url.password) href = url.href; } catch { /* Do not render untrusted URL schemes. */ }
    }
    const link = el(href ? 'a' : 'span', `attachment${href ? '' : ' unavailable'}`);
    if (href) { link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; }
    link.append(icon('attachment'), el('span', '', attachment.name || 'Вложение'));
    if (Number(attachment.size) > 0) {
      const bytes = Number(attachment.size);
      link.append(el('span', 'attachment-size', bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`));
    }
    if (!href) link.title = 'Файл недоступен';
    return link;
  }

  function checkReminders() {
    if (!state.reminders || !state.session || !('Notification' in window) || Notification.permission !== 'granted') return;
    const due = state.cards.filter((card) => isOverdue(card) && !state.notified.has(`${card.id}:${card.dueAt}`));
    if (!due.length) return;
    for (const card of due) state.notified.add(`${card.id}:${card.dueAt}`);
    try {
      const notification = new Notification(due.length === 1 ? 'Пульт: наступил срок дела' : `Пульт: срок наступил у ${due.length} дел`, { body: 'Откройте рабочую доску, чтобы проверить важное.', icon: '/inbox/assets/favicon.svg', tag: 'inbox-due-reminder' });
      notification.onclick = () => { window.focus(); notification.close(); if (due.length === 1) openDetail(due[0].id); else { state.focus = 'overdue'; renderBoard(); } };
    } catch { toast('Срок наступил. Проверьте раздел «Просрочено».'); }
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('login-submit');
    button.disabled = true;
    showError('login-error', '');
    try { await beginSession(await api('/login', { method: 'POST', body: { password: $('password').value, code: $('code').value.trim() }, login: true })); }
    catch (error) { if (error.status === 503) showLogin('setup'); else { showError('login-error', error.message); $('code').value = ''; $('code').focus(); } }
    finally { button.disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try { await api('/logout', { method: 'POST', body: {} }); endSession(); showError('login-error', ''); showLogin('login'); }
    catch (error) { if (state.session) toast('Не удалось завершить сессию. Проверьте соединение и повторите выход.'); }
    finally { $('logout').disabled = false; }
  });
  $('task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = $('task-title').value.trim();
    if (!title) { showError('task-error', 'Добавьте название дела.'); $('task-title').focus(); return; }
    $('task-submit').disabled = true;
    showError('task-error', '');
    try {
      await api('/cards', { method: 'POST', body: { title, text: $('task-text').value.trim(), dueAt: fromLocalInput($('task-due').value) } });
      $('task-dialog').close();
      state.source = ''; state.focus = 'all'; state.query = ''; state.unreadOnly = false; $('source-filter').value = ''; $('search').value = '';
      await refreshBoard();
      toast('Дело создано. Оно останется на доске до завершения.');
    } catch (error) { showError('task-error', error.message); }
    finally { $('task-submit').disabled = false; }
  });
  $('detail-form').addEventListener('input', () => { state.detailDirty = true; });
  $('detail-form').addEventListener('change', () => { state.detailDirty = true; });
  $('detail-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = state.detailId;
    if (!id) return;
    $('detail-save').disabled = true;
    showError('detail-save-error', '');
    try {
      await api(`/cards/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: $('detail-status').value, dueAt: fromLocalInput($('detail-due').value) } });
      state.detailDirty = false;
      await refreshBoard();
      if (state.detailId === id) await refreshDetail(false);
      toast('Изменения сохранены.');
    } catch (error) { showError('detail-save-error', error.message); }
    finally { $('detail-save').disabled = false; }
  });
  $('note-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('note-text').value.trim();
    const id = state.detailId;
    if (!id || !text) { showError('note-error', 'Напишите текст заметки.'); return; }
    $('note-submit').disabled = true;
    showError('note-error', '');
    try {
      await api(`/cards/${encodeURIComponent(id)}/notes`, { method: 'POST', body: { text } });
      if (state.detailId === id) { $('note-text').value = ''; await refreshDetail(true); }
      await refreshBoard();
      toast('Заметка добавлена.');
    } catch (error) { showError('note-error', error.message); }
    finally { $('note-submit').disabled = false; }
  });
  $('detail-dialog').addEventListener('close', () => { state.detailId = null; state.detailRequest++; state.detailDirty = false; });
  $('new-task').addEventListener('click', openNewTask);
  $('open-connections').addEventListener('click', openConnections);
  $('empty-connections').addEventListener('click', openConnections);
  $('connections-refresh').addEventListener('click', refreshBoard);
  $('refresh-board').addEventListener('click', refreshBoard);
  $('setup-retry').addEventListener('click', boot);
  $('boot-retry').addEventListener('click', boot);
  $('search').addEventListener('input', () => { state.query = $('search').value; renderBoard(); });
  $('source-filter').addEventListener('change', () => { state.source = $('source-filter').value; renderBoard(); });
  function resetFilters() { state.source = ''; state.query = ''; state.focus = 'all'; state.unreadOnly = false; $('search').value = ''; $('source-filter').value = ''; renderBoard(); }
  $('unread-filter').addEventListener('click', () => { state.unreadOnly = !state.unreadOnly; if (state.unreadOnly) { state.focus = 'all'; state.source = ''; state.query = ''; $('source-filter').value = ''; $('search').value = ''; } renderBoard(); });
  $('reset-filters').addEventListener('click', resetFilters);
  $('all-incoming').addEventListener('click', resetFilters);
  for (const metric of document.querySelectorAll('.metric')) metric.addEventListener('click', () => { state.focus = metric.dataset.focus; renderBoard(); });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  for (const [value, source] of Object.entries(SOURCES)) { const option = el('option', '', source.label); option.value = value; $('source-filter').append(option); }
  $('close-reminder-hint').addEventListener('click', () => { $('reminder-hint').hidden = true; });
  $('reminders').addEventListener('click', async () => {
    $('reminder-hint').hidden = false;
    if (!('Notification' in window)) { toast('В этом браузере доступны напоминания внутри доски.'); return; }
    if (state.reminders) {
      state.reminders = false;
      $('reminders').querySelector('span').textContent = 'Напоминания';
      toast('Системные напоминания выключены для этой вкладки.');
      return;
    }
    try {
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission === 'granted') {
        state.reminders = true;
        $('reminders').querySelector('span').textContent = 'Напоминания вкл.';
        toast('Напоминания включены. Оставьте эту вкладку открытой.');
        checkReminders();
      } else { toast('Разрешите уведомления в настройках браузера. Сроки остаются видны на доске.'); }
    } catch { toast('Браузер не разрешил уведомления. Сроки остаются видны на доске.'); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.session) refreshBoard(); });
  window.addEventListener('online', () => { if (state.session) { refreshBoard(); if (!state.connected) connectStream(); } });
  window.addEventListener('offline', () => setSync(false, 'Нет интернета'));
  setInterval(() => { if (state.session) { renderBoard(); checkReminders(); } }, 30000);
  setInterval(() => { if (state.session && !document.hidden) refreshBoard(); }, 60000);
  boot();
})();
