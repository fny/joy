// Utilities for reading and parsing transcript JSONL files

import { readFileSync, existsSync } from 'node:fs';
import type { TranscriptEntry, UserEntry, AssistantEntry, SystemEntry, AttachmentEntry } from './entries';

export function parseEntry(line: string): TranscriptEntry | null {
  try {
    return JSON.parse(line.trim()) as TranscriptEntry;
  } catch {
    return null;
  }
}

export function readTranscript(path: string): TranscriptEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseEntry)
    .filter((e): e is TranscriptEntry => e !== null) as TranscriptEntry[];
}

export function isUser(e: TranscriptEntry): e is UserEntry {
  return e.type === 'user';
}

export function isAssistant(e: TranscriptEntry): e is AssistantEntry {
  return e.type === 'assistant';
}

export function isSystem(e: TranscriptEntry): e is SystemEntry {
  return e.type === 'system';
}

export function isAttachment(e: TranscriptEntry): e is AttachmentEntry {
  return e.type === 'attachment';
}

// Extract all plain-text user messages (skips tool results, meta entries)
export function userMessages(entries: TranscriptEntry[]): string[] {
  return entries
    .filter(isUser)
    .filter(e => !e.isMeta && typeof e.message.content === 'string')
    .map(e => e.message.content as string);
}

// Extract all assistant text responses (concatenates text blocks per turn)
export function assistantMessages(entries: TranscriptEntry[]): string[] {
  return entries
    .filter(isAssistant)
    .map(e => e.message.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')
    )
    .filter(Boolean);
}
