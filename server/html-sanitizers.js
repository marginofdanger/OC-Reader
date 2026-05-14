function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseMarkdownTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed.slice(1, -1).split('|').map(cell => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableDivider(line) {
  const cells = parseMarkdownTableRow(line);
  return !!cells && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function renderInlineMarkdown(value) {
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdownTable(headers, rows) {
  const head = headers.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('');
  const body = rows.map(row => {
    const cells = headers.map((_, index) => `<td>${renderInlineMarkdown(row[index] || '')}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function sanitizeLeakedMarkdownTables(html) {
  const lines = String(html || '').split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const headers = parseMarkdownTableRow(lines[i]);
    if (!headers || i + 1 >= lines.length || !isMarkdownTableDivider(lines[i + 1])) {
      out.push(lines[i]);
      continue;
    }

    const rows = [];
    let j = i + 2;
    while (j < lines.length) {
      const row = parseMarkdownTableRow(lines[j]);
      if (!row) break;
      rows.push(row);
      j++;
    }

    if (!rows.length) {
      out.push(lines[i]);
      continue;
    }

    out.push(renderMarkdownTable(headers, rows));
    i = j - 1;
  }

  return out.join('\n');
}

module.exports = {
  sanitizeLeakedMarkdownTables,
};
