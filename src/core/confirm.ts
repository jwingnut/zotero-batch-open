// Pure helpers for the "confirm before opening a lot of tabs" volume-safety check.

/** Whether a confirmation prompt should be shown before opening `count` items. */
export function shouldConfirm(count: number, confirmAbove: number): boolean {
  return count > confirmAbove;
}

/** The exact confirmation message, naming the count and the action. */
export function confirmPromptMessage(count: number): string {
  return `Open ${count} tabs in your browser?`;
}
