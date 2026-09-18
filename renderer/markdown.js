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
