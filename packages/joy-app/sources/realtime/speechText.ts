/** Text sent for speech is deliberately smaller than the chat context: no
 * reasoning, tool arguments, code blocks, file payloads, or internal tags. */
export function speechText(text: string, max = 400): string {
    const clean = text
        .replace(/```[\s\S]*?```/g, ' Code omitted. ')
        .replace(/<joy-(title|notify|bg|img|file)[^>]*>[\s\S]*?<\/joy-\1>/g, '')
        .replace(/<\/?[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, 'link')
        .replace(/[*_`#]/g, '')
        .replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    const clipped = clean.slice(0, max - 1);
    const boundary = clipped.lastIndexOf(' ');
    return clipped.slice(0, boundary > max / 2 ? boundary : undefined) + '…';
}
