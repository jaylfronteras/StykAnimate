export class ToolError extends Error {
  constructor(message, {code = 'invalid'} = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export function explain(error) {
  if (!error) return 'Unknown error';
  const text = error.message || String(error);
  return error.code && !text.includes(error.code) ? `${text} (${error.code})` : text;
}
