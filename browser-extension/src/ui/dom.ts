type Child = Node | string;

/** Tiny element builder. Text is always set as text, never parsed as HTML. */
export function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'value' && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      node.value = value;
    } else {
      node.setAttribute(name, value);
    }
  }
  for (const child of children) {
    if (child !== '') {
      node.append(child);
    }
  }
  return node;
}

let toastTimer = 0;

/** A short, self-dismissing confirmation at the bottom of the page. */
export function toast(message: string): void {
  const node = document.getElementById('toast');
  if (!node) {
    return;
  }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (node.hidden = true), 2400);
}
