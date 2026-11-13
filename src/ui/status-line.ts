/** 状态栏与 toast 的分工（P0-1）。
 *
 * 事故形态：`setStatus(msg, true)` 同时把**同一句**错误写进状态栏和弹一条 toast，
 * 屏幕上一句话出现两次；而且状态栏那行会被下一次操作覆盖，写两遍只是噪音。
 *
 * 现在的分工：状态栏只放「操作失败」这个终态标记（会被下一次操作替换，正好合适），
 * 具体原因只在 toast 里说一次。纯函数，便于单测。
 */
export type StatusPaint = {
  /** 状态栏文字 */
  text: string;
  error: boolean;
  /** 需要弹的 toast 内容（空串 = 不弹） */
  toast: string;
};

export function paintStatus(msg: string, isError: boolean): StatusPaint {
  if (isError) {
    return { text: msg ? '操作失败' : '', error: !!msg, toast: msg };
  }
  return { text: msg, error: false, toast: '' };
}
