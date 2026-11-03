// Typen der Multi-Provider-Schicht von Buddy Island.
// Die JavaScript-Module in src/llm/ und src/models.js sind mit // @ts-check
// gegen diese Typen geprüft (npm run typecheck).
//
// Gemeinsames Nachrichtenformat ist das Content-Block-Format der Claude Messages API.
// Jeder Adapter übersetzt es in das Format seines Anbieters und zurück. So bleiben
// Agent, Router und Verlauf vom Anbieter unabhängig.

export type ProviderId = 'anthropic' | 'openai' | 'xai' | 'gemini' | 'huggingface';
export type ProviderKind = 'anthropic' | 'openai' | 'huggingface';
export type Tier = 'haiku' | 'sonnet' | 'opus';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Price {
  in: number;
  out: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Was ein Modell kann. Die Oberfläche und der Agent richten sich danach. */
export interface Capabilities {
  /** Kann Bilder (Bildschirmfotos) verarbeiten */
  vision: boolean;
  /** Kann Werkzeuge (Function Calling) aufrufen */
  tools: boolean;
  /** Kann den PC über das Computer-Use-Toolset bedienen */
  computerUse: boolean;
  /** Kann strukturierte JSON-Antworten nach Schema liefern */
  structured: boolean;
}

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  tier: Tier;
  name: string;
  short: string;
  price: Price;
  priceEstimated?: boolean;
  longContext?: { above: number; price: Price };
  efforts: string[];
  effortParam?: 'reasoning_effort';
  caps: Capabilities;
  local?: boolean;
  estimated?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  kind: ProviderKind;
  name: string;
  keyPrefix: string;
  keyHint: string;
  consoleUrl: string;
  host: string;
  baseUrl: string;
  needsKey: boolean;
  local?: boolean;
  family?: RegExp;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface TextBlock { type: 'text'; text: string }
export interface ImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
export interface ThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; toolset_name?: string }
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
  toolset_name?: string;
}
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface FunctionTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
/** Anbieter-eigenes Werkzeug (z. B. Claude Computer-Use-Toolset). Andere Adapter lassen es weg. */
export interface ServerTool { type: string }
export type Tool = FunctionTool | ServerTool;

export interface StreamRequest {
  apiKey: string;
  workspaceId?: string;
  model: string;
  system?: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens: number;
  effort?: string | null;
  /** JSON-Schema für strukturierte Antworten */
  format?: Record<string, unknown>;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onRetry?: (attempt: number, error: Error) => void;
}

export interface StreamResult {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'aborted' | string | null;
  usage: Usage;
  content: ContentBlock[];
  droppedComputer?: boolean;
  droppedFormat?: boolean;
}

export interface JsonRequest {
  apiKey: string;
  workspaceId?: string;
  model: string;
  system?: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: string;
  signal?: AbortSignal;
}

export interface JsonResult {
  data: any;
  usage: Usage;
  raw: string;
  stopReason: string | null;
}

export interface ModelEntry { id: string; name: string }

/** Gemeinsame Schnittstelle aller Anbieter (Strategy). */
export interface LlmClient {
  readonly provider: ProviderId;
  listModels(apiKey: string, workspaceId?: string): Promise<ModelEntry[]>;
  streamMessage(req: StreamRequest): Promise<StreamResult>;
  json(req: JsonRequest): Promise<JsonResult>;
  /** Gibt Ressourcen frei (z. B. lokaler Modell-Prozess) */
  stop?(): void;
}

export interface LlmRegistry {
  client(provider: ProviderId): LlmClient;
  providers: Record<ProviderId, ProviderInfo>;
  stopAll(): void;
}
