/** 智能体页「结果态」控件的显隐口径。
 *
 * 没有会话（`convId == null`）时，「停止」「补充检索」与右侧可观测面板都没有作用对象：
 * 留着就是能点、能 Tab 到、点了不吭声的假控件。纯函数，便于单测。
 */
export type AgentChrome = {
  /** 「停止」按钮是否隐藏 */
  stopHidden: boolean;
  /** 「补充检索」按钮是否隐藏（只有文档编写场景才有这个动作） */
  retrieveHidden: boolean;
  /** 右侧可观测面板（含 grid 左列收起）是否隐藏 */
  obsHidden: boolean;
};

export function agentChrome(hasConv: boolean, scene: 'qa' | 'writer'): AgentChrome {
  const obsHidden = !hasConv;
  return {
    stopHidden: !hasConv,
    retrieveHidden: !hasConv || scene !== 'writer',
    obsHidden,
  };
}
