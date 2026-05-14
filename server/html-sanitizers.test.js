const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLeakedMarkdownTables } = require('./html-sanitizers');

test('sanitizeLeakedMarkdownTables converts a leaked markdown table into an HTML table', () => {
  const html = [
    '<div class="qa-block">',
    '<h3>Question?</h3>',
    '| Metric | Current | Benchmark |',
    '|---|---|---|',
    '| Mobile pen | **~20%+** | Headroom |',
    '<ul><li><strong>Mechanic:</strong> converts additional lines.</li></ul>',
    '</div>',
  ].join('\n');

  const sanitized = sanitizeLeakedMarkdownTables(html);

  assert.ok(sanitized.includes('<table>'));
  assert.ok(sanitized.includes('<th>Metric</th>'));
  assert.ok(sanitized.includes('<td><strong>~20%+</strong></td>'));
  assert.ok(!sanitized.includes('|---|---|---|'));
});
