#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';
import { parseChangelogContent, type ChangelogData } from './changelogParse';

function parseChangelog(): ChangelogData {
    const changelogPath = path.join(__dirname, '../../CHANGELOG.md');

    if (!fs.existsSync(changelogPath)) {
        console.warn('CHANGELOG.md not found');
        return { entries: [], latestTitle: '' };
    }

    // Fence-aware parsing lives in changelogParse.ts (#350) so it is unit-testable.
    return parseChangelogContent(fs.readFileSync(changelogPath, 'utf-8'));
}

function main() {
    console.log('Parsing CHANGELOG.md...');

    const changelogData = parseChangelog();
    const outputPath = path.join(__dirname, '../changelog/changelog.json');

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(changelogData, null, 2));

    console.log(`Parsed ${changelogData.entries.length} entries`);
    console.log(`Latest: ${changelogData.latestTitle}`);
}

if (require.main === module) {
    main();
}

export { parseChangelog };
