// Shared "is this file un-diffable?" check for the file viewer and the changes
// (diff) views. Extension-based — cheap and covers images/media/archives/
// compiled artifacts, i.e. everything a text diff renders as garbage.
const BINARY_EXTENSIONS = new Set([
    // images (incl. our own webp + modern formats the old list missed)
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'heic', 'heif',
    'avif', 'tiff', 'tif', 'psd', 'ai', 'sketch', 'fig', 'xcf',
    // video
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', 'm4v',
    // audio
    'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'aiff',
    // documents
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'key', 'numbers', 'pages',
    // archives
    'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'tgz',
    // executables / compiled artifacts
    'exe', 'dll', 'dmg', 'deb', 'rpm', 'bin', 'dat', 'o', 'a', 'so',
    'dylib', 'class', 'jar', 'wasm', 'pyc', 'pyo', 'node',
    // fonts
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    // databases
    'db', 'sqlite', 'sqlite3',
]);

/**
 * Lower-cased extension of the path's basename, '' when it has none. The
 * separator must be present and not the basename's first character: a
 * root-level file named "a", "key" or "png" has NO extension — split('.').pop()
 * returned the whole name and classified it as binary / an image, while the
 * same file as "./png" was text (#422). A dotfile (".env") is extensionless too.
 */
export function fileExtension(path: string): string {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const basename = slash === -1 ? path : path.slice(slash + 1);
    const dot = basename.lastIndexOf('.');
    if (dot <= 0 || dot === basename.length - 1) return '';
    return basename.slice(dot + 1).toLowerCase();
}

/** True when the path's extension is a known non-text (un-diffable) type.
 *  NOTE: svg is intentionally NOT here — it's XML text and diffs fine. */
export function isBinaryPath(path: string): boolean {
    return BINARY_EXTENSIONS.has(fileExtension(path));
}

// Renderable image formats — the subset of binaries the app can DISPLAY
// (expo-image). A superset like heic renders on iOS but not web/Android, so
// keep to the broadly-safe set; others fall back to the binary placeholder.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'avif']);

export function isImagePath(path: string): boolean {
    return IMAGE_EXTENSIONS.has(fileExtension(path));
}
