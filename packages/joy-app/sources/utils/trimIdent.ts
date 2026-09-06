export function trimIdent(text: string): string {
    // Split the text into an array of lines
    const split = text.split('\n');

    // Remove leading and trailing empty lines by INDEX, then slice once.
    // Shifting the array per leading blank line was quadratic: 100k leading
    // newlines (100 KB of input) blocked the UI thread for seconds (#460).
    let start = 0;
    while (start < split.length && split[start].trim() === '') start++;
    let end = split.length;
    while (end > start && split[end - 1].trim() === '') end--;
    const lines = split.slice(start, end);

    // Find the minimum number of leading spaces in non-empty lines
    const minSpaces = lines.reduce((min, line) => {
        if (line.trim() === '') {
            return min;
        }
        const leadingSpaces = line.match(/^\s*/)![0].length;
        return Math.min(min, leadingSpaces);
    }, Infinity);

    // Remove the common leading spaces from each line
    const trimmedLines = lines.map(line => line.slice(minSpaces));

    // Join the trimmed lines back into a single string
    return trimmedLines.join('\n');
}
