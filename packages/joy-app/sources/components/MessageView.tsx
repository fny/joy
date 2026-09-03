import * as React from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { storage } from "@/sync/storage";
import { Typography } from '@/constants/Typography';
import { hasJoyTags, splitJoySegments } from "@/utils/joyImg";
import { JoyFileChip } from "@/components/JoyFileChip";
import { JoyImage } from "./JoyImage";
import { AttachmentView } from "./AttachmentView";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage } from './parseLocalCommandMessage';
import { parseHarnessBlock } from './parseHarnessBlock';
import { stripAnsi } from '@/utils/ansi';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { useChatFontScale } from '@/hooks/useChatFontScale';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) => {
  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={Platform.OS !== 'web'}
    >
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
        />
      </View>
    </View>
  );
});

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
        />
      );

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} sessionId={props.sessionId} messageId={props.message.id} />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // Chat font size setting: scale the 16/24 bubble text metrics. null at 100%
  // so the static unistyles objects pass through untouched.
  const chatFontScale = useChatFontScale();
  const scaledBubbleText = chatFontScale !== 1
    ? { fontSize: 16 * chatFontScale, lineHeight: 24 * chatFontScale }
    : null;

  // Claude Agent SDK emits synthetic user messages wrapped in tags like
  // <local-command-caveat>…</local-command-caveat> and
  // <command-message>…</command-message><command-name>/foo</command-name>
  // whenever a slash command runs. The plain MarkdownView renders these as
  // literal text, which looks broken. parseLocalCommandMessage below hides pure
  // caveats and reconstructs a readable line if a <command-*> wrapper slips
  // through; the user's own typed slash commands render as plain messages (no
  // chips, no echo-hiding — that design was removed, see parseLocalCommandMessage).
  // Harness-injected pseudo-XML blocks (task notifications, system reminders,
  // unknown tags) — render as cards/chips or strip, so raw XML never shows.
  // A message another joy session (or a shell, or a cron) sent through the
  // daemon arrives wrapped in <joy-message from=… reply-to=…>; the daemon
  // also stamps meta.from. Show the sender, hide the wrapper.
  const wrapped = /^\s*<joy-message\b([^>]*)>([\s\S]*?)<\/joy-message>\s*$/.exec(props.message.text);
  const from = props.message.meta?.from ?? (wrapped ? /\bfrom="([^"]+)"/.exec(wrapped[1])?.[1] : undefined);
  const rawText = props.message.displayText || (wrapped ? wrapped[2].trim() : props.message.text);
  // Post-compaction summary: a wall of machine-generated context, not a user
  // message — render as a collapsed toggle row (like tool calls), not a bubble.
  if (props.message.isCompactSummary) {
    return <CompactSummaryBlock text={rawText} />;
  }
  const harness = parseHarnessBlock(rawText);
  if (harness.kind === 'task-notification') {
    return <TaskNotificationCard status={harness.status} summary={harness.summary} />;
  }
  if (harness.kind === 'unknown-block') {
    return <GenericBlockChip tag={harness.tag} />;
  }
  const attachments = props.message.attachments ?? [];
  // After stripping system-reminders, an empty message was pure machine
  // context — hide it.
  if (harness.text.length === 0 && rawText.trim().length > 0 && attachments.length === 0) {
    return null;
  }
  const cleanedText = harness.text;

  // No command chips: the user's typed commands (slash or !bash) show as plain
  // messages. parseLocalCommandMessage only hides pure caveats and reconstructs
  // a readable line if a <command-*> wrapper ever slips through.
  const parsed = parseLocalCommandMessage(cleanedText);
  if (parsed.kind === 'caveat') {
    return null;
  }
  const bodyText = stripAnsi(parsed.kind === 'command-run'
    ? `/${parsed.commandName}${parsed.args ? ' ' + parsed.args : ''}`
    : parsed.text);
  // Command lines (`!`bash / `&`background) render monospace, matching the
  // composer. The bash OUTPUT renders as a structured card on the agent side.
  const isMonoCommand = /^\s*[!&]/.test(bodyText);
  // Slash commands render as normal text with the COMMAND TOKEN bold — not
  // monospace (the whole-bubble mono read as code for what is chat-adjacent).
  const slashMatch = !isMonoCommand ? /^(\/[a-zA-Z][\w:-]*)([\s\S]*)$/.exec(bodyText) : null;

  return (
    <View style={styles.userMessageContainer}>
      {/* Attachments sit above the bubble, right-aligned like it; a picture-
          only send has no bubble at all. */}
      {attachments.length > 0 && (
        <View style={styles.userAttachments}>
          {attachments.map((a) => <AttachmentView key={a.id} sessionId={props.sessionId} attachment={a} />)}
        </View>
      )}
      {from && (
        <View style={styles.fromRow}>
          <Ionicons name={from.startsWith('joy:') ? 'git-network-outline' : from.startsWith('cron:') ? 'time-outline' : 'terminal-outline'} size={12} style={styles.fromIcon} />
          <Text style={styles.fromText}>{t('session.messageFrom', { from: from.replace(/^joy:/, '') })}</Text>
        </View>
      )}
      {bodyText.trim().length > 0 && <View style={[styles.userMessageBubble, from ? styles.peerMessageBubble : null]}>
        {isMonoCommand
          ? <Text style={[styles.monoMessageText, scaledBubbleText]} selectable>{bodyText}</Text>
          : slashMatch
            ? <Text style={[styles.slashMessageText, scaledBubbleText]} selectable>
                <Text style={styles.slashCommandToken}>{slashMatch[1]}</Text>
                {slashMatch[2]}
              </Text>
            : <MarkdownView markdown={bodyText} onOptionPress={handleOptionPress} sessionId={props.sessionId} />}
      </View>}
    </View>
  );
}

// A harness block rendered in the same visual language as tool calls: a
// rounded surface box with an icon, a title (+ inline status), and a subtitle.
function HarnessBlockRow({ icon, iconColor, title, status, subtitle }: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  title: string;
  status?: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.harnessContainer}>
      <View style={styles.harnessBox}>
        <View style={styles.harnessHeader}>
          <View style={styles.harnessIcon}>
            <Ionicons name={icon} size={18} color={iconColor} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.harnessTitle} numberOfLines={1}>
              {title}{status ? <Text style={styles.harnessStatus}>{` ${status}`}</Text> : null}
            </Text>
            {subtitle ? <Text style={styles.harnessSubtitle} numberOfLines={2}>{subtitle}</Text> : null}
          </View>
        </View>
      </View>
    </View>
  );
}

// The daemon emits `!cmd` output as a base64-packed <bash-run> block. Parse it
// back into { cmd, stdout, stderr }.
function parseBashRun(text: string): { cmd: string; stdout: string; stderr: string } | null {
  const t = text.trim();
  if (!t.startsWith('<bash-run>')) return null;
  const pick = (tag: string) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(t);
    return m ? m[1] : '';
  };
  const dec = (b64: string) => {
    try { return decodeURIComponent(escape(atob(b64))); } catch { return ''; }
  };
  return { cmd: dec(pick('cmd')), stdout: dec(pick('stdout')), stderr: dec(pick('stderr')) };
}

// Bash command output, structured like a tool call: the command in the header,
// stdout in white and stderr red-diff styled in the terminal-coloured body.
function BashRunCard({ cmd, stdout, stderr }: { cmd: string; stdout: string; stderr: string }) {
  const { theme } = useUnistyles();
  const hasBody = !!(stdout.trim() || stderr.trim());
  return (
    <View style={styles.harnessContainer}>
      <View style={styles.harnessBox}>
        <View style={styles.harnessHeader}>
          <View style={styles.harnessIcon}>
            <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />
          </View>
          <Text style={styles.commandCellText} numberOfLines={2}>{cmd || '(command)'}</Text>
        </View>
        {hasBody && (
          <View style={styles.bashBody}>
            {!!stdout.trim() && <Text style={styles.bashStdout} selectable>{stdout}</Text>}
            {!!stderr.trim() && <Text style={styles.bashStderr} selectable>{stderr}</Text>}
          </View>
        )}
      </View>
    </View>
  );
}

// The daemon emits a <joy-compacted>{json}</joy-compacted> marker when Claude
// finishes compacting. It carries the only facts worth showing about a
// compaction: what triggered it, how long it took, and how much context came
// back. Parse it out; a malformed payload renders nothing rather than raw XML.
type Compacted = { trigger?: string; durationMs?: number; preTokens?: number; postTokens?: number };
function parseJoyCompacted(text: string): Compacted | null {
  const m = /^\s*<joy-compacted>([\s\S]*?)<\/joy-compacted>\s*$/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    return (o && typeof o === 'object') ? o as Compacted : {};
  } catch { return {}; }
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// Compaction boundary → a quiet centred rule, not a message. It marks where the
// conversation was summarized and says what that cost, so the collapsed summary
// card below it has context.
function CompactedDivider({ info }: { info: Compacted }) {
  const parts: string[] = [];
  if (typeof info.durationMs === 'number') parts.push(formatDuration(info.durationMs));
  if (typeof info.preTokens === 'number' && typeof info.postTokens === 'number') {
    parts.push(`${formatTokens(info.preTokens)} → ${formatTokens(info.postTokens)}`);
  }
  return (
    <View style={styles.compactedDivider}>
      <View style={styles.compactedRule} />
      <Text style={styles.compactedLabel} numberOfLines={1}>
        {t('message.contextCompacted')}{parts.length ? ` · ${parts.join(' · ')}` : ''}
      </Text>
      <View style={styles.compactedRule} />
    </View>
  );
}

// Background task completion (the harness's <task-notification> block).
function TaskNotificationCard({ status, summary }: { status: string; summary: string }) {
  const { theme } = useUnistyles();
  const ok = /complet|success|done|ok/i.test(status);
  const failed = /fail|error|cancel/i.test(status);
  return (
    <HarnessBlockRow
      icon={ok ? 'checkmark-circle' : failed ? 'close-circle' : 'ellipse-outline'}
      iconColor={ok ? '#30D158' : failed ? '#FF3B30' : theme.colors.textSecondary}
      title="Background task"
      status={status}
      subtitle={summary}
    />
  );
}

// Fallback for any unknown harness block, so raw XML never reaches the user.
function GenericBlockChip({ tag }: { tag: string }) {
  const { theme } = useUnistyles();
  return <HarnessBlockRow icon="cube-outline" iconColor={theme.colors.textSecondary} title={tag} />;
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // Hide thinking messages
  if (props.message.isThinking) {
    return null;
  }

  // Compaction boundary marker → divider.
  const compacted = parseJoyCompacted(props.message.text);
  if (compacted) {
    return <CompactedDivider info={compacted} />;
  }

  // Bash command output → structured terminal card.
  const bashRun = parseBashRun(props.message.text);
  if (bashRun) {
    return <BashRunCard cmd={bashRun.cmd} stdout={bashRun.stdout} stderr={bashRun.stderr} />;
  }

  const text = stripAnsi(props.message.text);

  // <joy-img/> tags → inline images interleaved with the surrounding markdown
  // (bytes fetched on demand over the readFile RPC; see JoyImage).
  if (hasJoyTags(text)) {
    const segments = splitJoySegments(text);
    return (
      <View style={styles.agentMessageContainer}>
        {segments.map((seg, i) => seg.kind === 'md'
          ? <MarkdownView key={i} markdown={seg.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
          : seg.kind === 'img'
            ? <JoyImage key={i} sessionId={props.sessionId} src={seg.src} width={seg.width} height={seg.height} alt={seg.alt} />
            : <JoyFileChip key={i} sessionId={props.sessionId} path={seg.path} line={seg.line} name={seg.name} />)}
      </View>
    );
  }

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
    </View>
  );
}

// Collapsed-by-default row for the post-compaction summary. The text is huge
// and machine-authored; nobody wants it open in the scrollback, but it must
// stay reachable (it explains what the agent still "knows").
function CompactSummaryBlock(props: { text: string }) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  return (
    <View style={styles.compactSummaryContainer}>
      <Pressable onPress={() => setExpanded(v => !v)} style={styles.compactSummaryHeader} hitSlop={4}>
        <Ionicons name="archive-outline" size={16} color={theme.colors.textSecondary} />
        <Text style={styles.compactSummaryTitle}>{t('message.compactionSummary')}</Text>
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={theme.colors.textSecondary} />
      </Pressable>
      {expanded && (
        <Text style={styles.compactSummaryText} selectable>
          {props.text}
        </Text>
      )}
    </View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
  sessionId: string;
  messageId: string;
}) {
  const { sessionId, messageId } = props;
  // Local-only notice rows (e.g. "Message failed to send after 30s") have no
  // server presence and nothing else ever clears them — tap to dismiss.
  const handleDismiss = React.useCallback(() => {
    storage.getState().dismissMessage(sessionId, messageId);
  }, [sessionId, messageId]);
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <Pressable onPress={handleDismiss} style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </Pressable>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={styles.toolContainer}>
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: layout.maxWidth,
    overflow: 'hidden',
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userAttachments: {
    alignItems: 'flex-end',
    gap: 6,
    marginBottom: 12,
    maxWidth: '100%',
  },
  // Peer messages (from another joy session / a shell) — same shape, a
  // quieter tint plus the sender line above.
  peerMessageBubble: {
    backgroundColor: theme.colors.surfaceHigh,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  fromRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  fromIcon: {
    color: theme.colors.textSecondary,
  },
  fromText: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    ...Typography.default('semiBold'),
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '100%',
  },
  // `!`/`&`-prefixed messages (bash / background) read as monospace in chat,
  // matching how the composer renders them.
  monoMessageText: {
    // Match the normal message text metrics (MarkdownView body) — size,
    // line-height AND the 8px top/bottom margins — so command bubbles are the
    // same height as normal messages, only with a monospace font.
    fontSize: 16,
    lineHeight: 24,
    marginTop: 8,
    marginBottom: 8,
    color: theme.colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  // Slash-command bubbles: normal chat typography, command token bold.
  slashMessageText: {
    fontSize: 16,
    lineHeight: 24,
    marginTop: 8,
    marginBottom: 8,
    color: theme.colors.text,
  },
  slashCommandToken: {
    fontWeight: '700',
  },
  commandCellText: {
    flex: 1,
    fontSize: 14,
    color: theme.colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  // Bash output body — styled like the file diff view: stdout as context
  // lines, stderr as removed (red) lines.
  bashBody: {
    backgroundColor: theme.colors.surface,
    paddingVertical: 4,
  },
  bashStdout: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.diff.contextText,
    backgroundColor: theme.colors.diff.contextBg,
    paddingHorizontal: 12,
    paddingVertical: 2,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  bashStderr: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.diff.removedText,
    backgroundColor: theme.colors.diff.removedBg,
    paddingHorizontal: 12,
    paddingVertical: 2,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  // Harness blocks (task notifications, unknown tags) — same look as tool calls.
  harnessContainer: {
    marginHorizontal: 8,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  harnessBox: {
    backgroundColor: theme.colors.surfaceHigh,
    borderRadius: 8,
    marginVertical: 4,
    overflow: 'hidden',
  },
  harnessHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    backgroundColor: theme.colors.surfaceHighest,
  },
  harnessIcon: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  harnessTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: theme.colors.text,
  },
  harnessStatus: {
    fontSize: 14,
    fontWeight: '400',
    color: theme.colors.textSecondary,
  },
  harnessSubtitle: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  commandChip: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 10,
    marginBottom: 12,
    maxWidth: '100%',
    opacity: 0.65,
  },
  commandChipText: {
    color: theme.colors.input.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    maxWidth: '100%',
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  toolContainer: {
    marginHorizontal: 8,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  compactedDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginVertical: 14,
  },
  compactedRule: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.divider,
  },
  compactedLabel: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  compactSummaryContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    backgroundColor: theme.colors.surface,
    overflow: 'hidden',
  },
  compactSummaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  compactSummaryTitle: {
    flex: 1,
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  compactSummaryText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
