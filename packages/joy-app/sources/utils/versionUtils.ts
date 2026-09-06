/**
 * Utility functions for version comparison and validation
 */

// Minimum required CLI version for full compatibility
export const MINIMUM_CLI_VERSION = '0.10.0';

// `v?MAJOR[.MINOR[.PATCH]][-prerelease][+build]`. Components must be plain
// decimal digits: `Number()` used to accept "" (so "1..3" read as 1.0.3),
// "Infinity", "1e3" and NaN (so "0.invalid.0" compared as supported), and
// build metadata became part of a numeric component ("0.10.0+build.7" parsed
// to null but compared as GREATER than 0.10.1) — #462 #463.
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

type ParsedVersion = { major: number; minor: number; patch: number };

function parseStrict(version: string): ParsedVersion | null {
    if (typeof version !== 'string') return null;
    const m = VERSION_RE.exec(version.trim());
    if (!m) return null;
    const parts = [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number);
    // Digit-only matches are non-negative; guard the safe-integer range so a
    // 400-digit component cannot compare as Infinity.
    if (!parts.every((n) => Number.isSafeInteger(n))) return null;
    return { major: parts[0], minor: parts[1], patch: parts[2] };
}

/**
 * Compare two semantic version strings. Pre-release tags and build metadata
 * do not take part in the ordering ("0.10.0-1" == "0.10.0" == "0.10.0+b7").
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 * @throws when either version is not a valid version string
 */
export function compareVersions(version1: string, version2: string): number {
    const a = parseStrict(version1);
    const b = parseStrict(version2);
    if (!a) throw new Error(`Invalid version: ${version1}`);
    if (!b) throw new Error(`Invalid version: ${version2}`);
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (a[key] > b[key]) return 1;
        if (a[key] < b[key]) return -1;
    }
    return 0;
}

/**
 * Check if a version meets the minimum requirement
 * @param version Version to check
 * @param minimumVersion Minimum required version (defaults to MINIMUM_CLI_VERSION)
 * @returns true if version >= minimumVersion; false for a missing or malformed version
 */
export function isVersionSupported(version: string | undefined, minimumVersion: string = MINIMUM_CLI_VERSION): boolean {
    if (!version) return false;

    try {
        return compareVersions(version, minimumVersion) >= 0;
    } catch {
        // A malformed version cannot be shown to satisfy the minimum (#463).
        return false;
    }
}

/**
 * Parse version string to extract major, minor, and patch numbers
 * @param version Version string to parse
 * @returns Object with major, minor, and patch numbers, or null if invalid
 */
export function parseVersion(version: string): ParsedVersion | null {
    return parseStrict(version);
}
