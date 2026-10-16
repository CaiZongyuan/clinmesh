export function syntheticGuidelinePdf(pages: Array<string[] | { operators: string }>): Uint8Array<ArrayBuffer> {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [index, page] of pages.entries()) {
    let content = ''
    if (!Array.isArray(page)) content = page.operators
    else if (page.length > 0) {
      content = 'BT /F1 12 Tf 50 750 Td\n' + page.map((line, lineIndex) =>
        `${lineIndex === 0 ? '' : '0 -20 Td '}(${line.replace(/[\\()]/g, '\\$&')}) Tj\n`).join('') + 'ET\n'
    }
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`)
  }
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Uint8Array.from(Buffer.from(pdf))
}
