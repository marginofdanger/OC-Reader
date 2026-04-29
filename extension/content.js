(function () {
  // Try iframe first (older BamSEC layout), fall back to main document (newer layout)
  let doc;
  const iframe = document.getElementById('embedded_doc');
  if (iframe) {
    try {
      doc = iframe.contentDocument || iframe.contentWindow.document;
    } catch (e) {
      // iframe exists but is cross-origin — fall back to main document
    }
  }
  if (!doc || !doc.body) {
    // No iframe or couldn't access it — transcript is in the main page
    doc = document;
  }

  // --- Extract metadata ---
  const h1 = doc.querySelector('h1');
  const titleText = h1 ? h1.textContent.trim() : document.title;
  const titleMatch = titleText.match(/^(.+?),\s*(Q[1-4])\s+(\d{4})\s+Earnings Call/i);
  const company = titleMatch ? titleMatch[1].trim() : titleText;
  const quarter = titleMatch ? titleMatch[2] : '';
  const year = titleMatch ? titleMatch[3] : '';
  const companyLink = document.querySelector('a[href*="/companies/"]');
  const companyName = companyLink ? companyLink.textContent.trim() : company;

  // Extract event date from sidebar (e.g. "02/06/26 8:30 AM EST")
  let eventDate = '';
  const sidebarItems = document.querySelectorAll('.sidebar-item, [class*="detail"], dt, dd, span, div');
  for (const el of sidebarItems) {
    const txt = el.textContent.trim();
    if (/Event\s*Start/i.test(txt)) {
      const dateMatch = txt.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (dateMatch) eventDate = dateMatch[1];
      break;
    }
  }
  // Also try the h1 title which often contains the date for conferences
  if (!eventDate) {
    const dateInTitle = titleText.match(/,\s*(\w+ \d{1,2},?\s*\d{4})\s*$/);
    if (dateInTitle) eventDate = dateInTitle[1];
  }

  // --- Extract transcript body ---
  const allElements = doc.querySelectorAll('h2, h3, p');
  let currentSection = '';
  let currentSpeaker = '';
  const sections = { presentation: [], qa: [] };

  // Pre-filter patterns
  const BOILERPLATE = [
    /^(thank you|thanks)\s*(,\s*)?(operator|everyone|all)/i,
    /^(our|the) next question comes from/i,
    /^(please go ahead|you may begin|your line is open)/i,
    /^(ladies and gentlemen|good morning|good afternoon).*welcome/i,
    /^as a reminder.*being recorded/i,
    /forward.looking statements/i,
    /safe harbor/i,
    /^at this time.*like to turn/i,
    /^this concludes/i,
    /^(operator instructions|i would now like to turn)/i,
  ];

  function isBoilerplate(text) {
    return BOILERPLATE.some(re => re.test(text));
  }

  function isOperatorFiller(speaker, text) {
    if (!/^operator$/i.test(speaker)) return false;
    // Keep operator text only if it names the next questioner
    if (/question|comes from/i.test(text)) return true;
    return true; // all operator text is filler
  }

  for (const el of allElements) {
    const tag = el.tagName;
    const text = el.textContent.trim();

    if (tag === 'H2') {
      if (text === 'Presentation') currentSection = 'presentation';
      else if (text === 'Questions and Answers') currentSection = 'qa';
      else currentSection = '';
      continue;
    }

    if (!currentSection) continue;

    if (tag === 'H3') {
      currentSpeaker = text;
      continue;
    }

    if (tag === 'P' && text && currentSpeaker) {
      // Pre-filter: skip boilerplate and operator filler
      if (isBoilerplate(text)) continue;
      if (isOperatorFiller(currentSpeaker, text)) continue;

      const target = sections[currentSection];
      const lastBlock = target[target.length - 1];
      if (lastBlock && lastBlock.speaker === currentSpeaker) {
        lastBlock.text += '\n\n' + text;
      } else {
        target.push({ speaker: currentSpeaker, text });
      }
    }
  }

  // --- Build separate sections for parallel processing ---
  let preparedRemarks = '';
  for (const block of sections.presentation) {
    preparedRemarks += `[${block.speaker}]\n${block.text}\n\n`;
  }

  let qanda = '';
  for (const block of sections.qa) {
    qanda += `[${block.speaker}]\n${block.text}\n\n`;
  }

  // Fallback
  if (sections.presentation.length === 0 && sections.qa.length === 0) {
    preparedRemarks = doc.body.innerText;
    qanda = '';
  }

  chrome.runtime.sendMessage({
    type: 'transcript',
    data: {
      preparedRemarks,
      qanda,
      company: companyName,
      quarter,
      year,
      title: titleText,
      eventDate,
      sourceUrl: window.location.href
    }
  });
})();
