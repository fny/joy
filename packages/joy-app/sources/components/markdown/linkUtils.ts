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
