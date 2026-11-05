// Spoken confirm code. 0G only transcribes; this deterministic code decides (never an LLM).

/** Uniform random integer in 10..99 from crypto.getRandomValues (rejection sampling, no modulo bias). */
export function newConfirmCode(): number {
  const b = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(b);
    const v = b[0] ?? 255;
    if (v < 180) return 10 + (v % 90); // 180 = 2 * 90
  }
}

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const CONFIRM_WORDS = new Set(["confirm", "confirmed"]);
const CANCEL_WORDS = new Set(["cancel", "cancelled", "canceled", "stop", "dont", "no"]);

function normalise(transcript: string): string[] {
  return transcript
    .toLowerCase()
    .replace(/[‘’']/g, "") // don't -> dont
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ") // punctuation and hyphens -> space
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Collect the numbers spoken: "47", "forty seven", "forty-seven", "four seven", "4 7" all give 47. */
function numbers(words: string[]): number[] {
  const out: number[] = [];
  let digits = ""; // run of single digits ("four seven", "4 7")
  const flush = () => {
    if (digits) out.push(Number(digits));
    digits = "";
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (/^[0-9]+$/.test(w)) {
      if (w.length === 1) digits += w;
      else {
        flush();
        out.push(Number(w));
      }
    } else if (Object.hasOwn(ONES, w)) {
      digits += String(ONES[w]);
    } else if (Object.hasOwn(TEENS, w)) {
      flush();
      out.push(TEENS[w] ?? -1);
    } else if (Object.hasOwn(TENS, w)) {
      flush();
      const next = words[i + 1] ?? "";
      const unit = Object.hasOwn(ONES, next) && next !== "zero" ? ONES[next] : /^[1-9]$/.test(next) ? Number(next) : undefined;
      if (unit !== undefined) {
        out.push((TENS[w] ?? 0) + unit);
        i++;
      } else out.push(TENS[w] ?? -1);
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Rules (in order):
 * 1. Any cancel word ("cancel", "stop", "don't", "do not", "no") -> "cancelled", even next to the code.
 * 2. "confirm" (or "confirmed", a common transcription) + the exact code, and no other number -> "confirmed".
 * 3. Anything else (wrong code, code without "confirm", "confirm" without code, silence) -> "unclear".
 */
export function matchConfirm(transcript: string, code: number): "confirmed" | "cancelled" | "unclear" {
  const words = normalise(typeof transcript === "string" ? transcript : "");
  if (words.some((w) => CANCEL_WORDS.has(w))) return "cancelled";
  for (let i = 0; i + 1 < words.length; i++) if (words[i] === "do" && words[i + 1] === "not") return "cancelled";
  if (!words.some((w) => CONFIRM_WORDS.has(w))) return "unclear";
  const nums = numbers(words);
  return nums.length > 0 && nums.every((n) => n === code) ? "confirmed" : "unclear";
}
