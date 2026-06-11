import * as React from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage, isPureSlashCommandLine } from './parseLocalCommandMessage';
import { parseHarnessBlock } from './parseHarnessBlock';
import { stripAnsi } from '@/utils/ansi';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';


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
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} />;


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
  // literal text, which looks broken. Collapse them into chips or hide
  // them entirely depending on what kind of wrapper this is.
  // The user's own slash-command input is shown optimistically (carries a
  // localId); the SDK then injects the canonical wrapper chip. Hide the raw
  // echo so we don't render the command twice. Gated to Claude flavor only:
  // Codex/Gemini don't reliably emit the <command-*> wrapper, so hiding the
  // echo there would drop the command with nothing to replace it. (Absent
  // flavor == Claude, matching the convention used elsewhere.)
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

  // Hide raw slash-command lines entirely — the <command-name> wrapper renders
  // as the single /cmd chip, so the raw line (optimistic echo OR daemon-mirrored
  // duplicate) shouldn't also appear.
  if (isPureSlashCommandLine(cleanedText)) {
    return null;
  }

  const parsed = parseLocalCommandMessage(cleanedText);
  if (parsed.kind === 'caveat') {
    return null;
  }
  if (parsed.kind === 'command-run') {
    return (
      <View style={styles.userMessageContainer}>
        <View style={styles.commandChip}>
          <Text style={styles.commandChipText}>/{parsed.commandName}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.userMessageContainer}>
      <Pressable
        onLongPress={canFork ? handleLongPress : undefined}
        delayLongPress={400}
        style={styles.userMessageBubble}
      >
        <MarkdownView markdown={stripAnsi(parsed.text)} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      </Pressable>
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

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={stripAnsi(props.message.text)} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
    </View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
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
