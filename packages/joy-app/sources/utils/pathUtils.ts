import { Metadata } from '@/sync/storageTypes';

/**
 * Resolves a path relative to the root path from metadata.
 * ALL paths are treated as relative to the metadata root, regardless of their format.
 * If metadata is not provided, returns the original path.
 * 
 * @param path - The path to resolve (always treated as relative to the metadata root)
 * @param metadata - Optional metadata containing the root path
 * @returns The resolved absolute path
 */
/** Exact-case comparison, always. Neither the platform nor the spelling of
 *  the path is evidence of how the remote filesystem compares names: Linux
 *  hosts have /Users paths, macOS mounts case-sensitive volumes, a Windows
 *  directory can be flagged case-sensitive. Folding by `os` or by a
 *  `/Users/` prefix mislabeled /Volumes/CS/project's files as the session's
 *  own /Volumes/CS/Project (#441). Nothing the daemon reports carries real
 *  filesystem semantics, so a path that does not match exactly is kept
 *  absolute — a longer label beats a wrong one. */
export function resolvePath(path: string, metadata: Metadata | null): string {
    if (!metadata) {
        return path;
    }
    if (path.startsWith(metadata.path)) {
        // Check that the path is actually within the metadata path by ensuring
        // there's either an exact match or a path separator after the metadata path
        const remainder = path.slice(metadata.path.length);
        if (remainder === '' || remainder.startsWith('/')) {
            let out = remainder;
            if (out.startsWith('/')) {
                out = out.slice(1);
            }
            if (out === '') {
                return '<root>';
            }
            return out;
        }
    }
    return path;
}

/**
 * Drop one trailing separator UNLESS it is the whole root: a home of `/`
 * became '' and `C:\` became the drive-relative `C:` (#442), which resolves
 * to the process's current directory on that drive, not the root.
 */
function stripTrailingSeparator(dir: string): string {
    if (!dir.endsWith('/') && !dir.endsWith('\\')) return dir;
    const trimmed = dir.slice(0, -1);
    // POSIX root ('/'), a drive root ('C:\' / 'C:/') or a UNC-less empty
    // prefix: the separator IS the path.
    if (trimmed === '' || /^[A-Za-z]:$/.test(trimmed)) return dir;
    return trimmed;
}

/**
 * Resolves paths starting with ~ to absolute paths using the provided home directory.
 * Non-tilde paths are returned unchanged.
 * 
 * @param path - The path to resolve (may start with ~)
 * @param homeDir - The user's home directory (e.g., '/Users/steve' or 'C:\Users\steve')
 * @returns The resolved absolute path
 */
export function resolveAbsolutePath(path: string, homeDir?: string): string {
    // Return original path if it doesn't start with ~
    if (!path.startsWith('~')) {
        return path;
    }
    
    // Return original path if no home directory provided
    if (!homeDir) {
        return path;
    }
    
    // Handle exact ~ (home directory)
    if (path === '~') {
        return stripTrailingSeparator(homeDir);
    }

    // Handle ~/ and ~/path (home directory with subdirectory)
    if (path.startsWith('~/')) {
        const relativePart = path.slice(2); // Remove '~/'
        // Detect path separator based on homeDir - prefer the last separator found
        const hasBackslash = homeDir.lastIndexOf('\\') > homeDir.lastIndexOf('/');
        const separator = hasBackslash ? '\\' : '/';
        const normalizedHome = stripTrailingSeparator(homeDir);
        // A root home keeps its own separator: '/' + 'x' is '/x', never '//x'.
        const joiner = normalizedHome.endsWith('/') || normalizedHome.endsWith('\\') ? '' : separator;
        return normalizedHome + joiner + relativePart;
    }
    
    // Handle ~username paths (not supported, return original)
    return path;
}
/**
 * If the path is INSIDE the home directory, replace that prefix with ~;
 * otherwise return the path unchanged. The match must end at a directory
 * boundary: a plain `startsWith` rewrote /home/alice2/project on a machine
 * whose home is /home/alice to ~/2/project, which resolves to a different
 * (or nonexistent) directory (#193).
 */
export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;

    // Normalize paths to handle trailing slashes
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    if (normalizedHome === '') return path;

    if (path === normalizedHome) return '~';
    if (path.startsWith(normalizedHome + '/')) {
        return '~' + path.slice(normalizedHome.length);
    }
    return path;
}
