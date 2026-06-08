// Known tool input shapes. The `input` field of a ToolUseBlock is one of these.

export interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;        // PDF page range e.g. "1-5"
}

export interface WriteInput {
  file_path: string;
  content: string;
}

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface AgentInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  run_in_background?: boolean;
  isolation?: 'worktree';
  model?: string;
}

export interface WebFetchInput {
  url: string;
  prompt: string;
}

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
}

export interface ToolSearchInput {
  query: string;
  max_results?: number;
}

export interface SkillInput {
  skill: string;
  args?: string;
}

// AskUserQuestion, NotebookEdit, etc. have their own input shapes
// but are less commonly seen in transcripts
