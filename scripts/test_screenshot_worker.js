const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ScreenshotWorker } = require('../out/screenshotWorker');
const { makeTmpDir } = require('./test-tmp');

const tmp = makeTmpDir('capture-worker');
const script = path.join(tmp, 'worker.js');
fs.writeFileSync(script, `
const fs = require('fs');
const path = require('path');
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const r = JSON.parse(line);
  if (r.output_path === 'hang') return;
  if (r.output_path === 'exit') return process.exit(7);
  if (r.output_path === 'restart' && !fs.existsSync(path.join(r.project_dir, 'restarted'))) {
    fs.writeFileSync(path.join(r.project_dir, 'restarted'), '1');
    console.log(JSON.stringify({ capture_response: r.id, restart: true }));
    return process.exit(0);
  }
  for (let i = 0; i < 1000; i++) process.stderr.write('log\\n');
  console.log('framework output');
  setTimeout(() => console.log(JSON.stringify({ capture_response: r.id, ok: r.output_path !== 'error', error: 'capture failed' })), 10);
});
`);

(async () => {
  const logs = [];
  const worker = new ScreenshotWorker(process.execPath, script, tmp, line => logs.push(line), 2000);
  try {
    await Promise.all([worker.capture('one', {}, 'auto'), worker.capture('two', {}, 'bitblt')]);
    assert.strictEqual(logs.filter(line => line.includes('worker_started')).length, 1);
    await assert.rejects(worker.capture('error', {}, 'auto'), /capture failed/);
    await worker.capture('restart', {}, 'auto');
    assert.strictEqual(logs.filter(line => line.includes('worker_started')).length, 2);
    await assert.rejects(worker.capture('exit', {}, 'auto'), /exited/);
    await worker.capture('after-exit', {}, 'auto');
    assert.strictEqual(logs.filter(line => line.includes('worker_started')).length, 3);
  } finally { worker.dispose(); }
  await assert.rejects(worker.capture('disposed', {}, 'auto'), /disposed/);

  const hung = new ScreenshotWorker(process.execPath, script, tmp, () => {}, 200);
  try {
    const started = Date.now();
    await assert.rejects(hung.capture('hang', {}, 'auto'), /timed out/);
    assert(Date.now() - started < 2500);
    await hung.capture('recovered', {}, 'auto');
  } finally { hung.dispose(); }

  const idleLogs = [];
  const idle = new ScreenshotWorker(process.execPath, script, tmp, line => idleLogs.push(line), 2000, 50);
  try {
    await idle.capture('first', {}, 'auto');
    await new Promise(resolve => setTimeout(resolve, 150));
    await idle.capture('second', {}, 'auto');
    assert.strictEqual(idleLogs.filter(line => line.includes('worker_started')).length, 2);
  } finally { idle.dispose(); }
  console.log('test_screenshot_worker: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
