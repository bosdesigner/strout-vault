#!/usr/bin/env node
// `npm start`: what the deployment runs. Three modes, chosen by secrets:
//
//   RUN_WORKER=1   (the one-app setup, a Replit Reserved VM): the website, plus the worker run as two
//                  supervised child processes: the full pipeline every WORKER_EVERY_MIN (60) minutes
//                  and the light steps (gmail, link, classify, embed) every WORKER_LIGHT_EVERY_MIN (5).
//                  The database locks keep runs from overlapping: the full run takes the main worker
//                  lock, the light run its own, and link / classify / embed / gmail each lock themselves.
//                  A child that exits is restarted after a minute; the website never waits on it.
//   WORKER_MODE=1  (the old two-Repl setup): one worker run, then exit (a Scheduled deployment).
//   neither        the website only.
//
// `npm run build` produces both bundles.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const dist = (p) => fileURLToPath(new URL(`../dist/${p}`, import.meta.url));

if (process.env.WORKER_MODE === "1") {
  await import("../dist/worker/index.js");
} else {
  await import("../dist/server/index.js");
  if (process.env.RUN_WORKER === "1") superviseWorkers();
}

function superviseWorkers() {
  const every = Math.max(5, Number(process.env.WORKER_EVERY_MIN) || 60);
  const lightEvery = Number(process.env.WORKER_LIGHT_EVERY_MIN ?? 5);
  const children = new Set();
  let stopping = false;

  const run = (name, args) => {
    // The worker reads WORKER_STEPS when no --steps is given: never let one loop inherit the other's.
    const env = { ...process.env, WORKER_MODE: "1" };
    delete env.WORKER_STEPS;
    const child = spawn(process.execPath, [dist("worker/index.js"), ...args], { stdio: "inherit", env });
    children.add(child);
    console.log(`[start] ${name} worker loop started (pid ${child.pid}): ${args.join(" ")}`);
    child.on("exit", (code, signal) => {
      children.delete(child);
      if (stopping) return;
      console.error(`[start] ${name} worker loop exited (${signal ?? code}); restarting in 60 s`);
      setTimeout(() => !stopping && run(name, args), 60_000).unref();
    });
  };

  run("full", ["--loop", String(every)]);
  if (lightEvery > 0) run("light", ["--steps", "gmail,link,classify,embed", "--loop", String(Math.max(1, lightEvery))]);

  const stop = () => {
    stopping = true;
    for (const c of children) c.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
