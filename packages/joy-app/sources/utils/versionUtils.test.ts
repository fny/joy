import { describe, it, expect } from 'vitest';
import { compareVersions, isVersionSupported, parseVersion, MINIMUM_CLI_VERSION } from './versionUtils';

describe('versionUtils', () => {
    describe('compareVersions', () => {
        it('should correctly compare versions', () => {
            expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
            expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
            expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
            expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
            expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
        });

        it('should handle pre-release versions', () => {
            expect(compareVersions('0.10.0-1', '0.10.0')).toBe(0);
            expect(compareVersions('0.10.0-beta', '0.10.0')).toBe(0);
            expect(compareVersions('0.10.1-1', '0.10.0')).toBe(1);
        });

        it('should handle versions with different segment counts', () => {
            expect(compareVersions('1.0', '1.0.0')).toBe(0);
            expect(compareVersions('1', '1.0.0')).toBe(0);
            expect(compareVersions('1.1', '1.0.5')).toBe(1);
        });
    });

    describe('isVersionSupported', () => {
        it('should check if version meets minimum requirement', () => {
            expect(isVersionSupported('0.10.0', '0.10.0')).toBe(true);
            expect(isVersionSupported('0.10.1', '0.10.0')).toBe(true);
            expect(isVersionSupported('0.9.9', '0.10.0')).toBe(false);
            expect(isVersionSupported('1.0.0', '0.10.0')).toBe(true);
        });

        it('should handle undefined version', () => {
            expect(isVersionSupported(undefined, '0.10.0')).toBe(false);
        });

        it('should use default minimum version', () => {
            expect(isVersionSupported('0.10.0')).toBe(true);
            expect(isVersionSupported('0.9.0')).toBe(false);
        });
    });

    describe('parseVersion', () => {
        it('should parse valid version strings', () => {
            expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
            expect(parseVersion('0.10.0')).toEqual({ major: 0, minor: 10, patch: 0 });
            expect(parseVersion('0.10.0-1')).toEqual({ major: 0, minor: 10, patch: 0 });
        });

        it('should return null for invalid versions', () => {
            expect(parseVersion('invalid')).toBe(null);
            expect(parseVersion('')).toBe(null);
            expect(parseVersion('1.a.3')).toBe(null);
        });

        // #462: build metadata is not part of the numeric components
        it('strips build metadata', () => {
            expect(parseVersion('0.10.0+build.7')).toEqual({ major: 0, minor: 10, patch: 0 });
            expect(parseVersion('1.2.3-beta.1+sha.abc')).toEqual({ major: 1, minor: 2, patch: 3 });
            expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
        });

        // #463: components must be finite non-negative integers, at most three
        it('rejects coerced or malformed components', () => {
            expect(parseVersion('1..3')).toBe(null);
            expect(parseVersion('1.2.3.4')).toBe(null);
            expect(parseVersion('Infinity')).toBe(null);
            expect(parseVersion('1e3')).toBe(null);
            expect(parseVersion('-1.0.0')).toBe(null);
            expect(parseVersion('0.invalid.0')).toBe(null);
            expect(parseVersion('1.2.3-')).toBe(null);
        });
    });

    describe('build metadata and malformed input in compatibility checks', () => {
        it('build metadata does not change ordering (#462)', () => {
            expect(compareVersions('0.10.0+build.7', '0.10.1')).toBe(-1);
            expect(compareVersions('0.10.0+build.7', '0.10.0')).toBe(0);
            expect(isVersionSupported('0.10.0+build.7', '0.10.1')).toBe(false);
            expect(isVersionSupported('0.10.1+build.7', '0.10.1')).toBe(true);
        });

        it('malformed versions are unsupported instead of passing through as NaN (#463)', () => {
            expect(isVersionSupported('0.invalid.0')).toBe(false);
            expect(isVersionSupported('1..3', '0.10.0')).toBe(false);
            expect(isVersionSupported('Infinity', '0.10.0')).toBe(false);
            expect(isVersionSupported('1.2.3.4', '0.10.0')).toBe(false);
            expect(() => compareVersions('0.invalid.0', '0.10.0')).toThrow(/Invalid version/);
        });
    });
});