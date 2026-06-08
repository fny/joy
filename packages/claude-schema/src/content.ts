// Content block types that appear inside message.content arrays

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  // Empty string in the JSONL — actual thinking is stripped, only signature remains
  thinking: string;
  signature: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;           // e.g. "toolu_01ABC..."
  name: string;         // Tool name e.g. "Bash", "Read", "Agent"
  input: Record<string, unknown>;
  caller?: { type: 'direct' | string };
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: ImageSource }>;
  is_error: boolean;
}

export interface ImageSource {
  type: 'base64';
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

export interface ImageBlock {
  type: 'image';
  source: ImageSource;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

// Cache usage breakdown
export interface CacheCreation {
  ephemeral_1h_input_tokens: number;
  ephemeral_5m_input_tokens: number;
}

export interface UsageIteration {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  type: 'message';
}

export interface ServerToolUse {
  web_search_requests: number;
  web_fetch_requests: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  server_tool_use?: ServerToolUse;
  service_tier?: string;
  cache_creation?: CacheCreation;
  iterations?: UsageIteration[];
  speed?: string;
}
