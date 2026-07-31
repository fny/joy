import * as React from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { storage, useSocketStatus } from "@/sync/storage";
import { useActiveInterval } from '@/hooks/useActiveInterval';
import { Typography } from '@/constants/Typography';
import { hasJoyTags, splitJoySegments } from "@/utils/joyImg";
import { JoyFileChip } from "@/components/JoyFileChip";
import { JoyImage } from "./JoyImage";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage } from './parseLocalCommandMessage';
import { parseHarnessBlock } from './parseHarnessBlock';
import { stripAnsi } from '@/utils/ansi';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useChatFontScale } from '@/hooks/useChatFontScale';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  /**
   * Long-press handler for user-text bubbles. Wired by ChatList from
   * the active session screen and used by the fork-from-message flow.
   */
  onForkFromUserMessage?: (messageId: string, claudeUuid: string) => void;
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
          onForkFromUserMessage={props.onForkFromUserMessage}
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
  onForkFromUserMessage?: (messageId: string, claudeUuid: string) => void;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          onForkFromUserMessage={props.onForkFromUserMessage}
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
  onForkFromUserMessage?: (messageId: string, claudeUuid: string) => void;
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

  const claudeUuid = props.message.claudeUuid;
  const canFork = Boolean(claudeUuid) && Boolean(props.onForkFromUserMessage);
  const handleLongPress = React.useCallback(() => {
    if (claudeUuid && props.onForkFromUserMessage) {
      props.onForkFromUserMessage(props.message.id, claudeUuid);
    }
  }, [claudeUuid, props.message.id, props.onForkFromUserMessage]);

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
  const rawText = props.message.displayText || props.message.text;
  const harness = parseHarnessBlock(rawText);
  if (harness.kind === 'task-notification') {
    return <TaskNotificationCard status={harness.status} summary={harness.summary} />;
  }
  if (harness.kind === 'unknown-block') {
    return <GenericBlockChip tag={harness.tag} />;
  }
  // After stripping system-reminders, an empty message was pure machine
  // context — hide it.
  if (harness.text.length === 0 && rawText.trim().length > 0) {
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
      <Pressable
        onLongPress={canFork ? handleLongPress : undefined}
        delayLongPress={400}
        style={styles.userMessageBubble}
      >
        {isMonoCommand
          ? <Text style={[styles.monoMessageText, scaledBubbleText]} selectable>{bodyText}</Text>
          : slashMatch
            ? <Text style={[styles.slashMessageText, scaledBubbleText]} selectable>
                <Text style={styles.slashCommandToken}>{slashMatch[1]}</Text>
                {slashMatch[2]}
              </Text>
            : <MarkdownView markdown={bodyText} onOptionPress={handleOptionPress} sessionId={props.sessionId} />}
      </Pressable>
      {/* iMessage/WhatsApp-style delivery status: only for a still-unacked send
          (seq == null). Mounted only while pending, so acked messages carry no
          hook/interval overhead. */}
      {props.message.seq == null && (
        <MessageDeliveryStatus sessionId={props.sessionId} message={props.message} />
      )}
    </View>
  );
}

// A message is "pending" until the server acks it (seq flips non-null). We don't
// divert offline sends anymore — they ride the durable outbox, which auto-retries
// and re-flushes on reconnect — so this is purely a STATUS on the optimistically-
// shown message:
//   - fast online send (< a few seconds): nothing (avoid flicker on every msg)
//   - online but slow: "Sending…"
//   - offline: "Waiting for connection…" (known immediately from socketStatus)
//   - unacked for 2 min: "Not delivered · Tap to retry" (resend, same localId)
// The status clears itself the moment the outbox delivers and seq flips.
const PENDING_AFTER_MS = 4_000;
const FAILED_AFTER_MS = 2 * 60_000;

const MessageDeliveryStatus = React.memo(function MessageDeliveryStatus(props: { sessionId: string; message: UserTextMessage }) {
  const { theme } = useUnistyles();
  const [, setTick] = React.useState(0);
  // Re-render on an interval so the age-based state advances even without any
  // other render (focused + foregrounded only — see useActiveInterval).
  useActiveInterval(() => setTick((n) => n + 1), 5_000, true);
  const { status } = useSocketStatus();
  const online = status === 'connected';
  const age = Date.now() - props.message.createdAt;

  const kind: 'sending' | 'waiting' | 'failed' =
    age >= FAILED_AFTER_MS ? 'failed'
      : (!online || age >= PENDING_AFTER_MS) ? 'waiting'
        : 'sending';

  const onRetry = React.useCallback(() => {
    if (props.message.localId) {
      sync.sendMessage(props.sessionId, props.message.text, { localId: props.message.localId, source: 'chat' });
    }
  }, [props.sessionId, props.message.localId, props.message.text]);

  if (kind === 'sending') return null;

  // Match the draft/save-draft button tint so the status reads as the same
  // family of muted app-side affordances.
  const tint = theme.colors.button.secondary.tint;

  if (kind === 'failed') {
    return (
      <Pressable onPress={onRetry} hitSlop={6} style={({ pressed }) => [styles.deliveryRow, pressed && { opacity: 0.6 }]}>
        <Ionicons name="refresh-outline" size={12} color={tint} />
        <Text style={[styles.deliveryText, { color: tint }]}>{t('messageStatus.notDeliveredRetry')}</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.deliveryRow}>
      <Ionicons name="time-outline" size={12} color={tint} />
      <Text style={[styles.deliveryText, { color: tint }]}>
        {online ? t('messageStatus.sending') : t('messageStatus.waitingForConnection')}
      </Text>
    </View>
  );
});

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
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '100%',
  },
  // Delivery-status line tucked just under the bubble (bubble has marginBottom 12).
  deliveryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: -10,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  deliveryText: {
    fontSize: 11,
    ...Typography.default(),
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
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
