// Agent 操作手册：静态正文 + 按工具目录实时生成的索引，索引不会与实际工具脱节。不依赖 electron。
const fs = require('fs');
const path = require('path');
const { TOOLS } = require('./catalog');

const GROUP_ORDER = ['agent', 'changes', 'review', 'file', 'checklist', 'fix', 'rules', 'chat', 'fileAnalysis', 'ai', 'git', 'plan',
  'settings', 'preset', 'app', 'recent', 'watch', 'icon', 'dialog', 'update'];

function toolIndex() {
  /** @param {string} name */
  const rank = (name) => {
    const index = GROUP_ORDER.indexOf(name.split('_')[0]);
    return index < 0 ? GROUP_ORDER.length : index;
  };
  const rows = TOOLS.map((tool, i) => ({ tool, i })).sort((a, b) => rank(a.tool.name) - rank(b.tool.name) || a.i - b.i).map(({ tool }) => {
    const required = (tool.required || []).join(', ') || '—';
    return `| \`${tool.name}\`${tool.long ? ' ⏱' : ''} | ${tool.description.replace(/\|/g, '\\|')} | ${required} |`;
  });
  return [
    '## A9. 工具索引',
    '',
    `共 ${TOOLS.length} 个工具。⏱ 表示长任务，支持 \`waitSec\`。完整参数见 \`tools/list\` 或 \`GET /v1/tools\` 返回的 \`inputSchema\`。`,
    '',
    '| 工具 | 说明 | 必填参数 |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function readGuide() {
  const body = fs.readFileSync(path.join(__dirname, 'AGENT_GUIDE.md'), 'utf8');
  return `${body.trimEnd()}\n\n${toolIndex()}\n`;
}

module.exports = { readGuide };
