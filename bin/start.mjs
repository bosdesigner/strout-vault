#!/usr/bin/env node
// `npm start`: the web app, or the worker when WORKER_MODE=1.
//
// Both Replit Repls (the website and the hourly worker) are the same repository
// with the same .replit, so the deployment "run" command is the same too. The
// worker Repl sets the secret WORKER_MODE=1 and this picks the right bundle.
// `npm run build` produces both bundles.
const worker = process.env.WORKER_MODE === "1";
await import(worker ? "../dist/worker/index.js" : "../dist/server/index.js");
