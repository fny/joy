const HTTP_URL_PATTERN = /^https?:\/\//i;

export function isHttpMarkdownLink(url: string): boolean {
    return HTTP_URL_PATTERN.test(url.trim());
}

/**
 * Host of a markdown image URL, shown on its "Load image" placeholder; null
 * when the URL is not http(s) — such images are never fetched (#94).
 */
export function markdownImageHost(url: string): string | null {
    if (!isHttpMarkdownLink(url)) return null;
    try {
        return new URL(url.trim()).host || null;
    } catch {
        return null;
    }
}

/**
 * A remote image's tap approval is the URL that was approved, never a flag,
 * compared during render: a component instance that moves on to another URL
 * (markdown blocks are keyed by index) shows THAT URL's placeholder. A
 * boolean reset in a passive effect let URL B mount an <Image> for one
 * render on URL A's approval (#94).
 */
export function isApprovedImageUrl(approvedUrl: string | null, url: string): boolean {
    return approvedUrl !== null && approvedUrl === url;
}
