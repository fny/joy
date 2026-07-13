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

/** True when the path's extension is a known non-text (un-diffable) type.
 *  NOTE: svg is intentionally NOT here — it's XML text and diffs fine. */
export function isBinaryPath(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

// Renderable image formats — the subset of binaries the app can DISPLAY
// (expo-image). A superset like heic renders on iOS but not web/Android, so
// keep to the broadly-safe set; others fall back to the binary placeholder.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'avif']);

export function isImagePath(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}
