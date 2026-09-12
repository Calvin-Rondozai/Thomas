const PDFDocument = require('pdfkit');

// Single accent colour used consistently for section headings and the skills table
// header cells, per the "minimal colours" rule in the candidate's profile.
const ACCENT = '#8B2E2E';
const TEXT = '#1a1a1a';
const MUTED = '#555555';

function ensureSpace(doc, neededHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) doc.addPage();
}

function sectionHeader(doc, title) {
  ensureSpace(doc, 34);
  doc.moveDown(0.6);
  doc.fontSize(13).font('Helvetica-Bold').fillColor(ACCENT).text(title.toUpperCase());
  const y = doc.y + 1;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor(ACCENT)
    .lineWidth(1)
    .stroke();
  doc.y = y + 8;
  doc.font('Helvetica').fillColor(TEXT);
}

function subsectionHeader(doc, title) {
  ensureSpace(doc, 20);
  doc.moveDown(0.25);
  doc.fontSize(10).font('Helvetica-Bold').fillColor(ACCENT).text(title);
  doc.font('Helvetica').fillColor(TEXT);
  doc.moveDown(0.1);
}

function bullet(doc, text) {
  ensureSpace(doc, 14);
  doc.fontSize(9.5).font('Helvetica').fillColor(TEXT).text(`•  ${text}`, { indent: 10, align: 'left' });
}

/** Draws the CV's content into an already-open PDFDocument (no border around the header). */
function drawCvContent(doc, cv) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(20).font('Helvetica-Bold').fillColor(TEXT).text(cv.name || '', { align: 'center' });
  if (cv.title) {
    doc.fontSize(10).font('Helvetica-Bold').fillColor(ACCENT).text((cv.title || '').toUpperCase(), { align: 'center' });
  }
  if (cv.contact) {
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(cv.contact, { align: 'center' });
  }
  if (cv.links) {
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(cv.links, { align: 'center' });
  }
  doc.moveDown(0.5);
  doc.fillColor(TEXT).font('Helvetica');

  if (cv.summary) {
    sectionHeader(doc, 'Profile');
    doc.fontSize(9.5).font('Helvetica').fillColor(TEXT).text(cv.summary, { align: 'justify' });
  }

  if (cv.experience?.length) {
    sectionHeader(doc, 'Professional Experience');
    cv.experience.forEach((exp) => {
      ensureSpace(doc, 32);
      doc
        .fontSize(10.5)
        .font('Helvetica-Bold')
        .fillColor(TEXT)
        .text(`${exp.role || ''}${exp.employer ? ' - ' + exp.employer : ''}`);
      if (exp.dates) {
        doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(exp.dates);
      }
      doc.font('Helvetica').fillColor(TEXT);
      doc.moveDown(0.2);

      if (exp.subsections?.length) {
        exp.subsections.forEach((sub) => {
          subsectionHeader(doc, sub.heading);
          (sub.bullets || []).forEach((b) => bullet(doc, b));
        });
      } else {
        (exp.bullets || []).forEach((b) => bullet(doc, b));
      }
      doc.moveDown(0.4);
    });
  }

  if (cv.keyProjects?.length) {
    sectionHeader(doc, 'Key Projects and Portfolio');
    cv.keyProjects.forEach((p) => bullet(doc, p));
  }

  const skillsRows = cv.skillsTable?.length ? cv.skillsTable : (cv.skills || []).map((s) => ({ category: s, description: '' }));
  if (skillsRows.length) {
    sectionHeader(doc, 'Technical Skills');
    const labelWidth = 150;
    const descWidth = pageWidth - labelWidth - 10;
    skillsRows.forEach((row) => {
      // A long category name (e.g. "Software Engineering and DevOps") can wrap to two
      // lines in the narrower label column - the row must be tall enough for whichever
      // of the label or the description needs more room, not just the description.
      const labelHeight = doc.heightOfString(row.category || '', { width: labelWidth - 16, fontSize: 9 });
      const descHeight = doc.heightOfString(row.description || '', { width: descWidth - 12, fontSize: 9 });
      const rowHeight = Math.max(22, labelHeight + 12, descHeight + 12);
      ensureSpace(doc, rowHeight + 4);
      const rowTop = doc.y;
      doc.rect(doc.page.margins.left, rowTop, labelWidth, rowHeight).fill(ACCENT);
      doc.rect(doc.page.margins.left + labelWidth, rowTop, descWidth, rowHeight).strokeColor('#cccccc').lineWidth(0.5).stroke();
      doc
        .fillColor('#ffffff')
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(row.category || '', doc.page.margins.left + 8, rowTop + 6, { width: labelWidth - 16 });
      if (row.description) {
        doc
          .fillColor(TEXT)
          .font('Helvetica')
          .fontSize(9)
          .text(row.description, doc.page.margins.left + labelWidth + 6, rowTop + 6, { width: descWidth - 12 });
      }
      doc.y = rowTop + rowHeight + 3;
      doc.x = doc.page.margins.left;
    });
    doc.moveDown(0.3);
  }

  if (cv.education?.length) {
    sectionHeader(doc, 'Education');
    cv.education.forEach((ed) => {
      ensureSpace(doc, 30);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(TEXT).text(ed.qualification || '');
      if (ed.institution) {
        doc.fontSize(9).font('Helvetica-Oblique').fillColor(MUTED).text(ed.institution);
      }
      if (ed.dates) {
        doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(ed.dates);
      }
      doc.font('Helvetica').fillColor(TEXT);
      doc.moveDown(0.3);
    });
  }

  if (cv.certifications?.length) {
    sectionHeader(doc, 'Certifications');
    cv.certifications.forEach((cert) => {
      const main = typeof cert === 'string' ? cert : cert.main;
      const subs = typeof cert === 'string' ? [] : cert.subs || [];
      bullet(doc, main || '');
      subs.forEach((s) => {
        ensureSpace(doc, 14);
        doc.fontSize(9).font('Helvetica').fillColor(TEXT).text(s, { indent: 24 });
      });
    });
  }

  if (cv.personalDetails) {
    sectionHeader(doc, 'Personal Details');
    doc.fontSize(9.5).font('Helvetica').fillColor(TEXT).text(cv.personalDetails);
  }

  if (cv.references?.length) {
    sectionHeader(doc, 'References');
    cv.references.forEach((ref) => {
      ensureSpace(doc, 16);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(TEXT).text(ref.name || '', { continued: true });
      doc
        .font('Helvetica')
        .fillColor(TEXT)
        .text(`, ${ref.title || ''}${ref.phone ? ' | ' + ref.phone : ''}`);
    });
  }
}

/** Draws the cover letter's content into an already-open PDFDocument. */
function drawCoverLetterContent(doc, text) {
  const lines = (text || '').split('\n');
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      // pdfkit's .text('') does not advance the cursor at all, so a blank source
      // line (paragraph/address-block spacing) has to be an explicit moveDown.
      doc.moveDown(0.6);
      return;
    }
    const isReLine = /^RE:/i.test(line);
    if (isReLine) doc.moveDown(0.3);
    doc
      .fontSize(11)
      .font(isReLine ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor('#000000')
      .text(line, { align: 'justify', underline: isReLine });
    if (isReLine) doc.moveDown(0.3);
  });
}

function generateCvPdf(cv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawCvContent(doc, cv);
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
    drawCoverLetterContent(doc, text);
    doc.end();
  });
}

/** Cover letter followed by the CV, as a single combined PDF (what actually gets emailed). */
function generateApplicationPdf({ coverLetterText, cv }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawCoverLetterContent(doc, coverLetterText);
    doc.addPage({ margin: 42 });
    drawCvContent(doc, cv);

    doc.end();
  });
}

module.exports = { generateCvPdf, generateCoverLetterPdf, generateApplicationPdf };
