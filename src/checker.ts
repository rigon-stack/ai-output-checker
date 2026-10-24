const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is not set. Copy .env.example to .env and fill it in.");
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

export type CheckResult = { result: "pass" | "flag"; reasons: string[] };

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

export async function checkText(text: string, rules: string[]): Promise<CheckResult> {
  const userPrompt = `Rules:\n${rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n")}\n\nText:\n${text}`;

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("OpenRouter response had no message content");
  }

  // Some models wrap JSON in ```json fences despite being told not to; strip them.
  const jsonText = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Model reply was not valid JSON: ${content}`);
  }

  if (!isCheckResult(parsed)) {
    throw new Error(`Model reply did not match { result: "pass" | "flag", reasons: string[] }: ${content}`);
  }
  return parsed;
}
