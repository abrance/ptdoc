/** 未登录 / 登录态未知时，工作区必须既不绘制、也不进 Tab 序列。
 *
 * 事故形态（P0-2 + P2-9 同一根因）：index.html 里编辑器、侧栏、顶栏按钮都是
 * 静态标记，`startGate` 要等一次 `/api/setup/status` 往返才有结果，这段时间
 * 整站后台控件已经可 Tab、可点（后端靠 401 兜底，但读屏/键盘用户会撞进去）；
 * 同时先画一版工作区再被登录卡盖住，就是首屏闪一下。
 *
 * 所以口径统一成一句：**登录态已知且已登录之前，工作区保持 inert + hidden**。
 * 属性由 index.html 静态带上（首帧就生效，不给闪的机会），登录成功后由这里摘掉。
 */

/** 需要一起关上/打开的容器：工作区本身，以及指向工作区内部的「跳到编辑器」跳转链接。 */
export interface GatedEl {
  inert: boolean;
  /** DOM 库把它放宽到 `boolean | "until-found"`，这里跟着放宽免得多做转换。 */
  hidden: boolean | 'until-found';
}

export function applyWorkspaceGate(els: Array<GatedEl | null | undefined>, signedIn: boolean): void {
  const off = !signedIn;
  for (const el of els) {
    if (!el) continue;
    el.inert = off;
    el.hidden = off;
  }
}
