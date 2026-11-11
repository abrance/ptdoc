import { showToast } from './toast.ts';
import { retentionSummary, validateRetention, type RetentionSettings } from './versions.ts';

// ─── 留存策略设置（M2-6）──────────────────────────────────
// 服务端按三项规则淘汰 auto 快照；这里只负责表单、预估展示与保存回执。

export interface RetentionState extends RetentionSettings {
  total: number;
  prune_estimate: number;
  pruned?: number;
}

export function retentionSectionHtml(): string {
  return `
    <form id="retention-form" class="settings-form">
      <p class="settings-hint">自动快照按「条数 / 天数 / 最少保留」淘汰，手动快照不会被自动清理。</p>
      <label>保留条数<input name="snapshot_keep_count" type="number" min="1" max="200" step="1" value="50" /></label>
      <label>保留天数<input name="snapshot_keep_days" type="number" min="1" max="365" step="1" value="30" /></label>
      <label>最少保留条数<input name="snapshot_keep_min" type="number" min="0" max="200" step="1" value="5" /></label>
      <p class="settings-hint" id="retention-summary">正在读取当期数量…</p>
      <div class="settings-ops"><button type="button" id="retention-save" class="btn-primary">保存留存策略</button></div>
    </form>`;
}

export function initRetentionSection(opts: { onStatus: (msg: string, isError?: boolean) => void }): {
  fill: () => Promise<void>;
} {
  const form = (): HTMLFormElement | null => document.getElementById('retention-form') as HTMLFormElement | null;
  const input = (name: keyof RetentionSettings): HTMLInputElement =>
    form()!.elements.namedItem(name) as HTMLInputElement;
  const summary = (): HTMLElement => document.getElementById('retention-summary') as HTMLElement;

  const collect = (): RetentionSettings => ({
    snapshot_keep_count: Number(input('snapshot_keep_count').value),
    snapshot_keep_days: Number(input('snapshot_keep_days').value),
    snapshot_keep_min: Number(input('snapshot_keep_min').value),
  });

  const show = (s: RetentionState): void => {
    input('snapshot_keep_count').value = String(s.snapshot_keep_count);
    input('snapshot_keep_days').value = String(s.snapshot_keep_days);
    input('snapshot_keep_min').value = String(s.snapshot_keep_min);
    summary().textContent = retentionSummary(s.total, s.prune_estimate);
  };

  const fill = async (): Promise<void> => {
    if (!form()) return;
    try {
      const res = await fetch('/api/settings/retention');
      const body = (await res.json().catch(() => ({}))) as RetentionState & { error?: string };
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      show(body);
    } catch (e) {
      summary().textContent = '读取留存策略失败：' + (e as Error).message;
    }
  };

  const save = async (): Promise<void> => {
    const values = collect();
    const errors = validateRetention(values);
    if (errors.length) {
      opts.onStatus(errors[0], true);
      return;
    }
    try {
      const res = await fetch('/api/settings/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = (await res.json().catch(() => ({}))) as RetentionState & { error?: string };
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      show(body);
      const pruned = body.pruned ?? 0;
      showToast(`留存策略已保存，清理 ${pruned} 条`, 'success');
      opts.onStatus(`留存策略已保存，本次清理 ${pruned} 条`);
    } catch (e) {
      opts.onStatus('保存留存策略失败：' + (e as Error).message, true);
    }
  };

  document.getElementById('retention-save')?.addEventListener('click', () => void save());
  return { fill };
}
