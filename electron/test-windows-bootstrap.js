'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motomind-powershell-'));
  const script = path.join(directory, 'probe.ps1');
  await fs.writeFile(script, "param([string]$Output)\n[System.IO.File]::WriteAllText($Output, 'ready')\n");
  console.log(execFileSync('where.exe', ['powershell.exe'], { encoding: 'utf8' }));
  const fullPath = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (const item of [
    { name: 'original', command: 'powershell.exe', detached: true, windowsHide: true, pipe: false },
    { name: 'full-path', command: fullPath, detached: true, windowsHide: true, pipe: false },
    { name: 'attached-pipe', command: fullPath, detached: false, windowsHide: true, pipe: true },
    { name: 'detached-pipe', command: fullPath, detached: true, windowsHide: true, pipe: true },
    { name: 'hidden-style', command: fullPath, detached: true, windowsHide: false, pipe: false, style: true },
  ]) {
    const output = path.join(directory, `${item.name}.txt`);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...(item.style ? ['-WindowStyle', 'Hidden'] : []), '-File', script, '-Output', output];
    const child = spawn(item.command, args, { cwd: directory, detached: item.detached, windowsHide: item.windowsHide, stdio: item.pipe ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
    let stderr = '';
    child.stdout?.on('data', chunk => { stderr += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const result = await fs.readFile(output, 'utf8').catch(() => null);
    console.log(JSON.stringify({ name: item.name, code, result, stderr }));
  }
  await fs.rm(directory, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exit(1); });
