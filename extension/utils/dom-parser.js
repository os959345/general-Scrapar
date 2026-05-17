// DOM utilities — XPath generation, CSS selector helpers

function generateXPath(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
  if (el === document.body) return '/html/body';

  const parts = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    let tag = current.tagName.toLowerCase();

    // Prefer id-based path — short and robust
    if (current.id) {
      parts.unshift(`//${tag}[@id="${current.id}"]`);
      break;
    }

    // Count siblings with same tag to build positional index
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }

    const hasIdenticalSiblings = current.parentElement &&
      [...current.parentElement.children].filter(c => c.tagName === current.tagName).length > 1;

    parts.unshift(hasIdenticalSiblings ? `${tag}[${index}]` : tag);
    current = current.parentElement;
  }

  // If we broke out via id, parts[0] already has '//' prefix
  if (parts[0] && parts[0].startsWith('//')) {
    return parts.join('/');
  }

  return '/' + parts.join('/');
}

function generateCSSSelector(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts = [];
  let current = el;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).slice(0, 2);
      selector += '.' + classes.map(c => CSS.escape(c)).join('.');
    }

    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.join(' > ');
}
