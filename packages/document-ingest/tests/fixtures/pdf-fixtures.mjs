const encoder = new TextEncoder();

export function createTextPdf(pageLines) {
  const fontObjectNumber = 3 + pageLines.length * 2;
  const objects = new Array(fontObjectNumber + 1);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pageLines.length} /Kids [${pageLines
    .map((_, index) => `${3 + index * 2} 0 R`)
    .join(" ")}] >>`;

  pageLines.forEach((lines, index) => {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const stream = contentStream(lines);
    objects[pageObjectNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> ` +
      `/Contents ${contentObjectNumber} 0 R >>`;
    objects[contentObjectNumber] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontObjectNumber] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (let objectNumber = 1; objectNumber < objects.length; objectNumber += 1) {
    offsets[objectNumber] = Buffer.byteLength(document);
    document += `${objectNumber} 0 obj\n${objects[objectNumber]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let objectNumber = 1; objectNumber < objects.length; objectNumber += 1) {
    document += `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(document);
}

export function malformedPdfBytes() {
  return encoder.encode("%PDF-1.4\nthis is not a valid PDF document");
}

// Source: mozilla/pdf.js test/pdfs/encrypted-attachment.pdf at
// 716aff9d50c08b4bec3e350540a3f05aea89dedc (Apache-2.0).
export function encryptedPdfBytes() {
  return new Uint8Array(
    Buffer.from(
      "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDcwNzk3MDY0NjY+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCi9OYW1lcyAxMCAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQovQ29udGVudHMgNSAwIFIKL1Jlc291cmNlcyA8PAovUHJvY1NldCA2IDAgUgovRm9udCA8PAovRjEgNyAwIFIKPj4KPj4KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovTGVuZ3RoIDQ0Cj4+CnN0cmVhbQpCVAogIC9GMSAyNCBUZgogIDcyIDcyMCBUZAogIChFeGFtcGxlKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKWyAvUERGIC9UZXh0IF0KZW5kb2JqCjcgMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9OYW1lIC9GMQovQmFzZUZvbnQgL0hlbHZldGljYQovRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZwo+PgplbmRvYmoKOCAwIG9iago8PAovVHlwZSAvRW1iZWRkZWRGaWxlCi9GaWx0ZXIgWyAvQ3J5cHQgXQovRGVjb2RlUGFybXMgWyA8PAovTmFtZSAvU3RkQ0YKPj4gXQovTGVuZ3RoIDc4NAo+PgpzdHJlYW0KPOQED0QMWXPqO14uNPrmubmVIujJLlS2PquQV8uD4OQH6+iI9672uhmBw/LgWjuwgXO9YzQaPcW23lVNymfdHiE3Q1NEpsG6NJiMat5fvF9cdXfduo+8qwBZM3aQxIvLQbvEYxy+aw8Dc2Ejc2vbkCoM+CS8dgrnn3I1+kiovX8yuDHuuHMKpeorcC1WjRL4MCSTgM4V9lVIBinRfgu5vjWGhUMH05LMe3g42EkGFadcZ48BOnXewZIsJq9eBRRTd5z8iiLC/47OWqowvqTPp/TwgxAgaXvPk6eATHsXIAOvqQ9hfq5Mphyrlv/aSTtaTREFXeKB9cEMpINaKvTaJLbqWLCgGUoKTx50OIUIWOrBiDNBbE4cQMTIemfrO2BfpNfXGDMESF1LDT0sCqfAGL4xAOBti4Do8mQqgJIhNVx9qWCvH91JGprwQvppG956RqhiC9747Yw+PyMLPUaY81eKLSextj1Ai0I97fN7FSJAkczAypQiWlStW1HZsMog12TFoSIwG35+zDimK03Fya8ptLCGjOlTSzES/Fh8XIEtxBltPA8Tt+v7gGBabXqcT2Q6cFGs+ggf6E2FdadJaGJoWbkX2Swsw4+e3+L3JrgI4kG2DBwqPh+GJSD+w1f2jyeAICqZ5hQTDT7suAiprG34CwuLfCEfnwpHXicSl8H7s90pWh0fbIudw2V7wAXHgNTrEILWRW74w2WkfjDBooEjBfmEKf86GdHk8mPXnIQHoi3i0+VQeo2CU9puMq1KYER0ucXNYTswGGOswuVk+xqFvwe5ZIx37NTv0jIAO24a5IMc1SUmn5JyR33i4gyJrvrV2i04WZCu/0AHXIq1dFCJOhfNmyJzbHunUmEEht6ym6YLP+BKRqjLPTidilaG952HGz5shfB3WenanckEU2pEF1a8lbkhBWyRIjsqluNZwY+fo1q6BNAVyJbZIdIaYY77s4FZPmbqN5ITRMKcQ7aA9ccX7kpAFPHm5MJGYmJxxnMQHmBCDkJotpCJat2jjsICbSu9rFzaRX8FjsTU5QplbmRzdHJlYW0KZW5kb2JqCjkgMCBvYmoKPDwKL1R5cGUgL0ZpbGVzcGVjCi9GIDw2MTc0NzQ2MTYzNjg2ZDY1NmU3NDJlNzA2NDY2PgovRUYgPDwKL0YgOCAwIFIKPj4KPj4KZW5kb2JqCjEwIDAgb2JqCjw8Ci9FbWJlZGRlZEZpbGVzIDExIDAgUgo+PgplbmRvYmoKMTEgMCBvYmoKPDwKL05hbWVzIFsgPDYxNzQ3NDYxNjM2ODZkNjU2ZTc0MmU3MDY0NjY+IDkgMCBSIF0KPj4KZW5kb2JqCjEyIDAgb2JqCjw8Ci9WIDUKL1IgNgovTGVuZ3RoIDI1NgovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDxmNjM3ZjVhZTIyMTMxOGU1Yjk5MzA2NTJiYjY4Yjg2MmIwNjRkYTlhOTg4YTdkZDYyZDA3Zjk0Y2U0M2ZhMzQ3YmQ1ODQwZmY4NDNkMzFlYTNlNWJhZTFlODk1NzY1NTE+Ci9VIDxmODdmNDdmMTNlZTBiMTE3NmUzZjI4NDg1MzY4NTJhZWIyZGQzZWFmZDdmOWM4YThiZjM4NWE1YThlYWEzMWRhNDczOTEwYzQwNjBlZDY4NGY1NjgxOGU5ZWEzMTAxNGU+Ci9DRiA8PAovU3RkQ0YgPDwKL0NGTSAvQUVTVjMKL0xlbmd0aCAzMgo+Pgo+PgovU3RtRiAvSWRlbnRpdHkKL1N0ckYgL0lkZW50aXR5Ci9PRSA8YTFkZmU0NDE3NTdhNzQ4Y2M0YTk5OGNjOWEzZWJjMWVjMjA3YjhmM2MwZDQ2ZWFjYmYwYTdjM2EwMDkzODRmNz4KL1VFIDxhNzM2MTIzNzc3YjNmZTA3MTA0MTg2N2U4Y2RiNzE0OTQ0M2ViMDgxYzFiOWIxMWFiZGI0ZjFmYTcyZTNhOWIyPgovUGVybXMgPGNmMmQzZGVmZTk0OGI2Y2RjZDk5YWE1YTg5ZThiZTA4PgovRUZGIC9TdGRDRgo+PgplbmRvYmoKeHJlZgowIDEzCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE4MSAwMDAwMCBuIAowMDAwMDAwMzI0IDAwMDAwIG4gCjAwMDAwMDA0MTggMDAwMDAgbiAKMDAwMDAwMDQ0OCAwMDAwMCBuIAowMDAwMDAwNTU1IDAwMDAwIG4gCjAwMDAwMDE0NjUgMDAwMDAgbiAKMDAwMDAwMTU1NSAwMDAwMCBuIAowMDAwMDAxNTk5IDAwMDAwIG4gCjAwMDAwMTY2OSAwMDAwMCBuIAowMDAwMDAwMTY2OSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDEzCi9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDw2NjY2NjY2NjMwMzMzOTMxNjY2NjEzOTM2NjMzMTYzMzg2NDMyNjIzNDM4Mzg2NjM2NjE2MTMyNjI2MzM0MzkzOT4gPDY2NjY2NjY2MzAzMzM5MzE2NjYxMzkzNjYzMzE2MzM4NjQzMjYyNjIzNDM4Mzg2NjM2NjE2MTMyNjI2MzM0MzkzOT4gXQovRW5jcnlwdCAxMiAwIFIKPj4Kc3RhcnR4cmVmCjIyNDIKJSVFT0YK",
      "base64",
    ),
  );
}

function contentStream(lines) {
  const commands = ["BT", "/F1 12 Tf", "72 720 Td"];
  lines.forEach((line, index) => {
    commands.push(`(${escapePdfText(line)}) Tj`);
    if (index < lines.length - 1) {
      commands.push("0 -18 Td");
    }
  });
  commands.push("ET");
  return commands.join("\n");
}

function escapePdfText(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}
