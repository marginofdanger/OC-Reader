// Runs in the TOP FRAME ONLY to extract metadata (title, dates, etc.)
// Results are sent back to the background script which stores them for the transcript content script.
// Also injected into ALL FRAMES as a second pass — each frame reports what it finds,
// and background script merges (preferring labeled metadata over guesses).
(function () {
  const bodyText = document.body.innerText || '';

  let title = '';
  let interviewDate = '';
  let datePublished = '';
  let expertPerspective = '';
  let analystPerspective = '';
  let primaryCompany = '';

  const h1 = document.querySelector('h1');
  if (h1) title = h1.textContent.trim();

  // === PRIMARY: DOM-based metadata extraction ===
  // Find elements whose text matches metadata labels, then get the value from nearby elements.
  // This handles CSS grid/flex layouts where innerText produces tab-separated junk.
  const labelMap = {
    'INTERVIEW DATE': 'interviewDate',
    'DATE PUBLISHED': 'datePublished',
    'EXPERT PERSPECTIVE': 'expertPerspective',
    'ANALYST PERSPECTIVE': 'analystPerspective',
    'PRIMARY COMPANY': 'primaryCompany',
  };

  // Walk all elements looking for label text
  const allEls = document.querySelectorAll('*');
  for (const el of allEls) {
    // Only check leaf-ish elements (avoid matching huge containers)
    if (el.children.length > 3) continue;
    const text = el.textContent.trim().toUpperCase();

    for (const [label, key] of Object.entries(labelMap)) {
      if (text === label || text === label.replace(/\s+/g, ' ')) {
        // Found a label element — now find its value
        let value = '';

        // Strategy 1: next sibling element
        let next = el.nextElementSibling;
        if (next) {
          value = next.textContent.trim();
        }

        // Strategy 2: if parent is a container with exactly 2 children (label + value)
        if (!value || value.toUpperCase() === text) {
          const parent = el.parentElement;
          if (parent) {
            // Check next sibling of parent (label and value might be in separate parent containers)
            const parentNext = parent.nextElementSibling;
            if (parentNext) {
              const candidate = parentNext.textContent.trim();
              if (candidate && candidate.length < 100) value = candidate;
            }
          }
        }

        // Strategy 3: for grid layouts, the value might be in the same parent but as a later child
        if (!value || value.toUpperCase() === text) {
          const parent = el.parentElement;
          if (parent) {
            const children = Array.from(parent.children);
            const idx = children.indexOf(el);
            if (idx >= 0 && idx + 1 < children.length) {
              value = children[idx + 1].textContent.trim();
            }
          }
        }

        if (value && value.toUpperCase() !== text && value.length < 100) {
          if (key === 'interviewDate') interviewDate = value;
          else if (key === 'datePublished') datePublished = value;
          else if (key === 'expertPerspective') expertPerspective = value;
          else if (key === 'analystPerspective') analystPerspective = value;
          else if (key === 'primaryCompany') primaryCompany = value;
        }
      }
    }
  }

  // === FALLBACK: Regex on innerText (works when labels and values are on adjacent lines) ===
  if (!interviewDate || !datePublished) {
    const metaPatterns = {
      interviewDate: /INTERVIEW\s*DATE[\s\t]*\n\s*(.+)/i,
      datePublished: /DATE\s*PUBLISHED[\s\t]*\n\s*(.+)/i,
      expertPerspective: /EXPERT\s*PERSPECTIVE[\s\t]*\n\s*(.+)/i,
      analystPerspective: /ANALYST\s*PERSPECTIVE[\s\t]*\n\s*(.+)/i,
      primaryCompany: /PRIMARY\s*COMPANY[\s\t]*\n\s*(.+)/i,
    };

    for (const [key, pattern] of Object.entries(metaPatterns)) {
      // Skip fields we already found via DOM
      if (key === 'interviewDate' && interviewDate) continue;
      if (key === 'datePublished' && datePublished) continue;
      if (key === 'expertPerspective' && expertPerspective) continue;
      if (key === 'analystPerspective' && analystPerspective) continue;
      if (key === 'primaryCompany' && primaryCompany) continue;

      const match = bodyText.match(pattern);
      if (match) {
        let val = match[1].trim().split(/[\t\n]/)[0].trim();
        if (key === 'interviewDate') interviewDate = val;
        else if (key === 'datePublished') datePublished = val;
        else if (key === 'expertPerspective') expertPerspective = val;
        else if (key === 'analystPerspective') analystPerspective = val;
        else if (key === 'primaryCompany') primaryCompany = val;
      }
    }
  }

  // === LAST RESORT: AlphaSense header bar "DD MON YY  N PAGES" ===
  if (!interviewDate && !datePublished) {
    const pagesMatch = bodyText.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{2,4})\s+\d+\s+PAGES?/i);
    if (pagesMatch) datePublished = pagesMatch[1];
  }

  // === AlphaSights: date from selected sidebar card ===
  if (!interviewDate && !datePublished) {
    const activeItems = document.querySelectorAll('[class*="active"], [class*="selected"], [aria-selected="true"], [aria-current="true"], [class*="highlight"], [class*="focused"], [class*="current"]');
    for (const item of activeItems) {
      const dateMatch = item.textContent.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4})/i);
      if (dateMatch) { interviewDate = dateMatch[1]; break; }
    }
  }

  // Normalize 2-digit years (e.g. "13 Mar 25" → "13 Mar 2025")
  if (interviewDate) {
    interviewDate = interviewDate.replace(/(\d{1,2}\s+\w+\s+)(\d{2})$/, (m, p, y) => p + (parseInt(y) > 50 ? '19' : '20') + y);
  }
  if (datePublished) {
    datePublished = datePublished.replace(/(\d{1,2}\s+\w+\s+)(\d{2})$/, (m, p, y) => p + (parseInt(y) > 50 ? '19' : '20') + y);
  }

  chrome.runtime.sendMessage({
    type: 'expert-metadata',
    data: { title, interviewDate, datePublished, expertPerspective, analystPerspective, primaryCompany }
  });
})();
