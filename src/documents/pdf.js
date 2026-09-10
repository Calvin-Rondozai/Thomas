const PDFDocument = require('pdfkit');

function sectionHeader(doc, title) {
  doc.moveDown(0.4);
  doc.fontSize(13).fillColor('#1a1a1a').text(title, { underline: true });
  doc.moveDown(0.2);
}

function generateCvPdf(cv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#000').text(cv.name || '');
    if (cv.title) doc.fontSize(12).fillColor('#555').text(cv.title);
    if (cv.contact) doc.fontSize(10).fillColor('#555').text(cv.contact);

    if (cv.summary) {
      sectionHeader(doc, 'Summary');
      doc.fontSize(10).fillColor('#000').text(cv.summary);
    }

    if (cv.experience?.length) {
      sectionHeader(doc, 'Experience');
      cv.experience.forEach((exp) => {
        doc.fontSize(11).fillColor('#000').text(`${exp.role || ''}${exp.employer ? ' - ' + exp.employer : ''}`);
        if (exp.dates) doc.fontSize(9).fillColor('#555').text(exp.dates);
        (exp.bullets || []).forEach((b) => doc.fontSize(10).fillColor('#000').text(`•  ${b}`, { indent: 10 }));
        doc.moveDown(0.4);
      });
    }

    if (cv.education?.length) {
      sectionHeader(doc, 'Education');
      cv.education.forEach((ed) => {
        doc.fontSize(10).fillColor('#000').text(`${ed.qualification || ''}${ed.institution ? ' - ' + ed.institution : ''}`);
        if (ed.dates) doc.fontSize(9).fillColor('#555').text(ed.dates);
        doc.moveDown(0.2);
      });
    }

    if (cv.skills?.length) {
      sectionHeader(doc, 'Skills');
      doc.fontSize(10).fillColor('#000').text(cv.skills.join(' • '));
    }

    doc.end();
  });
}

function generateCoverLetterPdf(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(11).fillColor('#000').text(text || '', { align: 'left' });
    doc.end();
  });
}

module.exports = { generateCvPdf, generateCoverLetterPdf };
