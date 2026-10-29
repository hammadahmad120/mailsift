import { describe, expect, it } from 'vitest';
import { pLimit } from '../src/util/concurrency.js';

/** A task whose completion the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks run so the limiter can start the next task. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('pLimit', () => {
  it('rejects a limit that is not a positive integer', () => {
    expect(() => pLimit(0)).toThrow(RangeError);
    expect(() => pLimit(-1)).toThrow(RangeError);
    expect(() => pLimit(1.5)).toThrow(RangeError);
    expect(() => pLimit(Number.NaN)).toThrow(RangeError);
  });

  it('never runs more than n tasks at once and keeps n in flight until the queue drains', async () => {
    const limit = pLimit(3);
    const gates = Array.from({ length: 10 }, () => deferred<void>());
    let active = 0;
    let peak = 0;
    const started: number[] = [];

    const results = gates.map((gate, i) =>
      limit(async () => {
        active += 1;
        started.push(i);
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return i;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1, 2]);
    expect(active).toBe(3);

    // Finish one out of order: exactly one more starts, the slot refills alone.
    gates[1]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(active).toBe(3);

    gates[0]!.resolve();
    gates[2]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(active).toBe(3);

    // Drain the rest in arbitrary order.
    for (const i of [5, 3, 7, 4, 9, 6, 8]) {
      gates[i]!.resolve();
      await tick();
      expect(active).toBeLessThanOrEqual(3);
    }

    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it('returns results in call order regardless of finish order', async () => {
    const limit = pLimit(2);
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const results = Promise.all(gates.map((g) => limit(() => g.promise)));
    gates[2]!.resolve('c');
    gates[0]!.resolve('a');
    gates[1]!.resolve('b');
    expect(await results).toEqual(['a', 'b', 'c']);
  });

  it('a failing task rejects only its own promise and frees its slot', async () => {
    const limit = pLimit(1);
    const failing = limit(() => Promise.reject(new Error('boom')));
    const throwing = limit(() => {
      throw new Error('sync boom');
    });
    const ok = limit(() => Promise.resolve('fine'));

    await expect(failing).rejects.toThrow('boom');
    await expect(throwing).rejects.toThrow('sync boom');
    expect(await ok).toBe('fine');
  });

  it('with n = 1 tasks run strictly one after another', async () => {
    const limit = pLimit(1);
    const order: string[] = [];
    await Promise.all([
      limit(async () => {
        order.push('a start');
        await tick();
        order.push('a end');
      }),
      limit(() => {
        order.push('b start');
        order.push('b end');
        return Promise.resolve();
      }),
    ]);
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end']);
  });
});
