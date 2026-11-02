const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is not set. Copy .env.example to .env and fill it in.");
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

export type CheckResult = { result: "pass" | "flag"; reasons: string[] };
// model is the one OpenRouter actually routed to, or null if the response didn't say.
export type CheckOutcome = CheckResult & { model: string | null };

// Thrown when the upstream model call fails or its reply is unusable; the server maps it to 502.
export class ModelError extends Error {
  override name = "ModelError";
}

// Thrown when the model call is still timing out after all retries; the server maps it to 504.
export class ModelTimeoutError extends ModelError {
  override name = "ModelTimeoutError";
}

// Thrown when the model answered but its reply can't be used; carries the reply so it can be quarantined.
export class UnusableReplyError extends ModelError {
  override name = "UnusableReplyError";
  constructor(
    readonly reason: string,
    readonly rawReply: string,
  ) {
    super(`${reason}: ${rawReply}`);
  }
}

// Defaults for the OpenRouter call; tests override them so they run fast and never hit the real API.
export type CheckOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
};
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 2;

function isCheckResult(value: unknown): value is CheckResult {
  if (typeof value !== "object" || value === null) return false;
  const { result, reasons } = value as Record<string, unknown>;
  return (
    (result === "pass" || result === "flag") &&
    Array.isArray(reasons) &&
    reasons.every((reason) => typeof reason === "string")
  );
}

const SYSTEM_PROMPT = `You check a piece of text against a list of rules.
Reply with ONLY a JSON object, no other text, in exactly this shape:
{"result": "pass" | "flag", "reasons": string[]}
Use "flag" if the text breaks any rule, with one short reason per broken rule.
Use "pass" with an empty reasons array if it breaks none.`;

export async function checkText(
  text: string,
  rules: string[],
  { fetch: fetchFn = fetch, timeoutMs = TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS }: CheckOptions = {},
): Promise<CheckOutcome> {
  const userPrompt = `Rules:\n${rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n")}\n\nText:\n${text}`;
  const body = JSON.stringify({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
  });

  // One request with its own timeout. Returns the body text on success; otherwise says whether to retry.
  async function attempt(): Promise<{ ok: true; bodyText: string } | { ok: false; retry: boolean; error: ModelError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      // Reading the body is inside the timeout too, so a response that stalls mid-stream can't hang forever.
      const bodyText = await response.text();
      if (response.ok) return { ok: true, bodyText };
      // 429 and 5xx are usually temporary; other 4xx (bad key, bad request) will fail the same way again.
      const retry = response.status === 429 || response.status >= 500;
      return { ok: false, retry, error: new ModelError(`OpenRouter request failed: ${response.status} ${bodyText}`) };
    } catch (err) {
      // Our own abort means the timeout fired; anything else thrown by fetch is a network error.
      const error = controller.signal.aborted
        ? new ModelTimeoutError(`OpenRouter request timed out after ${timeoutMs}ms`)
        : new ModelError(`OpenRouter request failed: ${(err as Error).message}`);
      return { ok: false, retry: true, error };
    } finally {
      clearTimeout(timer);
    }
  }

  let bodyText: string | undefined;
  for (let tries = 0; bodyText === undefined; tries++) {
    const outcome = await attempt();
    if (outcome.ok) {
      bodyText = outcome.bodyText;
    } else if (!outcome.retry || tries >= MAX_RETRIES) {
      throw outcome.error;
    } else {
      console.warn(`${outcome.error.message}; retrying (${tries + 1}/${MAX_RETRIES})`);
      // Wait a little longer before each retry to give a struggling upstream room to recover.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (tries + 1)));
    }
  }

  let data: { model?: string; choices?: { message?: { content?: string } }[] };
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new ModelError(`OpenRouter response was not valid JSON: ${bodyText}`);
  }
  // openrouter/free routes to whichever free model is available, so log which one answered.
  console.log(`checkText answered by ${data.model ?? "unknown model"}`);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new ModelError("OpenRouter response had no message content");
  }

  // Some models wrap JSON in ```json fences despite being told not to; strip them.
  const jsonText = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new UnusableReplyError("Model reply was not valid JSON", content);
  }

  if (!isCheckResult(parsed)) {
    throw new UnusableReplyError('Model reply did not match { result: "pass" | "flag", reasons: string[] }', content);
  }
  return { ...parsed, model: data.model ?? null };
}
