export function formatLabResultDisplay(display: string): string {
  const head = display.split(':')[0]?.trim() ?? display
  if (head.includes('INR')) return 'INR'
  return ({
    '心脏肌钙蛋白I': '肌钙蛋白 I',
    '氨基末端B型利钠肽原': 'NT-proBNP',
  } as Record<string, string>)[head] ?? head
}

export function formatLabReferenceRange(text: string): string {
  return text.replace(/（合成院内参考区间）|\(synthetic.*?\)/gi, '').replace(/\s+1$/, '').trim()
}
