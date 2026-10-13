// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const rowsEl = document.getElementById('rows');
  const emptyEl = document.getElementById('empty');
  const totalEl = document.getElementById('total');
  const setupEl = document.getElementById('setup');
  const noticeEl = document.getElementById('notice');
  /** @type {Map<string, string|null>} */
  const summaries = new Map();
  /** @type {any[]} */
  let rows = [];
  let setupMessage = null;
  let searchTimer = 0;

  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('logAll').addEventListener('click', () => {
    const all = [...rowsEl.querySelectorAll('.row:not(.done)')].map(collect).filter(Boolean);
    if (all.length > 0) {
      vscode.postMessage({ type: 'post', rows: all });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        rows = msg.rows;
        setupMessage = msg.setupMessage;
        totalEl.textContent = msg.total === '0m' ? '' : `${msg.total} to log`;
        renderSetup();
        render();
        break;
      case 'rows':
        rows = msg.rows;
        render();
        break;
      case 'summary':
        summaries.set(msg.key, msg.missing ? null : msg.summary);
        updateSummaries();
        break;
      case 'manual':
        setRowNote(msg.id, msg.text, 'warn');
        break;
      case 'searchResults':
        showResults(msg.id, msg.results);
        break;
      case 'rowBusy':
        rowEl(msg.id)?.classList.add('busy');
        break;
      case 'rowDone': {
        const el = rowEl(msg.id);
        if (el) {
          el.classList.remove('busy');
          el.classList.add('done');
          el.querySelectorAll('input, textarea, button').forEach((c) => ((/** @type {any} */ (c)).disabled = true));
          setRowNote(msg.id, msg.message, 'ok');
        }
        rows = rows.filter((r) => r.id !== msg.id);
        break;
      }
      case 'rowError':
        rowEl(msg.id)?.classList.remove('busy');
        setRowNote(msg.id, msg.message, 'error');
        break;
      case 'notice':
        noticeEl.hidden = false;
        noticeEl.className = msg.level;
        noticeEl.textContent = msg.message;
        break;
    }
  });

  function renderSetup() {
    setupEl.hidden = !setupMessage;
    setupEl.replaceChildren();
    if (!setupMessage) {
      return;
    }
    const text = document.createElement('span');
    text.textContent = setupMessage + ' ';
    const settings = button('Open settings', 'secondary', () => vscode.postMessage({ type: 'openSettings' }));
    const token = button('Set API token', 'secondary', () => vscode.postMessage({ type: 'setToken' }));
    setupEl.append(text, settings, token);
  }

  function render() {
    rowsEl.replaceChildren();
    emptyEl.hidden = rows.length > 0;
    let lastDay = '';
    for (const row of rows) {
      if (row.day !== lastDay) {
        lastDay = row.day;
        const h = document.createElement('h2');
        h.textContent = row.dayLabel;
        rowsEl.append(h);
      }
      rowsEl.append(renderRow(row));
    }
    updateSummaries();
  }

  function renderRow(row) {
    const el = document.createElement('section');
    el.className = 'row';
    el.dataset.id = row.id;
    el.dataset.rawMs = String(row.rawMs);

    const top = document.createElement('div');
    top.className = 'top';

    const keyWrap = document.createElement('div');
    keyWrap.className = 'key';
    const key = document.createElement('input');
    key.className = 'issue';
    key.value = row.targetKey;
    key.placeholder = 'Search issues';
    key.setAttribute('aria-label', 'Jira issue');
    key.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = key.value.trim();
      searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', id: row.id, query: q }), 250);
    });
    key.addEventListener('change', () => {
      const k = key.value.trim().toUpperCase();
      key.value = k;
      if (/^[A-Z][A-Z0-9_]+-\d+$/.test(k)) {
        vscode.postMessage({ type: 'lookup', key: k });
      }
      updateSummaries();
    });
    const results = document.createElement('ul');
    results.className = 'results';
    results.hidden = true;
    keyWrap.append(key, results);

    const summary = document.createElement('span');
    summary.className = 'summary';

    const duration = document.createElement('input');
    duration.className = 'duration';
    duration.value = row.duration;
    duration.setAttribute('aria-label', 'Duration');
    duration.title = 'e.g. 1h 30m, 1.5h or 90m';

    top.append(keyWrap, summary, duration);

    const comment = document.createElement('textarea');
    comment.className = 'comment';
    comment.value = row.comment;
    comment.rows = Math.min(4, Math.max(1, row.comment.split('\n').length));
    comment.setAttribute('aria-label', 'Worklog comment');

    const bottom = document.createElement('div');
    bottom.className = 'bottom';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = row.branches.length ? row.branches.join(', ') : '';
    const note = document.createElement('span');
    note.className = 'note';
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    buttons.append(
      button('Discard', 'secondary', () => vscode.postMessage({ type: 'discard', id: row.id, rawMs: row.rawMs })),
      button('Split', 'secondary', () => vscode.postMessage({ type: 'split', id: row.id })),
      button('Log', '', () => {
        const req = collect(el);
        if (req) {
          vscode.postMessage({ type: 'post', rows: [req] });
        }
      }),
    );
    bottom.append(meta, note, buttons);

    el.append(top, comment, bottom);
    return el;
  }

  function collect(el) {
    const row = rows.find((r) => r.id === el.dataset.id);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      targetKey: el.querySelector('.issue').value,
      duration: el.querySelector('.duration').value,
      comment: el.querySelector('.comment').value,
      rawMs: row.rawMs,
    };
  }

  function showResults(id, results) {
    const el = rowEl(id);
    if (!el) {
      return;
    }
    const list = el.querySelector('.results');
    list.replaceChildren();
    list.hidden = results.length === 0;
    for (const r of results) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      const k = document.createElement('strong');
      k.textContent = r.key;
      li.append(k, document.createTextNode(' ' + r.summary));
      const pick = () => {
        const input = el.querySelector('.issue');
        input.value = r.key;
        summaries.set(r.key, r.summary);
        list.hidden = true;
        updateSummaries();
      };
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick();
      });
      li.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
      list.append(li);
    }
  }

  function updateSummaries() {
    for (const el of rowsEl.querySelectorAll('.row')) {
      const key = el.querySelector('.issue').value.trim().toUpperCase();
      const span = el.querySelector('.summary');
      if (!key) {
        span.textContent = 'Pick an issue to log this time';
        span.className = 'summary muted';
      } else if (summaries.has(key)) {
        const s = summaries.get(key);
        span.textContent = s === null ? `${key} was not found in Jira` : s;
        span.className = s === null ? 'summary error' : 'summary';
      } else {
        span.textContent = '';
        span.className = 'summary';
      }
    }
  }

  function setRowNote(id, text, level) {
    const note = rowEl(id)?.querySelector('.note');
    if (note) {
      note.textContent = text;
      note.className = `note ${level}`;
    }
  }

  function rowEl(id) {
    return rowsEl.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) {
      b.className = cls;
    }
    b.addEventListener('click', onClick);
    return b;
  }

  document.addEventListener('click', (e) => {
    if (!(/** @type {HTMLElement} */ (e.target).closest('.key'))) {
      document.querySelectorAll('.results').forEach((l) => ((/** @type {HTMLElement} */ (l)).hidden = true));
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
