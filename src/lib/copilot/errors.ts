/** Map AI/gateway errors to a safe, user-facing message (pure; unit-tested). Never echoes secrets. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/(token|key|secret|password|authorization)(["'\s:=]+)([^\s"',}]+)/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[redacted]");
}

export function friendlyAiError(error: unknown, model: string): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : JSON.stringify(error ?? "");
  const msg = scrubSecrets(raw ?? "").slice(0, 400);
  if (/InvalidToolInput|NoSuchTool|ToolCallRepair/i.test(msg)) return "Copilot made an invalid tool call and will retry with corrected input.";
  if (/free tier|do not have access|not have access|not available on your plan|model_not_found|no such model|unknown model/i.test(msg))
    return `The AI model "${model}" is not available on the current AI Gateway plan. An admin can choose another model in Admin → AI settings (ai.model_strong).`;
  if (/rate.?limit|too many requests|\b429\b/i.test(msg)) return `The AI provider is rate-limiting requests for "${model}". Wait a moment and try again.`;
  if (/timeout|timed out|ETIMEDOUT|aborted/i.test(msg)) return `The AI model "${model}" timed out. Try a narrower question.`;
  if (/api key|unauthori[sz]ed|\b401\b|authentication/i.test(msg)) return `The AI Gateway rejected the credentials for "${model}". An admin needs to check the AI configuration.`;
  return `Copilot hit an error calling "${model}". ${msg.split("\n")[0]!.slice(0, 200)}`;
}
