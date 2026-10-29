/**
 * Concurrency limiter (brief section 8.4): at most `n` tasks run at once, the
 * rest wait in a queue. Every finished task, settled either way, starts the
 * next queued one, so the number in flight stays at `n` until the queue
 * drains. No dependency, no timers.
 */

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function pLimit(n: number): Limiter {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`pLimit: concurrency must be a positive integer, got ${String(n)}`);
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    active -= 1;
    const run = queue.shift();
    if (run) run();
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        // `task` may throw synchronously; treat that like a rejection so the
        // slot is always released.
        Promise.resolve().then(task).then(resolve, reject).finally(next);
      };
      if (active < n) run();
      else queue.push(run);
    });
}
