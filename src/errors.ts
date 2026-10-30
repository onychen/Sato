export type ErrorCode =
  | 'MODEL_HTTP' | 'MODEL_NETWORK' | 'MODEL_PROTOCOL' | 'REQUEST_TIMEOUT'
  | 'TOOL_NOT_FOUND' | 'TOOL_INPUT' | 'PERMISSION_DENIED' | 'TOOL_HOOK' | 'TOOL_EXECUTION' | 'TOOL_TIMEOUT'
  | 'CANCELLED' | 'CONTEXT_BUDGET' | 'SESSION_READ' | 'SESSION_WRITE' | 'RUNTIME_ERROR';

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  /** 仅表示故障可能是暂时的，不表示可安全重放有副作用的操作。 */
  retryable: boolean;
  status?: number;
}

export class SatoError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly retryable = false,
    options?: ErrorOptions, public readonly status?: number) {
    super(message, options);
    this.name = 'SatoError';
  }
}

export function errorMessage(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return 'Unknown error'; }
}

/** 只序列化稳定字段，不把堆栈、cause、请求头或完整响应体发送到 UI / 模型。 */
export function errorInfo(error: unknown, fallback: ErrorCode = 'RUNTIME_ERROR'): ErrorInfo {
  return {
    code: error instanceof SatoError ? error.code : fallback,
    message: errorMessage(error),
    retryable: error instanceof SatoError && error.retryable,
    ...(error instanceof SatoError && error.status !== undefined ? { status: error.status } : {}),
  };
}
