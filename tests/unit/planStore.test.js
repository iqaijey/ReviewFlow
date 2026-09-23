const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-planstore-'));

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => tmpDir } };
  }
  return originalLoad.call(this, request, ...rest);
};

const planStore = require('../../main/planStore');

after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const FOLDER = '/repo/demo';

test('createPlan 创建方案并可列出', () => {
  const meta = planStore.createPlan({
    folder: FOLDER,
    title: '方案A',
    prdFileName: 'prd.md',
    prdText: '这是 PRD 内容',
  });
  assert.ok(meta.id);
  assert.strictEqual(meta.title, '方案A');
  assert.strictEqual(meta.prdFileName, 'prd.md');
  assert.strictEqual(meta.hasPlan, false);
  assert.deepStrictEqual(meta.images, []);

  const list = planStore.listPlans(FOLDER);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, meta.id);
  assert.strictEqual(list[0].title, '方案A');
  assert.strictEqual(list[0].imageCount, 0);
  assert.strictEqual(list[0].hasPlan, false);
  assert.strictEqual(list[0].active, false);
  assert.strictEqual(list[0].prdExcerpt, '这是 PRD 内容');
});

test('createPlan 空标题回退为「未命名方案」', () => {
  const meta = planStore.createPlan({ folder: FOLDER, title: '  ', prdText: '' });
  assert.strictEqual(meta.title, '未命名方案');
  planStore.deletePlan(FOLDER, meta.id);
});

test('空 folder 报错', () => {
  for (const bad of ['', null, undefined, '   ', 123]) {
    assert.throws(() => planStore.createPlan({ folder: bad }), /缺少项目路径/);
    assert.throws(() => planStore.listPlans(bad), /缺少项目路径/);
  }
});

test('addPlanImage / getPlanDetail / removePlanImage', () => {
  const meta = planStore.createPlan({ folder: FOLDER, title: '图片方案', prdText: 'x' });
  const { name } = planStore.addPlanImage({
    folder: FOLDER,
    planId: meta.id,
    name: 'shot.png',
    base64: 'data:image/png;base64,aGVsbG8=',
  });
  assert.strictEqual(name, 'shot.png');

  const detail = planStore.getPlanDetail(FOLDER, meta.id);
  assert.strictEqual(detail.images.length, 1);
  assert.strictEqual(detail.images[0].name, 'shot.png');
  assert.strictEqual(detail.images[0].dataUrl, 'data:image/png;base64,aGVsbG8=');
  assert.strictEqual(detail.prdText, 'x');

  planStore.removePlanImage({ folder: FOLDER, planId: meta.id, name: 'shot.png' });
  const after1 = planStore.getPlanDetail(FOLDER, meta.id);
  assert.strictEqual(after1.images.length, 0);

  planStore.deletePlan(FOLDER, meta.id);
});

test('addPlanImage 方案不存在或图片为空时报错', () => {
  assert.throws(
    () => planStore.addPlanImage({ folder: FOLDER, planId: 'nope', name: 'a.png', base64: 'eA==' }),
    /方案不存在/,
  );
  const meta = planStore.createPlan({ folder: FOLDER, title: 't', prdText: '' });
  assert.throws(
    () => planStore.addPlanImage({ folder: FOLDER, planId: meta.id, name: 'a.png', base64: '' }),
    /图片数据为空/,
  );
  planStore.deletePlan(FOLDER, meta.id);
});

test('图片文件名路径穿越清洗', () => {
  const meta = planStore.createPlan({ folder: FOLDER, title: 't', prdText: '' });

  const r1 = planStore.addPlanImage({ folder: FOLDER, planId: meta.id, name: '../../evil.png', base64: 'eA==' });
  assert.strictEqual(r1.name, 'evil.png');

  const r2 = planStore.addPlanImage({ folder: FOLDER, planId: meta.id, name: '', base64: 'eA==' });
  assert.strictEqual(r2.name, 'image.png');

  const r3 = planStore.addPlanImage({ folder: FOLDER, planId: meta.id, name: '..', base64: 'eA==' });
  assert.strictEqual(r3.name, 'image.png');

  // 文件必须落在方案 images 目录内，不能写到 plans 根目录或更外层
  assert.strictEqual(fs.existsSync(path.join(tmpDir, 'evil.png')), false);
  assert.strictEqual(fs.existsSync(path.join(tmpDir, 'plans', 'evil.png')), false);
  const detail = planStore.getPlanDetail(FOLDER, meta.id);
  assert.deepStrictEqual(
    detail.images.map((i) => i.name).sort(),
    ['evil.png', 'image.png'],
  );

  planStore.deletePlan(FOLDER, meta.id);
});

test('planId 路径穿越清洗：不会访问其他目录', () => {
  const meta = planStore.createPlan({ folder: FOLDER, title: 't', prdText: '' });
  // basename 清洗后落到不存在的目录，应返回 null 而不是抛错或越界
  assert.strictEqual(planStore.getPlanDetail(FOLDER, '../..'), null);
  // '../<id>' 被 basename 清洗为同目录下的合法 id，不会越出 folderDir
  assert.strictEqual(planStore.getPlanDetail(FOLDER, `../${meta.id}`).id, meta.id);
  planStore.deletePlan(FOLDER, meta.id);
});

test('setActivePlan / getActivePlan / getPlanDetail.active', () => {
  const a = planStore.createPlan({ folder: FOLDER, title: 'A', prdText: 'pa' });
  const b = planStore.createPlan({ folder: FOLDER, title: 'B', prdText: 'pb' });

  planStore.setActivePlan(FOLDER, a.id);
  const active = planStore.getActivePlan(FOLDER);
  assert.strictEqual(active.id, a.id);
  assert.strictEqual(active.title, 'A');
  assert.strictEqual(active.prdText, 'pa');
  assert.strictEqual(planStore.getPlanDetail(FOLDER, a.id).active, true);
  assert.strictEqual(planStore.getPlanDetail(FOLDER, b.id).active, false);

  const list = planStore.listPlans(FOLDER);
  assert.strictEqual(list.find((p) => p.id === a.id).active, true);

  planStore.setActivePlan(FOLDER, null);
  assert.strictEqual(planStore.getActivePlan(FOLDER), null);

  assert.throws(() => planStore.setActivePlan(FOLDER, 'not-exist'), /方案不存在/);

  planStore.deletePlan(FOLDER, a.id);
  planStore.deletePlan(FOLDER, b.id);
});

test('deletePlan 删除启用的方案时同时清除 active', () => {
  const meta = planStore.createPlan({ folder: FOLDER, title: 'D', prdText: '' });
  planStore.setActivePlan(FOLDER, meta.id);
  planStore.deletePlan(FOLDER, meta.id);
  assert.strictEqual(planStore.getActivePlan(FOLDER), null);
  assert.strictEqual(planStore.getPlanDetail(FOLDER, meta.id), null);
});

test('savePlanResult 写入 plan.md 并标记 hasPlan', () => {
  const meta = planStore.createPlan({ folder: FOLDER, title: 'R', prdText: '' });
  planStore.savePlanResult({ folder: FOLDER, planId: meta.id, markdown: '# 实施方案' });
  const detail = planStore.getPlanDetail(FOLDER, meta.id);
  assert.strictEqual(detail.planMarkdown, '# 实施方案');
  assert.strictEqual(planStore.listPlans(FOLDER).find((p) => p.id === meta.id).hasPlan, true);
  assert.throws(
    () => planStore.savePlanResult({ folder: FOLDER, planId: 'nope', markdown: 'x' }),
    /方案不存在/,
  );
  planStore.deletePlan(FOLDER, meta.id);
});

test('超过 10 个方案时淘汰最旧的', () => {
  const folder = '/repo/evict';
  const realNow = Date.now;
  let tick = 1_700_000_000_000;
  Date.now = () => ++tick;
  try {
    const ids = [];
    for (let i = 0; i < 11; i++) {
      ids.push(planStore.createPlan({ folder, title: `P${i}`, prdText: '' }).id);
    }
    const list = planStore.listPlans(folder);
    assert.strictEqual(list.length, 10);
    const remaining = new Set(list.map((p) => p.id));
    assert.strictEqual(remaining.has(ids[0]), false); // 最旧的被淘汰
    for (const id of ids.slice(1)) assert.ok(remaining.has(id));
    // 按 createdAt 倒序
    assert.strictEqual(list[0].id, ids[10]);
  } finally {
    Date.now = realNow;
  }
});

test('不同 folder 的方案互相隔离', () => {
  const meta = planStore.createPlan({ folder: '/repo/other', title: 'O', prdText: '' });
  assert.strictEqual(planStore.listPlans('/repo/other').length, 1);
  assert.strictEqual(planStore.getPlanDetail('/repo/demo', meta.id), null);
  planStore.deletePlan('/repo/other', meta.id);
});
