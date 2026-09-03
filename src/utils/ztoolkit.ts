// Batch Open doesn't use zotero-plugin-toolkit's UI helpers (no dialogs or
// virtualized tables), so this is a minimal stand-in rather than a full
// ZoteroToolkit instance — just enough surface for the bootstrap hooks
// (onMainWindowUnload / onShutdown) to call unregisterAll() unconditionally.

export { createZToolkit };

function createZToolkit() {
  return {
    unregisterAll(): void {
      // Nothing is registered through a toolkit helper; reserved for parity
      // with the scaffold template shape.
    },
  };
}
