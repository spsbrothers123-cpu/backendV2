import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

/**
 * Shared export generation used by every "Export" button across the Admin
 * app (Expenses, Purchases, Customers, Reports). Deliberately has no
 * knowledge of Prisma/business models — routes build plain rows/columns
 * and hand them here, so this file can be reused for any future export
 * without ever touching this module again.
 */

export type ExportFileFormat = "excel" | "csv" | "pdf";

export interface ExportColumn {
  /** Key looked up on each row object. */
  key: string;
  /** Column header shown in the file. */
  header: string;
  /** Excel column width (ignored for CSV/PDF). */
  width?: number;
}

// ── Filenames & content types ──────────────────────────────────────────

/**
 * Builds a meaningful, filesystem-safe filename:
 * "<Shop_Name>_<Entity>_<yyyy-mm-dd>.<ext>" — e.g.
 * "RBR_Egg_Mart_Expenses_2026-09-04.xlsx".
 */
export function buildExportFilename(shopName: string, entity: string, ext: string): string {
  const slug = (value: string) =>
    value.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Untitled";
  const date = new Date().toISOString().slice(0, 10);
  return `${slug(shopName)}_${slug(entity)}_${date}.${ext}`;
}

export function extensionFor(format: ExportFileFormat): string {
  return format === "excel" ? "xlsx" : format;
}

export function contentTypeFor(format: ExportFileFormat): string {
  switch (format) {
    case "excel":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv":
      return "text/csv; charset=utf-8";
    case "pdf":
      return "application/pdf";
  }
}

// ── Flat single-table exports (Expenses / Purchases / Customers) ───────

/** Builds a single-sheet .xlsx workbook from column defs + row objects. */
export async function buildExcelBuffer(
  sheetName: string,
  columns: ExportColumn[],
  rows: Record<string, unknown>[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Egg Mart POS";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet((sheetName || "Sheet1").slice(0, 31));
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 20 }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** Builds a CSV buffer (CRLF line endings, RFC-4180 style quoting). */
export function buildCsvBuffer(columns: ExportColumn[], rows: Record<string, unknown>[]): Buffer {
  const lines = [columns.map((c) => csvEscape(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c.key])).join(","));
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

// ── Report exports (summary + optional breakdown/trend tables) ─────────

export interface ReportTable {
  /** Sheet name (Excel) / table title (PDF). Not used for CSV. */
  title: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
}

export interface ReportExportPayload {
  /** Shown as a "Metric | Value" table — always present, even if short. */
  summary: { label: string; value: string }[];
  /** Extra breakdown/trend tables — rendered as extra sheets (Excel) or extra sections (PDF). Ignored for CSV. */
  tables?: ReportTable[];
}

/** Multi-sheet workbook: "Summary" sheet + one sheet per extra table. */
export async function buildReportExcelBuffer(payload: ReportExportPayload): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Egg Mart POS";
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Metric", key: "label", width: 28 },
    { header: "Value", key: "value", width: 22 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  for (const row of payload.summary) summarySheet.addRow(row);

  for (const table of payload.tables ?? []) {
    const sheet = workbook.addWorksheet(table.title.slice(0, 31));
    sheet.columns = table.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 20 }));
    sheet.getRow(1).font = { bold: true };
    for (const row of table.rows) sheet.addRow(row);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** CSV can only hold one flat table, so a report export flattens to its Metric/Value summary. */
export function buildReportCsvBuffer(payload: ReportExportPayload): Buffer {
  return buildCsvBuffer(
    [{ key: "label", header: "Metric" }, { key: "value", header: "Value" }],
    payload.summary
  );
}

/** Simple narrative PDF: title + subtitle, a summary block, then one section per extra table. */
export async function buildReportPdfBuffer(
  title: string,
  subtitle: string,
  payload: ReportExportPayload
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 42, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.font("Helvetica-Bold").fontSize(18).fillColor("#1a1a1a").text(title);
      doc.font("Helvetica").fontSize(10).fillColor("#666666").text(subtitle);
      doc.moveDown(1);
      doc.fillColor("#000000");

      doc.font("Helvetica-Bold").fontSize(13).text("Summary");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(10.5);
      for (const row of payload.summary) {
        doc.text(`${row.label}: ${row.value}`);
      }

      for (const table of payload.tables ?? []) {
        doc.moveDown(1);
        doc.font("Helvetica-Bold").fontSize(13).text(table.title);
        doc.moveDown(0.3);
        doc.font("Helvetica-Bold").fontSize(10).text(table.columns.map((c) => c.header).join("   |   "));
        doc.font("Helvetica").fontSize(10);
        for (const row of table.rows) {
          doc.text(table.columns.map((c) => String(row[c.key] ?? "")).join("   |   "));
        }
      }

      if ((payload.tables ?? []).every((t) => t.rows.length === 0) && payload.summary.length === 0) {
        doc.moveDown(1);
        doc.font("Helvetica-Oblique").fontSize(10).fillColor("#666666").text("No data available for this period.");
      }

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}
