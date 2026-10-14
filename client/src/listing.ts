// The file list a tab was last showing: its folder and any search, as the query of the home page's
// address. An open file's links back to the list use it, so going back shows the same search results.
const KEY = 'ui.lastListing';

export function rememberListing(search: string): void {
  try {
    sessionStorage.setItem(KEY, search);
  } catch {
    // Not remembered, that's all.
  }
}

function last(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** The desktop app's Recents list, when that is the list last shown. */
export const RECENTS_PARAM = 'recents';
export const RECENTS_HREF = `/?${RECENTS_PARAM}=1`;
export const rememberRecents = (): void => rememberListing(`?${RECENTS_PARAM}=1`);
/** Whether the file being shown was opened from Recents: its breadcrumbs then start there. */
export const fromRecents = (): boolean => new URLSearchParams(last()).get(RECENTS_PARAM) === '1';

/** The list as it was last shown. */
export const lastListingHref = (): string => `/${last()}`;

/** The list showing a folder ('' or absent is the top), with the search it had if that is the folder last shown. */
export function listingHref(folder?: string): string {
  const search = fromRecents() ? '' : last();
  if ((new URLSearchParams(search).get('folder') ?? '') === (folder ?? '')) return `/${search}`;
  return folder ? `/?folder=${encodeURIComponent(folder)}` : '/';
}
