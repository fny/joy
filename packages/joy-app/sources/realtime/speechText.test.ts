import { expect, test } from 'vitest';
import { speechText } from './speechText';
test('omits code and attached payloads, keeps human-readable link labels', () => {
    expect(speechText('**Done** [report](https://example.com) <joy-file>secret</joy-file>\n```sh\nrm file\n```')).toBe('Done report Code omitted.');
});
test('keeps question choices readable and bounds long responses', () => {
    expect(speechText('Choose <joy-options><joy-option>One</joy-option><joy-option>Two</joy-option></joy-options>')).toBe('Choose One Two');
    expect(speechText('Long '.repeat(200)).length).toBeLessThanOrEqual(400);
});
