function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text) {
  // 输入已是 HTML 转义后的文本
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// 导出 HTML 用的内嵌深色样式
const EXPORT_CSS =
  'body{margin:40px auto;max-width:860px;padding:0 16px;background:#1e1e1e;' +
  'color:#d4d4d4;font:14px/1.7 -apple-system,"PingFang SC","Helvetica Neue",sans-serif}' +
  'h1,h2,h3{color:#fff;line-height:1.4}' +
  'a{color:#4ec9b0}' +
  'blockquote{margin:0;padding:0 12px;border-left:3px solid #444;color:#9d9d9d}' +
  'pre{background:#1b1b1b;border:1px solid #333;border-radius:6px;padding:10px 12px;' +
  'overflow-x:auto}' +
  'code{font-family:Menlo,Consolas,monospace;font-size:12.5px;background:#2d2d2d;' +
  'border-radius:4px;padding:2px 5px}' +
  'pre code{background:none;padding:0}' +
  'h1{font-size:20px;border-bottom:1px solid #333;padding-bottom:8px}';

// 完整可独立打开的 HTML 文档：doctype + meta charset + 内嵌深色 CSS + 标题 + 正文
export function renderMarkdownPage(title, mdText) {
  const body = renderMarkdown(mdText);
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(String(title ?? ''))}</title>\n` +
    `<style>${EXPORT_CSS}</style>\n</head>\n<body>\n` +
    `<h1>${escapeHtml(String(title ?? ''))}</h1>\n` +
    `${body}\n</body>\n</html>\n`;
}

export function renderMarkdown(mdText) {
  const src = escapeHtml(String(mdText ?? ''));
  const lines = src.split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (line.trimStart().startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结尾 ```
      html.push('<pre><code>' + buf.join('\n') + '</code></pre>');
      continue;
    }

    // 标题
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { html.push('<h3>' + renderInline(h3[1]) + '</h3>'); i++; continue; }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) { html.push('<h2>' + renderInline(h2[1]) + '</h2>'); i++; continue; }

    // 引用（连续 > 行合并为一个 blockquote）
    if (/^&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^&gt;\s?/, ''));
        i++;
      }
      html.push('<blockquote>' + buf.map(renderInline).join('<br>') + '</blockquote>');
      continue;
    }

    // 无序列表
    if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ''));
        i++;
      }
      html.push('<ul>' + items.map((t) => '<li>' + renderInline(t) + '</li>').join('') + '</ul>');
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      html.push('<ol>' + items.map((t) => '<li>' + renderInline(t) + '</li>').join('') + '</ol>');
      continue;
    }

    // 空行
    if (line.trim() === '') { i++; continue; }

    // 段落（合并连续普通行）
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !/^#{2,3}\s/.test(lines[i]) &&
      !/^&gt;\s?/.test(lines[i]) &&
      !/^\s*-\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    html.push('<p>' + buf.map(renderInline).join('<br>') + '</p>');
  }

  return html.join('\n');
}
