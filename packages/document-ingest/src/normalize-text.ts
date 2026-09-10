export function normalizeText(text: string): string {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, "\n");
}

export function hasUsableText(text: string): boolean {
  return text.trim().length > 0;
}
