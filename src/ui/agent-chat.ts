interface Conv {
  id: number;
  scene: string;
  title: string;
  updated_at: number;
}

interface Hit {
  id: string;
  title: string;
  snippet: string;
  score: number;
}

export function initAgentChat(opts: {
  onStatus: (msg: string, isError?: boolean) => void;
  getCurrentDocId: () => number | null;
  insertAtCursor: (text: string) => void;
  onDraftApplied?: (mode: 'replace-current' | 'create', docId: number | null) => void;
}): { toggle: () => void } {
  let drawer: HTMLElement | null = null;
  let scene: 'qa' | 'writer' = 'qa';
  let convId: number | null = null;
  let streaming = false;
  let draft = '';
  let hits: Hit[] = [];
  let abortCtrl: AbortController | null = null;

  const ensure = (): HTMLElement => {
    if (drawer && document.body.contains(drawer)) return drawer;
    drawer = document.createElement('div');
    drawer.id = 'agent-drawer';
    drawer.className = 'drawer agent-drawer';
    drawer.innerHTML = `
      <div class="drawer-head">
        <span class="drawer-title">智能体</span>
        <button id="agent-close" type="button">✕</button>
      </div>
      <div class="agent-tabs">
        <button type="button" data-scene="qa" class="active">知识库问答</button>
        <button type="button" data-scene="writer">文档编写</button>
      </div>
      <div class="agent-body">
        <aside class="agent-hist">
          <button type="button" id="agent-new">新对话</button>
          <ul id="agent-convs"></ul>
        </aside>
        <section class="agent-main">
          <div id="agent-msgs" class="agent-msgs"></div>
          <div id="agent-draft" class="agent-draft" hidden>
            <span>草稿已生成</span>
            <button type="button" id="draft-current">写入当前文档</button>
            <button type="button" id="draft-new">另存为新文档</button>
            <button type="button" id="draft-cancel">取消</button>
          </div>
          <div class="agent-input">
            <textarea id="agent-text" rows="3" placeholder="输入问题或编写指令"></textarea>
            <div class="agent-ops">
              <button type="button" id="agent-send">发送</button>
              <button type="button" id="agent-stop">停止</button>
              <button type="button" id="agent-retrieve" hidden>补充检索</button>
            </div>
          </div>
        </section>
        <aside class="agent-obs">
          <h4>可观测</h4>
          <div id="agent-obs"></div>
        </aside>
      </div>`;
    document.body.appendChild(drawer);
    document.getElementById('agent-close')!.onclick = () => drawer!.classList.remove('open');
    drawer.querySelectorAll('.agent-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        scene = (btn as HTMLElement).dataset.scene as 'qa' | 'writer';
        drawer!.querySelectorAll('.agent-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
        document.getElementById('agent-retrieve')!.hidden = scene !== 'writer';
        convId = null;
        void refresh();
      });
    });
    document.getElementById('agent-new')!.onclick = () => void newConv();
    document.getElementById('agent-send')!.onclick = () => void send();
    document.getElementById('agent-stop')!.onclick = () => void stop();
    document.getElementById('agent-retrieve')!.onclick = () => void retrieve();
    document.getElementById('draft-current')!.onclick = () => void applyDraft('replace-current');
    document.getElementById('draft-new')!.onclick = () => void applyDraft('create');
    document.getElementById('draft-cancel')!.onclick = () => {
      draft = '';
      document.getElementById('agent-draft')!.hidden = true;
    };
    document.getElementById('agent-convs')!.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
      const del = (e.target as HTMLElement).closest<HTMLElement>('button[data-del]');
      if (del && li) {
        if (!confirm('删除该对话？')) return;
        void fetch('/api/agents/conversations/' + li.dataset.id, { method: 'DELETE' }).then(() => {
          if (String(convId) === li.dataset.id) convId = null;
          void refresh();
        });
        return;
      }
      if (li) {
        convId = Number(li.dataset.id);
        void loadConv();
      }
    });
    document.getElementById('agent-msgs')!.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.handoff) void handoff(Number(t.dataset.handoff));
      if (t.dataset.cite) {
        const hit = hits[Number(t.dataset.cite)];
        if (hit) opts.insertAtCursor(`\n> ${hit.title}\n>\n> ${hit.snippet}\n\n`);
      }
    });
    document.getElementById('agent-obs')!.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (!t.dataset.cite) return;
      const hit = hits[Number(t.dataset.cite)];
      if (hit) opts.insertAtCursor(`\n> ${hit.title}\n>\n> ${hit.snippet}\n\n`);
    });
    return drawer;
  };

  const renderObs = (trace?: { model?: string; latency_ms?: number; input_tokens?: number; output_tokens?: number; hits?: Hit[]; spans?: Array<{ name: string; ms: number }> }): void => {
    const el = document.getElementById('agent-obs')!;
    const h = trace?.hits || hits;
    el.innerHTML =
      `<p>模型 ${trace?.model || '-'} · ${trace?.latency_ms ?? '-'} ms · token ${trace?.input_tokens ?? 0}/${trace?.output_tokens ?? 0}</p>` +
      '<h5>检索</h5>' +
      (h.length
        ? h
            .map(
              (x, i) =>
                `<div class="hit"><strong>${x.title}</strong><p>${x.snippet}</p><button type="button" data-cite="${i}">引用插入</button></div>`,
            )
            .join('')
        : '<p class="muted">无命中</p>') +
      '<h5>工具</h5>' +
      (trace?.spans || []).map((s) => `<div>${s.name} · ${s.ms}ms</div>`).join('');
  };

  const refresh = async (): Promise<void> => {
    const res = await fetch('/api/agents/conversations?scene=' + scene);
    const rows = (await res.json()) as Conv[];
    const ul = document.getElementById('agent-convs')!;
    ul.innerHTML = rows
      .map(
        (c) =>
          `<li data-id="${c.id}" class="${c.id === convId ? 'on' : ''}"><span>${c.title || '未命名'}</span><button type="button" data-del="1">删</button></li>`,
      )
      .join('');
    if (!convId && rows[0]) convId = rows[0].id;
    if (convId) await loadConv();
    else document.getElementById('agent-msgs')!.innerHTML = '';
  };

  const newConv = async (): Promise<void> => {
    const res = await fetch('/api/agents/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene }),
    });
    const j = (await res.json()) as { id: number; error?: string };
    if (!res.ok) return opts.onStatus(j.error || '失败', true);
    convId = j.id;
    await refresh();
  };

  const loadConv = async (): Promise<void> => {
    if (!convId) return;
    const res = await fetch('/api/agents/conversations/' + convId);
    const j = (await res.json()) as { turns: Array<{ id: number; role: string; content: string; draft_md?: string }> };
    const box = document.getElementById('agent-msgs')!;
    box.innerHTML = (j.turns || [])
      .map((t) => {
        const hand =
          scene === 'qa' && t.role === 'assistant'
            ? `<button type="button" data-handoff="${t.id}">交给编写智能体</button>`
            : '';
        return `<div class="msg ${t.role}"><pre>${escapeHtml(t.content)}</pre>${hand}</div>`;
      })
      .join('');
    box.scrollTop = box.scrollHeight;
    const last = [...(j.turns || [])].reverse().find((t) => t.role === 'assistant');
    if (last) {
      const tr = await fetch(`/api/agents/conversations/${convId}/turns/${last.id}/trace`);
      if (tr.ok) {
        const trace = await tr.json();
        hits = trace.hits || [];
        renderObs(trace);
      }
    } else renderObs();
  };

  const send = async (): Promise<void> => {
    if (!convId) await newConv();
    if (!convId || streaming) return;
    const ta = document.getElementById('agent-text') as HTMLTextAreaElement;
    const input = ta.value.trim();
    if (!input) return;
    ta.value = '';
    streaming = true;
    abortCtrl = new AbortController();
    const box = document.getElementById('agent-msgs')!;
    box.insertAdjacentHTML('beforeend', `<div class="msg user"><pre>${escapeHtml(input)}</pre></div><div class="msg assistant" id="agent-live"><pre></pre></div>`);
    const live = document.querySelector('#agent-live pre') as HTMLElement;
    try {
      const res = await fetch('/api/agents/conversations/' + convId + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, doc_id: opts.getCurrentDocId() }),
        signal: abortCtrl.signal,
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error || '发送失败');
      }
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let ev: any;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          if (ev.type === 'text-delta' && ev.delta) {
            acc += ev.delta;
            live.textContent = acc;
          }
          if (ev.type === 'data-draft') {
            draft = ev.data?.content || '';
            document.getElementById('agent-draft')!.hidden = !draft;
          }
          if (ev.type === 'error') opts.onStatus(ev.errorText || '生成失败', true);
          if (ev.type === 'data-done') await loadConv();
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') opts.onStatus('回复中断');
      else opts.onStatus((e as Error).message, true);
    }
    streaming = false;
    abortCtrl = null;
    const liveEl = document.getElementById('agent-live');
    if (liveEl) liveEl.id = '';
  };

  const stop = async (): Promise<void> => {
    abortCtrl?.abort();
    if (!convId) return;
    await fetch('/api/agents/conversations/' + convId + '/stop', { method: 'POST' });
  };

  const retrieve = async (): Promise<void> => {
    if (!convId) return;
    const q = prompt('补充检索查询');
    if (!q) return;
    const res = await fetch('/api/agents/conversations/' + convId + '/retrieve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const j = (await res.json()) as { hits?: Hit[]; error?: string };
    if (!res.ok) return opts.onStatus(j.error || '检索失败', true);
    hits = j.hits || [];
    renderObs();
  };

  const handoff = async (turnId: number): Promise<void> => {
    if (!convId) return;
    const res = await fetch('/api/agents/conversations/' + convId + '/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turn_id: turnId }),
    });
    const j = (await res.json()) as { writer_conversation_id?: number; error?: string };
    if (!res.ok) return opts.onStatus(j.error || '交接失败', true);
    scene = 'writer';
    convId = j.writer_conversation_id!;
    drawer!.querySelectorAll('.agent-tabs button').forEach((b) =>
      b.classList.toggle('active', (b as HTMLElement).dataset.scene === 'writer'),
    );
    document.getElementById('agent-retrieve')!.hidden = false;
    await refresh();
  };

  const applyDraft = async (mode: 'replace-current' | 'create'): Promise<void> => {
    if (!convId || !draft) return;
    const diffRes = await fetch('/api/agents/conversations/' + convId + '/draft-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: draft,
        target_doc_id: mode === 'replace-current' ? opts.getCurrentDocId() : undefined,
      }),
    });
    const diff = (await diffRes.json()) as { hunks: Array<{ type: string; lines: string[] }> };
    const preview = (diff.hunks || [])
      .map((h) => h.lines.map((l) => (h.type === 'add' ? '+ ' : h.type === 'del' ? '- ' : '  ') + l).join('\n'))
      .join('\n');
    if (!confirm('确认接受以下差异并写入？\n\n' + preview.slice(0, 2000))) return;
    const body: Record<string, unknown> = { mode, content: draft };
    if (mode === 'replace-current') body.doc_id = opts.getCurrentDocId();
    if (mode === 'create') {
      const key = prompt('新文档路径（doc_key）', 'notes/draft.md');
      if (!key) return;
      body.doc_key = key;
    }
    const res = await fetch('/api/agents/conversations/' + convId + '/apply-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) return opts.onStatus(j.error || '写入失败', true);
    opts.onStatus('草稿已写入');
    draft = '';
    document.getElementById('agent-draft')!.hidden = true;
    opts.onDraftApplied?.(mode, mode === 'replace-current' ? opts.getCurrentDocId() : null);
  };

  return {
    toggle: () => {
      const d = ensure();
      d.classList.toggle('open');
      if (d.classList.contains('open')) void refresh();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}
