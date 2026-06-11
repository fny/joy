import { describe, it, expect } from 'vitest';
import { parseHarnessBlock } from './parseHarnessBlock';

describe('parseHarnessBlock', () => {
  it('parses a task-notification into a card', () => {
    const r = parseHarnessBlock('<task-notification>\n<status>completed</status>\n<summary>Done thing</summary>\n<output-file>/tmp/x</output-file>\n</task-notification>');
    expect(r).toEqual({ kind: 'task-notification', status: 'completed', summary: 'Done thing', outputFile: '/tmp/x' });
  });
  it('strips a leading system-reminder, keeps the real prompt', () => {
    expect(parseHarnessBlock('<system-reminder>ctx</system-reminder>\nreal prompt')).toEqual({ kind: 'none', text: 'real prompt' });
  });
  it('hides a system-reminder-only message', () => {
    expect(parseHarnessBlock('<system-reminder>only</system-reminder>')).toEqual({ kind: 'none', text: '' });
  });
  it('leaves command wrappers for parseLocalCommandMessage', () => {
    expect(parseHarnessBlock('<command-name>/foo</command-name>')).toEqual({ kind: 'none', text: '<command-name>/foo</command-name>' });
  });
  it('collapses unknown blocks to a chip', () => {
    expect(parseHarnessBlock('<weird-tag>x</weird-tag>')).toEqual({ kind: 'unknown-block', tag: 'weird-tag', text: 'x' });
  });
  it('passes normal text through', () => {
    expect(parseHarnessBlock('hello world')).toEqual({ kind: 'none', text: 'hello world' });
  });
});
