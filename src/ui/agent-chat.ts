import { askConfirm, askText } from './dialog';

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

type AgentScene = 'qa' | 'writer';

export function initAgentChat(opts: {
  onStatus: (msg: string, isError?: boolean) => void;
  getCurrentDocId: () => number | null;
  insertAtCursor: (text: string) => void;
  onDraftApplied?: (mode: 'replace-current' | 'create', docId: number | null) => void;
  /** 会话列表变化时刷新 Sider 导航（app.ts 提供实现） */
  onConvsChanged?: () => void;
}): {
  setScene: (scene: AgentScene) => void;
  openConv: (convId: number, scene: AgentScene) => void;
  newConv: (scene: AgentScene) => Promise<void>;
  refresh: () => Promise<void>;
} {
  let scene: AgentScene = 'qa';
  let convId: number | null = null;
  let streaming = false;
  let draft = '';
  let hits: Hit[] = [];
  let abortCtrl: AbortController | null = null;

  // ─── 场景 Tab（主界面顶部）──────────────────────────
  const setScene = (next: AgentScene): void => {
    scene = next;
    document.querySelectorAll('.agent-tabs button').forEach((b) => {
      const on = (b as HTMLElement).dataset.scene === next;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.getElementById('agent-retrieve')!.hidden = scene !== 'writer';
    convId = null;
    void refresh();
    opts.onConvsChanged?.();
  };

  const bindOnce = new WeakSet<HTMLElement>();
  const bindPage = (): void => {
    document.querySelectorAll<HTMLButtonElement>('.agent-tabs button').forEach((btn) => {
      if (bindOnce.has(btn)) return;
      bindOnce.add(btn);
      btn.addEventListener('click', () => setScene(btn.dataset.scene as AgentScene));
    });
    document.getElementById('agent-send')!.onclick = () => void send();
    document.getElementById('agent-stop')!.onclick = () => void stop();
    document.getElementById('agent-retrieve')!.onclick = () => void retrieve();
    document.getElementById('draft-current')!.onclick = () => void applyDraft('replace-current');
    document.getElementById('draft-new')!.onclick = () => void applyDraft('create');
    document.getElementById('draft-cancel')!.onclick = () => {
      draft = '';
      document.getElementById('agent-draft')!.hidden = true;
    };
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
  };

  // ─── 可观测面板 ────────────────────────────────────
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

  // ─── 会话加载 / 新建 ───────────────────────────────
  const refresh = async (): Promise<void> => {
    bindPage();
    if (convId == null) {
      document.getElementById('agent-msgs')!.innerHTML =
        '<div class="agent-empty">从左侧选择会话，或点「新对话」开始</div>';
      renderObs();
      return;
    }
    await loadConv();
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
    opts.onConvsChanged?.();
  };

  const loadConv = async (): Promise<void> => {
    if (convId == null) return;
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

  // ─── 发送（SSE 流式）──────────────────────────────
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
    const q = await askText({ title: '补充检索', label: '检索查询', confirmLabel: '检索' });
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
    convId = j.writer_conversation_id!;
    setScene('writer');
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
    const ok = await askConfirm('接受以下差异并写入？\n\n' + preview.slice(0, 2000), {
      title: '确认智能体改动',
      confirmLabel: '写入',
    });
    if (!ok) return;
    const body: Record<string, unknown> = { mode, content: draft };
    if (mode === 'replace-current') body.doc_id = opts.getCurrentDocId();
    if (mode === 'create') {
      const key = await askText({
        title: '另存为新文档',
        label: '新文档路径（doc_key）',
        value: 'notes/draft.md',
        confirmLabel: '创建',
      });
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
    setScene,
    // Sider 会话导航回调：打开指定会话
    openConv: (id: number, s: AgentScene) => {
      scene = s;
      convId = id;
      setScene(s);
      convId = id;
      void refresh();
    },
    newConv,
    refresh,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}
