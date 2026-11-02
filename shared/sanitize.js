// Text that came from a PR or the sandbox is untrusted. In a public GitHub comment it must not be able to notify anyone,
// add images, links or HTML, or break out of the place we put it, so it goes inside a code block, one line per item.

export const quiet = (s) => String(s).replace(/@/g, '@\u{200B}'); // @mentions notify people
export const fence = (s) => String(s).replace(/```/g, "'''"); // no breaking out of a code block

// One line of visible text: no controls (newlines, terminal escapes), Unicode line separators or bidi overrides.
export const plain = (s) =>
  String(s)
    .toWellFormed()
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\u{202A}-\u{202E}\u{2066}-\u{2069}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Safe inside a Markdown code span. Nothing but a backtick or a newline can end one.
export const codeSpan = (s) => `\`${quiet(plain(s)).replace(/`/g, "'")}\``;

// Text an operator typed (a stop reason, an override reason). Trusted author, but it is treated as plain text everywhere: one
// line, no controls, nothing that notifies anyone or does anything in Markdown or HTML if it ever reaches a public comment.
// Safe to apply twice.
export const operatorText = (s, max = 200) =>
  quiet(plain(s ?? '').replace(/\u{200B}/gu, ''))
    .replace(/[`<>|[\]]/g, "'")
    .slice(0, max)
    .toWellFormed();
