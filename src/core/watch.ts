/** Cancellable sleep shared by bounded waits and job watchers. */
export type CancelState = { cancelled: boolean; wake: (() => void) | null };
export function sleep(ms: number, state: CancelState): Promise<void> {
  return new Promise((resolve) => {
    if (state.cancelled) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      state.wake = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    state.wake = finish;
  });
}
export function isTerminal(state: string): boolean {
  return ["completed", "failed", "cancelled", "lost"].includes(state);
}
