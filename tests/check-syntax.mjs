// 语法检查：main/ 下为 CommonJS，renderer/ 与 tests/ 下为 ESM，分别用对应模式跑 node --check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collect(dir, exts) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (exts.includes(path.extname(e.name))) out.push(p);
    }
  }
  return out.sort();
}

// ESM 文件经 stdin 传入，避免 node --check 按 CJS 解析 import/export 而误报
function checkFile(file, isEsm) {
  const rel = path.relative(ROOT, file);
  const args = isEsm ? ['--input-type=module', '--check'] : ['--check', file];
  const opts = { encoding: 'utf8' };
  if (isEsm) opts.input = fs.readFileSync(file, 'utf8');
  const r = spawnSync(process.execPath, args, opts);
  if (r.status === 0) return true;
  console.error(`FAIL ${rel}`);
  console.error((r.stderr || '').trim());
  return false;
}

let total = 0;
let failed = 0;
for (const file of collect(path.join(ROOT, 'main'), ['.js'])) {
  total++;
  if (!checkFile(file, false)) failed++;
}
for (const file of collect(path.join(ROOT, 'renderer'), ['.js'])) {
  total++;
  if (!checkFile(file, true)) failed++;
}
for (const file of collect(path.join(ROOT, 'tests'), ['.mjs'])) {
  total++;
  if (!checkFile(file, true)) failed++;
}

if (failed) {
  console.error(`语法检查失败：${failed}/${total} 个文件`);
  process.exit(1);
}
console.log(`语法检查通过：${total} 个文件（main/ CJS，renderer/ + tests/ ESM）`);
