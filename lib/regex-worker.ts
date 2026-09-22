import { Worker } from "node:worker_threads";
import { findRawMatches, type RawMatch } from "./text-search.js";

/**
 * Runs a pattern over a batch of texts, spending at most `limit` hits across
 * the whole batch. Returns one hit list per text, in the order given.
 */
export interface MatchExecutor {
  exec(texts: readonly string[], limit: number): Promise<RawMatch[][]>;
  dispose(): void;
}

export class PatternTooSlowError extends Error {
  constructor() {
    super("That pattern is too slow to run on this workspace.");
    this.name = "PatternTooSlowError";
  }
}

/**
 * Literal and whole-word queries are escaped before they become a pattern, and
 * an escaped literal runs in linear time, so these are safe on the main thread.
 */
export function createInProcessExecutor(source: string, flags: string): MatchExecutor {
  const pattern = new RegExp(source, flags);
  return {
    async exec(texts, limit) {
      let budget = limit;
      return texts.map((text) => {
        if (budget <= 0) return [];
        const hits = findRawMatches(text, pattern, budget);
        budget -= hits.length;
        return hits;
      });
    },
    dispose() {},
  };
}

/**
 * The worker's whole program. A string rather than a module because a plugin
 * cannot ship a second entry file: path installs load `server.ts` as
 * TypeScript, and `bb plugin build` emits one bundle. Evaluated as CommonJS, so
 * `require` is available. It must stay self-contained — nothing from the
 * enclosing module exists inside the worker.
 */
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
let pattern = null;
parentPort.on("message", (message) => {
  if (message.type === "init") {
    pattern = new RegExp(message.source, message.flags);
    return;
  }
  const out = [];
  let budget = message.limit;
  for (const text of message.texts) {
    const hits = [];
    if (budget > 0) {
      pattern.lastIndex = 0;
      for (;;) {
        const match = pattern.exec(text);
        if (match === null) break;
        if (match[0].length === 0) { pattern.lastIndex += 1; continue; }
        hits.push([match.index, match[0].length]);
        budget -= 1;
        if (budget <= 0) break;
      }
    }
    out.push(hits);
  }
  parentPort.postMessage({ id: message.id, out });
});
`;

/**
 * A user-written regex runs in a worker thread with a deadline.
 *
 * This plugin runs inside BB's own server process. A pattern that backtracks
 * catastrophically — `(a+)+$` against a long line of `a`s — would otherwise
 * block that thread for minutes and freeze all of BB with it, not just this
 * search. In a worker it can only burn its own thread, and missing the deadline
 * terminates it.
 */
export function createWorkerExecutor(
  source: string,
  flags: string,
  timeoutMs = 3000,
): MatchExecutor {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  // Never the reason the server process stays alive.
  worker.unref();
  worker.postMessage({ type: "init", source, flags });
  let nextId = 0;
  let dead = false;

  return {
    exec(texts, limit) {
      if (dead) return Promise.reject(new PatternTooSlowError());
      return new Promise<RawMatch[][]>((resolve, reject) => {
        const id = (nextId += 1);
        const cleanup = () => {
          clearTimeout(timer);
          worker.off("message", onMessage);
          worker.off("error", onError);
          worker.off("exit", onExit);
        };
        const timer = setTimeout(() => {
          cleanup();
          dead = true;
          void worker.terminate();
          reject(new PatternTooSlowError());
        }, timeoutMs);
        const onMessage = (message: { id: number; out: RawMatch[][] }) => {
          if (message.id !== id) return;
          cleanup();
          resolve(message.out);
        };
        const onError = (error: Error) => {
          cleanup();
          dead = true;
          reject(error);
        };
        const onExit = () => {
          cleanup();
          dead = true;
          reject(new PatternTooSlowError());
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.on("exit", onExit);
        worker.postMessage({ type: "exec", id, texts, limit });
      });
    },
    dispose() {
      if (dead) return;
      dead = true;
      void worker.terminate();
    },
  };
}
