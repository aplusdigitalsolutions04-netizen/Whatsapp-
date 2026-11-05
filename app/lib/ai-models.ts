export type AiProvider = "openai" | "anthropic";

export const DEFAULT_MODEL: Record<AiProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-5-5",
};
