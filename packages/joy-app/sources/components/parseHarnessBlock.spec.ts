import { describe, it, expect, vi } from 'vitest';

// '@/text' pulls react-native in; the only key used here is the task line.
vi.mock('@/text', () => ({
  t: (key: string, params?: Record<string, string>) =>
    key === 'markdown.taskNotificationLine' && params
      ? `Background task ${params.status}: ${params.summary}`
      : key,
}));

import { parseHarnessBlock } from './parseHarnessBlock';

const notification = (status: string, summary: string) =>
  `<task-notification>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

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

describe('parseHarnessBlock — nothing after the first block is lost (#269)', () => {
  it('a notification followed by a real prompt keeps both', () => {
    const r = parseHarnessBlock(`${notification('completed', 'Built the index')}\nNow deploy it.`);
    expect(r).toEqual({ kind: 'none', text: 'Background task completed: Built the index\nNow deploy it.' });
  });

  it('two notifications become two lines', () => {
    const r = parseHarnessBlock(`${notification('completed', 'A')}\n${notification('failed', 'B')}`);
    expect(r).toEqual({ kind: 'none', text: 'Background task completed: A\nBackground task failed: B' });
  });

  it('a single whole-message notification is still a card', () => {
    expect(parseHarnessBlock(`  ${notification('completed', 'A')}  `)).toEqual({
      kind: 'task-notification', status: 'completed', summary: 'A', outputFile: undefined,
    });
  });

  it('two unknown blocks around prose stay text instead of collapsing to the first body', () => {
    const text = '<tool-result>a</tool-result> keep this <tool-result>b</tool-result>';
    expect(parseHarnessBlock(text)).toEqual({ kind: 'none', text });
  });

  it('an unknown block that IS the whole message still collapses, even with inner tags', () => {
    expect(parseHarnessBlock('<tool-result><x>1</x></tool-result>')).toEqual({ kind: 'unknown-block', tag: 'tool-result', text: '<x>1</x>' });
  });
});

describe('parseHarnessBlock — noise stripping spares code examples (#270)', () => {
  it('a fenced system-reminder example is the user\'s content', () => {
    const text = 'Explain this:\n```xml\n<system-reminder>Preserve this instruction.</system-reminder>\n```';
    expect(parseHarnessBlock(text)).toEqual({ kind: 'none', text });
  });

  it('an inline-code example survives too', () => {
    const text = 'What does `<bash-stdout>x</bash-stdout>` mean?';
    expect(parseHarnessBlock(text)).toEqual({ kind: 'none', text });
  });

  it('a real top-level reminder is still stripped while the quoted one stays', () => {
    const r = parseHarnessBlock('<system-reminder>ctx</system-reminder>\nSee:\n```\n<system-reminder>quoted</system-reminder>\n```');
    expect(r).toEqual({ kind: 'none', text: 'See:\n```\n<system-reminder>quoted</system-reminder>\n```' });
  });
});
