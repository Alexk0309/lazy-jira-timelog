import { el } from './dom';

/** The extension's views, in tab order. Each is its own page, opened in place. */
const VIEWS = [
  { page: 'review.html', label: 'Review' },
  { page: 'tickets.html', label: 'Tickets' },
  { page: 'calendar.html', label: 'Calendar' },
  { page: 'options.html', label: 'Settings' },
] as const;

export type View = (typeof VIEWS)[number]['page'];

/** True inside the toolbar popup, which stays a popup as you switch views. */
export const isPopup = new URLSearchParams(location.search).has('popup');

function viewUrl(page: View): string {
  return isPopup ? `${page}?popup=1` : page;
}

/**
 * Settings asks the browser for site access, and that prompt closes the popup before the
 * answer arrives, so from the popup it opens in a tab (reusing one that's already open).
 */
function opensInTab(page: View): boolean {
  return isPopup && page === 'options.html';
}

/** Switches to another view in this same popup or tab. */
export function goTo(page: View): void {
  if (opensInTab(page)) {
    void chrome.runtime.openOptionsPage();
    window.close();
    return;
  }
  location.href = viewUrl(page);
}

/** Fills the page's tab bar and, in the popup, adds a button to open the current view in a tab. */
export function mountTabs(current: View): void {
  document.body.classList.toggle('popup', isPopup);
  const bar = document.getElementById('tabs');
  if (!bar) {
    return;
  }
  const links = el('div', { class: 'tabs' });
  for (const view of VIEWS) {
    const attrs: Record<string, string> = { href: viewUrl(view.page) };
    if (view.page === current) {
      attrs['aria-current'] = 'page';
    }
    if (opensInTab(view.page)) {
      attrs.title = 'Opens in a tab';
    }
    const link = el('a', attrs, view.label);
    link.addEventListener('click', (e) => {
      if (view.page === current) {
        e.preventDefault();
      } else if (opensInTab(view.page)) {
        e.preventDefault();
        goTo(view.page);
      }
    });
    links.append(link);
  }
  bar.append(links);
  if (isPopup) {
    const expand = el('button', { class: 'icon-button', id: 'expand', type: 'button', title: 'Open in a tab', 'aria-label': 'Open in a tab' });
    expand.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 14 20 4M20 14v6H4V4h6"/></svg>';
    expand.addEventListener('click', () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL(current) });
      window.close();
    });
    bar.append(expand);
  }
}
