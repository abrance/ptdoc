export interface DiffHunk {
  type: 'equal' | 'add' | 'del';
  lines: string[];
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

export function lineDiff(oldText: string, newText: string): DiffHunk[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const dp = lcsTable(a, b);
  const hunks: DiffHunk[] = [];
  const push = (type: DiffHunk['type'], line: string) => {
    const last = hunks[hunks.length - 1];
    if (last && last.type === type) last.lines.push(line);
    else hunks.push({ type, lines: [line] });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i]);
      i++;
    } else {
      push('add', b[j]);
      j++;
    }
  }
  while (i < a.length) {
    push('del', a[i]);
    i++;
  }
  while (j < b.length) {
    push('add', b[j]);
    j++;
  }
  return hunks;
}
