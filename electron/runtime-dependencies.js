'use strict';
const fs = require('node:fs');
const path = require('node:path');

function copyRuntimeDependencies(app) {
  // React and Motomind UI are already bundled by Vite. Stage only the main
  // process's updater dependency tree, retaining Node's hoisted/nested layout.
  const modules = path.join(__dirname, 'node_modules');
  const copied = new Set();
  function copyRuntimeDependency(name, from, optional = false) {
    let ancestor = from;
    let source;
    while (true) {
      const candidate = path.join(ancestor, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) { source = candidate; break; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (!source) {
      if (optional) return;
      throw new Error(`Missing runtime dependency ${name}`);
    }
    if (copied.has(source)) return;
    copied.add(source);
    const relative = path.relative(modules, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Runtime dependency is outside node_modules: ${name}`);
    fs.cpSync(source, path.join(app, 'node_modules', relative), { recursive: true, filter: entry => entry === source || path.basename(entry) !== 'node_modules' });
    const dependency = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    for (const child of Object.keys(dependency.dependencies || {})) copyRuntimeDependency(child, source, child in (dependency.optionalDependencies || {}));
    for (const child of Object.keys(dependency.optionalDependencies || {})) copyRuntimeDependency(child, source, true);
  }
  copyRuntimeDependency('electron-updater', __dirname);
}

module.exports = { copyRuntimeDependencies };
