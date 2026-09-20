const DRAWER_IDS = [
  'settings-drawer',
  'media-drawer',
  'agent-drawer',
  'admin-drawer',
  'history-drawer',
  'share-list-drawer',
  'snapshot-drawer',
] as const;

export function closeDrawers(except?: string): void {
  for (const id of DRAWER_IDS) {
    if (id === except) continue;
    document.getElementById(id)?.classList.remove('open');
  }
}

/** Close other drawers, then open this one. If it is already open, leave it closed. */
export function openExclusive(id: string, open: () => void): void {
  const already = document.getElementById(id)?.classList.contains('open');
  closeDrawers();
  if (!already) open();
}
