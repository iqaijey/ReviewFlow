const fs = require('fs');
const path = require('path');

const STATUS_LABELS = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
};

function hunkToDiffText(hunk) {
  const prefix = { add: '+', del: '-', context: ' ' };
  const body = hunk.lines.map((l) => `${prefix[l.type] || ' '}${l.content}`).join('\n');
  return `${hunk.header}\n${body}`;
}

function fileToDiffText(file) {
  const status = STATUS_LABELS[file.status] || file.status;
  const hunks = (file.hunks || []).map(hunkToDiffText).join('\n');
  return `文件: ${file.path} (${status})\n${hunks}`;
}

const CONTEXT_BLOCK_MAX_LINES = 200;
const CONTEXT_MAX_CHARS = 4000;

// 读取被改动的类/函数在当前文件中的完整定义，作为评审上下文（diff 只含改动片段）。
// 文件被删除、不存在或读取失败时返回空串。
function buildContext(folder, file) {
  if (!folder || !file || !file.path || file.status === 'deleted') return '';
  const targets = (Array.isArray(file.classes) ? file.classes : [])
    .filter((c) => c && c.changed && c.startLine > 0 && c.endLine >= c.startLine);
  if (!targets.length) return '';
  let lines;
  try {
    lines = fs.readFileSync(path.join(folder, file.path), 'utf8').split('\n');
  } catch {
    return '';
  }
  const blocks = [];
  for (const c of targets) {
    const end = Math.min(c.endLine, lines.length);
    const start = Math.min(c.startLine, end);
    let slice = lines.slice(start - 1, end);
    let note = '';
    if (slice.length > CONTEXT_BLOCK_MAX_LINES) {
      slice = slice.slice(0, CONTEXT_BLOCK_MAX_LINES);
      note = '\n（定义过长已截断）';
    }
    blocks.push(
      `### ${c.name}（${file.path}:${c.startLine}-${c.endLine}）\n` +
      `\`\`\`\n${slice.join('\n')}${note}\n\`\`\`\n`,
    );
  }
  let out = blocks.join('\n');
  if (out.length > CONTEXT_MAX_CHARS) {
    out = `${out.slice(0, CONTEXT_MAX_CHARS)}\n（上下文过长已截断）`;
  }
  return out;
}

// diff 文本 + 被改动类/函数的完整定义上下文（整体分析分批与逐文件评审共用）
function fileToPromptText(folder, file) {
  let text = fileToDiffText(file);
  const context = buildContext(folder, file);
  if (context) {
    text += `\n\n以下是被改动的类/函数的完整定义（供分析上下文）：\n\n${context}`;
  }
  return text;
}

// 固定 9 个评审维度 + 可选自定义维度（customDimensions 每行一个，最多 8 个，插在「可复用性」与「总结与建议」之间）；
// hasPlan 为 true 时再追加「需求符合度」一节，对照需求方案/PRD 评审
function overviewSectionsText(cfg, hasPlan = false) {
  const dims = (cfg && typeof cfg.customDimensions === 'string' ? cfg.customDimensions : '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  const extra = dims.length ? ` / ${dims.map((d) => `## ${d}`).join(' / ')}` : '';
  const plan = hasPlan ? ' / ## 需求符合度' : '';
  return '严格使用以下二级标题分节：' +
    '## 改动概述 / ## 安全性 / ## 结构问题 / ## 影响面 / ## 逻辑严谨性 / ## 臃肿与冗余 / ## 可扩展性 / ## 可复用性' +
    `${extra}${plan} / ## 总结与建议。` +
    '每节给出具体、可执行的发现，无问题的小节明确说『未发现问题』，引用具体文件和行号。' +
    (hasPlan ? '「需求符合度」一节须对照需求方案/PRD：检查改动是否实现了方案要求的功能点、有无遗漏、有无超出方案范围的实现。' : '');
}

function buildOverviewSystem(cfg, hasPlan = false) {
  return `你是一位资深代码评审专家，请用中文、markdown 格式输出，${overviewSectionsText(cfg, hasPlan)}`;
}

const FULL_EXPLAIN_SYSTEM =
  '你是一位资深工程师，正在给同事完整讲解一批代码改动。请用中文、markdown 格式输出。' +
  '按文件逐个讲解：每个文件用三级标题（### 文件路径），其下逐改动块详细解释：' +
  '改了什么、从上下文推断的改动意图、改动前后的行为差异、与周边代码的关系、阅读时需要注意的细节。' +
  '尽可能详细、讲透，可以引用代码片段，不要遗漏任何一处改动，不要做笼统概括。';

const PLAN_SYSTEM =
  '你是一位资深技术专家，正在根据需求文档（PRD）与设计稿为项目制定技术实现方案。请用中文、markdown 格式输出，严格使用以下二级标题分节：' +
  '## 需求理解 / ## 功能点拆解 / ## 模块与类设计 / ## 关键文件与改动点预估 / ## 数据流 / ## 风险点 / ## 验收标准。' +
  '方案要具体、可落地：结合项目实际技术栈与目录结构推断涉及的关键文件，引用具体模块/类/文件名，不要泛泛而谈。';

// 按累计长度分批：每批 ≤10000 字符（含上下文），文件不拆半，单文件超限则单独成批并截断；最多 6 批
function splitIntoBatches(folder, files) {
  const BATCH_LIMIT = 10000;
  const MAX_BATCHES = 6;
  const batches = [];
  let current = [];
  let currentLen = 0;
  let reviewed = 0;
  for (const file of files) {
    const text = fileToPromptText(folder, file);
    if (text.length > BATCH_LIMIT) {
      if (current.length) {
        batches.push(current);
        current = [];
        currentLen = 0;
      }
      if (batches.length >= MAX_BATCHES) break;
      batches.push([`${text.slice(0, BATCH_LIMIT)}\n(diff 过长已截断)`]);
      reviewed += 1;
      continue;
    }
    if (current.length && currentLen + text.length > BATCH_LIMIT) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    if (batches.length >= MAX_BATCHES) break;
    current.push(text);
    currentLen += text.length;
    reviewed += 1;
  }
  if (current.length && batches.length < MAX_BATCHES) batches.push(current);
  return { batches, reviewed };
}

// 构造逐句解析的改动上下文：多段框选（含各段文件路径）或单行 hunk 块，
// explainChange 与 explainFollowUp 共用
function buildExplainContext({ filePath, hunk, line, segments }) {
  if (Array.isArray(segments) && segments.length) {
    const blocks = segments.map((seg) => {
      const selected = new Set(seg.lines);
      const body = (seg.hunk.lines || [])
        .map((l) => {
          const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          const no = l.newLine != null ? l.newLine : (l.oldLine != null ? l.oldLine : '?');
          const marker = selected.has(l) ? '>' : ' ';
          return `${marker}${prefix}${no} ${l.content}`;
        })
        .join('\n');
      const fileLabel = seg.filePath || filePath;
      return `文件: ${fileLabel}\n代码块: ${seg.hunk.header}\n${body}`;
    }).join('\n\n');
    return {
      multi: true,
      context: `以下是从 diff 中框选的多条改动（+ 新增 / - 删除，数字为行号，> 标出被询问的行，可能来自多个文件）：\n${blocks}`,
    };
  }
  if (!hunk || !line) throw new Error('缺少要解释的改动行');
  const hunkLines = (hunk.lines || [])
    .map((l) => {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      const no = l.newLine != null ? l.newLine : (l.oldLine != null ? l.oldLine : '?');
      const marker = l === line ? '>' : ' ';
      return `${marker}${prefix}${no} ${l.content}`;
    })
    .join('\n');
  return {
    multi: false,
    context:
      `文件: ${filePath}\n` +
      `代码块: ${hunk.header}\n\n` +
      `该代码块的全部改动（+ 新增 / - 删除，数字为行号，> 标出的是被询问的那一行）：\n${hunkLines}`,
  };
}

function withCustomPrompt(system, cfg) {
  const extra = cfg && typeof cfg.customPrompt === 'string' ? cfg.customPrompt.trim() : '';
  return extra ? `${system}\n额外评审要求（必须遵守）：${extra}` : system;
}

// 一次性自定义要求重跑：非空时替代设置里的 customPrompt（不写回设置）
function applyPromptOverride(cfg, customPromptOverride) {
  const override = typeof customPromptOverride === 'string' ? customPromptOverride.trim() : '';
  return override ? { ...cfg, customPrompt: override } : cfg;
}

module.exports = {
  fileToPromptText,
  overviewSectionsText,
  buildOverviewSystem,
  FULL_EXPLAIN_SYSTEM,
  PLAN_SYSTEM,
  splitIntoBatches,
  buildExplainContext,
  withCustomPrompt,
  applyPromptOverride,
};
