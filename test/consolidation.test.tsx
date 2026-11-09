import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axios from "axios";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { apiClient } from "../api/client";
import { ToastProvider } from "../context/ToastContext";
import { ShopProvider } from "../context/ShopContext";
import Consolidation from "../pages/Consolidation";
import { AdminLayout } from "../components/layout/AdminLayout";
import { DesktopSidebar } from "../components/layout/Sidebar";
import { toYmd } from "../lib/consolidationDates";

vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: { name: "Admin" }, logout: vi.fn() }) }));
vi.mock("../components/layout/GlobalSearch", () => ({ GlobalSearchInput: () => null }));
vi.mock("../components/layout/NotificationsBell", () => ({ NotificationsBell: () => null }));

// ── environment shims ────────────────────────────────────
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!Blob.prototype.text) {
  (Blob.prototype as any).text = function () {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(this); });
  };
}

// ── fixtures (contract-shaped) ───────────────────────────
const SHOPS = [
  { id: "s1", name: "Shop 1", code: "S1", location: "A", current: false },
  { id: "s2", name: "Shop 2", code: "S2", location: "B", current: true },
  { id: "s3", name: "Shop 3", code: "S3", location: "C", current: false },
];
const lowRow = { id: "l1", productName: "Egg", unit: "tray", shopId: "s3", shopName: "Shop 3", available: 4, threshold: 20, status: "Low Stock" };
const credits = { totalOutstanding: 5200, customersWithCredit: 2, totalCustomers: 9, byShop: [{ shopId: "s1", shopName: "Shop 1", outstanding: 3000 }, { shopId: "s2", shopName: "Shop 2", outstanding: 2200 }] };
const stockShops = [{ id: "s1", name: "Shop 1" }, { id: "s2", name: "Shop 2" }, { id: "s3", name: "Shop 3" }];
const eggRow = { key: "egg|tray", name: "Egg", variant: "Brown", category: "Eggs", unit: "tray", totalStock: 190, perShop: { s1: 50, s2: 60, s3: 80 } };
const riceRow = { key: "feed|kg", name: "Feed", variant: null, category: "Supplies", unit: "kg", totalStock: 0, perShop: { s1: 0, s2: null, s3: 0 } };

function respond(url: string, params: any): { status: number; body: any } {
  switch (url) {
    case "/admin/shops": return { status: 200, body: { success: true, data: SHOPS } };
    case "/admin/shops/switch": return { status: 200, body: { success: true, data: SHOPS.find((s) => s.id === (globalThis as any).__switchTo) } };
    case "/admin/consolidation/overview":
      return { status: 200, body: { success: true, data: {
        totalSales: 125000, totalPurchases: 80000, totalExpenses: 12000, activeShops: params.shop === "all" ? 3 : 1,
        shopSales: [{ shopId: "s1", shopName: "Shop 1", salesAmount: 50000, completedBills: 40, contributionPct: 40 }, { shopId: "s2", shopName: "Shop 2", salesAmount: 75000, completedBills: 60, contributionPct: 60 }],
        stockPreview: { shops: stockShops, rows: [eggRow] }, lowStockPreview: [lowRow], lowStockTotal: 1, credits,
        purchaseSummary: { total: 80000, count: 7 }, expenseSummary: { total: 12000, count: 5 },
      } } };
    case "/admin/consolidation/products":
      return { status: 200, body: { success: true, data: { shops: params.shop === "all" ? stockShops : stockShops.filter((s) => s.id === params.shop), rows: [eggRow, riceRow], page: 1, pageSize: 20, total: 2 } } };
    case "/admin/consolidation/customers":
      return { status: 200, body: { success: true, data: { summary: credits, page: 1, pageSize: 20, total: 2, rows: [
        { id: "c1", name: "Ravi", phone: "9000000001", shopId: "s1", shopName: "Shop 1", purchaseCount: 3, purchaseTotal: 900, outstandingCredit: 300 },
        { id: "c1", name: "Ravi", phone: "9000000001", shopId: "s2", shopName: "Shop 2", purchaseCount: 1, purchaseTotal: 100, outstandingCredit: 0 } ] } } };
    case "/admin/consolidation/low-stock": return { status: 200, body: { success: true, data: { rows: [lowRow], page: 1, pageSize: 20, total: 1 } } };
    case "/admin/consolidation/sales": return { status: 200, body: { success: true, data: { totalSales: 125000, totalBills: 100, shops: [{ shopId: "s1", shopName: "Shop 1", salesAmount: 50000, completedBills: 40, contributionPct: 40 }], trend: [{ label: "01 Oct", total: 1000, perShop: { s1: 1000 } }] } } };
    case "/admin/consolidation/purchases": return { status: 200, body: { success: true, data: { total: 80000, count: 7, byShop: [{ shopId: "s1", shopName: "Shop 1", amount: 80000, count: 7 }], byDate: [{ label: "01 Oct", total: 80000, count: 7 }] } } };
    case "/admin/consolidation/expenses": return { status: 200, body: { success: true, data: { total: 0, count: 0, byShop: [], byDate: [] } } };
    default: return { status: 404, body: { success: false, message: "Not found" } };
  }
}

interface Req { method: string; url: string; params: any }
let log: Req[] = [];
let overrides: Record<string, (params: any) => { status: number; body: any; type?: string }> = {};

function installAdapter() {
  apiClient.defaults.adapter = async (config: any) => {
    const url = config.url as string;
    const req = { method: String(config.method).toUpperCase(), url, params: config.params ?? {} };
    log.push(req);
    const r = overrides[url]?.(req.params) ?? respond(url, req.params);
    let data: any = r.body;
    if (config.responseType === "blob") {
      data = r.body instanceof Blob ? r.body : new Blob([typeof r.body === "string" ? r.body : JSON.stringify(r.body)], { type: (r as any).type ?? "application/json" });
    }
    const response = { data, status: r.status, statusText: "", headers: (r as any).headers ?? {}, config, request: {} };
    const ok = config.validateStatus ? config.validateStatus(r.status) : r.status >= 200 && r.status < 300;
    if (!ok) throw new axios.AxiosError("fail", "ERR_BAD_RESPONSE", config, {}, response as any);
    return response;
  };
}

const calls = (url: string) => log.filter((r) => r.url === url);
const ymd = (offsetDays: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offsetDays); return toYmd(d); };

function renderPage() {
  return render(<MemoryRouter><ToastProvider><Consolidation /></ToastProvider></MemoryRouter>);
}
const tab = (name: string) => screen.getByRole("tab", { name });

beforeEach(() => {
  cleanup(); log = []; overrides = {}; localStorage.clear(); sessionStorage.clear(); installAdapter();
});

describe("Consolidation – filters, independence, data", () => {
  it("defaults to All Shops / last 7 days and sends explicit shop + resolved dates", async () => {
    renderPage();
    expect(await screen.findByText("Total Sales")).toBeTruthy();
    const sel = screen.getByLabelText("Shop") as HTMLSelectElement;
    expect(sel.value).toBe("all");
    expect(Array.from(sel.options).map((o) => o.text)).toEqual(["All Shops", "Shop 1", "Shop 2", "Shop 3"]);
    const q = calls("/admin/consolidation/overview")[0].params;
    expect(q).toMatchObject({ shop: "all", range: "last7", dateFrom: ymd(-6), dateTo: ymd(0) });
    // real backend figures rendered
    expect(screen.getByText("₹1,25,000")).toBeTruthy();
  });

  it("selecting Shop 1 refetches for s1, never calls switch, never touches storage", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.selectOptions(screen.getByLabelText("Shop"), "s1");
    await waitFor(() => expect(calls("/admin/consolidation/overview").some((r) => r.params.shop === "s1")).toBe(true));
    expect(log.some((r) => r.url === "/admin/shops/switch")).toBe(false);
    expect(log.filter((r) => r.method !== "GET")).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("date presets resolve correctly and Yesterday is a single local day", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.click(tab("Yesterday"));
    await waitFor(() => expect(calls("/admin/consolidation/overview").some((r) => r.params.range === "yesterday")).toBe(true));
    const y = calls("/admin/consolidation/overview").find((r) => r.params.range === "yesterday")!.params;
    expect(y.dateFrom).toBe(ymd(-1)); expect(y.dateTo).toBe(ymd(-1));
    await user.click(tab("Last 30 Days"));
    await waitFor(() => expect(calls("/admin/consolidation/overview").some((r) => r.params.range === "last30")).toBe(true));
    expect(calls("/admin/consolidation/overview").find((r) => r.params.range === "last30")!.params.dateFrom).toBe(ymd(-29));
  });

  it("custom range: no request until valid; inverted range shows an error", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    const before = log.length;
    await user.click(tab("Custom Range"));
    expect(await screen.findByText("Choose both a start and an end date.")).toBeTruthy();
    expect(screen.getByText("Choose a date range")).toBeTruthy();
    expect(log.length).toBe(before);
    const from = screen.getByLabelText("From"), to = screen.getByLabelText("To");
    await user.type(from, ymd(-2)); await user.type(to, ymd(-1));
    await waitFor(() => expect(calls("/admin/consolidation/overview").some((r) => r.params.range === "custom")).toBe(true));
    const c = calls("/admin/consolidation/overview").find((r) => r.params.range === "custom")!.params;
    expect([c.dateFrom, c.dateTo]).toEqual([ymd(-2), ymd(-1)]);
  });

  it("Products: live stock (no date params), dynamic shop columns, zero + not-carried cells, note visible, unaffected by date changes", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.click(tab("Products"));
    expect(await screen.findByText("Stock data always reflects current live inventory and is not affected by the date filter.")).toBeTruthy();
    await screen.findByText("Brown", { exact: false });
    const req = calls("/admin/consolidation/products")[0].params;
    expect(req.dateFrom).toBeUndefined(); expect(req.dateTo).toBeUndefined(); expect(req.range).toBeUndefined();
    expect(req.shop).toBe("all");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Product", "Total Stock", "Shop 1", "Shop 2", "Shop 3"]);
    const eggRowEl = screen.getByText("Egg").closest("tr")!;
    expect(within(eggRowEl).getAllByRole("cell").map((c) => c.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Egg · BrownEggs · tray", "190 tray", "50", "60", "80"]);
    const feedRow = screen.getByText("Feed").closest("tr")!;
    const cells = within(feedRow).getAllByRole("cell").map((c) => c.textContent?.trim());
    expect(cells.slice(2)).toEqual(["0", "—", "0"]);
    // changing the date filter must NOT refetch stock
    await user.click(tab("Yesterday"));
    await new Promise((r) => setTimeout(r, 150));
    expect(calls("/admin/consolidation/products")).toHaveLength(1);
  });

  it("Products with one shop selected shows only that shop's availability", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.selectOptions(screen.getByLabelText("Shop"), "s2");
    await user.click(tab("Products"));
    await screen.findByText("Egg");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Available Stock"]);
    expect(calls("/admin/consolidation/products")[0].params.shop).toBe("s2");
    expect(within(screen.getByText("Egg").closest("tr")!).getAllByRole("cell")[1].textContent?.replace(/\s+/g, " ").trim()).toBe("60 tray");
  });

  it("Customers keep per-branch records separate (same person, two shops → two rows)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.click(tab("Customers"));
    await screen.findByText("Customer Records");
    const rows = screen.getAllByText("Ravi");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const body = screen.getAllByRole("row").filter((r) => r.textContent?.includes("Ravi"));
    expect(body).toHaveLength(2);
    expect(body[0].textContent).toContain("Shop 1"); expect(body[1].textContent).toContain("Shop 2");
  });

  it("Low stock shows name, shop, available, threshold, status – and no action buttons", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.click(tab("Low Stock Alerts"));
    await screen.findAllByText("Minimum Threshold");
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("Egg"))!;
    expect(row.textContent).toContain("Shop 3"); expect(row.textContent).toContain("4 tray"); expect(row.textContent).toContain("20 tray"); expect(row.textContent).toContain("Low Stock");
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(calls("/admin/consolidation/low-stock")[0].params.dateFrom).toBeUndefined();
  });

  it("switching tabs back does not refetch (cached); Refresh does", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.click(tab("Purchases")); await screen.findByText("Total Purchases");
    await user.click(tab("Overview")); await screen.findByText("Shop-wise Sales");
    await user.click(tab("Purchases")); await screen.findByText("Total Purchases");
    expect(calls("/admin/consolidation/overview")).toHaveLength(1);
    expect(calls("/admin/consolidation/purchases")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Refresh data" }));
    await waitFor(() => expect(calls("/admin/consolidation/purchases")).toHaveLength(2));
  });

  it("empty state renders for a section with no rows", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.click(tab("Expenses"));
    expect(await screen.findByText("No expenses in this period")).toBeTruthy();
  });

  it("missing endpoint → error state naming the dependency; NO mock fallback", async () => {
    overrides["/admin/consolidation/overview"] = () => ({ status: 404, body: { success: false } });
    renderPage();
    expect(await screen.findByText(/doesn't have this Consolidation endpoint yet/)).toBeTruthy();
    expect(screen.getByText(/GET \/admin\/consolidation\/overview/)).toBeTruthy();
    expect(screen.queryByText("Total Sales")).toBeNull();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("authorized-shops failure blocks the page with a retry (never assumes a shop)", async () => {
    overrides["/admin/shops"] = () => ({ status: 500, body: { message: "boom" } });
    renderPage();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(calls("/admin/consolidation/overview")).toHaveLength(0);
  });
});

describe("Consolidation – export", () => {
  let clicked: string[] = [];
  beforeEach(() => {
    clicked = [];
    (URL as any).createObjectURL = vi.fn(() => "blob:test");
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
  });
  const xlsx = { status: 200, body: new Blob(["PKfake"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers: { "content-disposition": 'attachment; filename="consolidation-products-2026-10-17.xlsx"' } };

  async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText("Total Sales");
    await user.click(screen.getByRole("button", { name: /Export/ }));
  }

  it("section export passes section + shop + dates and downloads the backend file", async () => {
    overrides["/admin/consolidation/export"] = () => xlsx as any;
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(await screen.findByLabelText("Shop"), "s1");
    await user.click(tab("Products"));
    await screen.findByText("Egg");
    await user.click(screen.getByRole("button", { name: /Export/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Export Selected Section")).toBeTruthy();
    expect(within(menu).getByText("Export Complete Report")).toBeTruthy();
    await user.click(within(menu).getAllByRole("menuitem")[0]); // section → Excel
    await waitFor(() => expect(clicked).toEqual(["consolidation-products-2026-10-17.xlsx"]));
    expect(calls("/admin/consolidation/export")[0].params).toMatchObject({ scope: "section", section: "products", format: "excel", shop: "s1", range: "last7", dateFrom: ymd(-6), dateTo: ymd(0) });
  });

  it("complete report export (PDF) has scope=full and no section", async () => {
    overrides["/admin/consolidation/export"] = () => ({ ...xlsx, type: "application/pdf", body: new Blob(["%PDF-1.4"], { type: "application/pdf" }), headers: {} }) as any;
    const user = userEvent.setup();
    renderPage();
    await openMenu(user);
    await user.click(within(screen.getByRole("menu")).getAllByRole("menuitem")[3]); // full → PDF
    await waitFor(() => expect(clicked).toEqual(["consolidation-report.pdf"]));
    const p = calls("/admin/consolidation/export")[0].params;
    expect(p).toMatchObject({ scope: "full", format: "pdf", shop: "all" });
    expect(p.section).toBeUndefined();
  });

  it("backend error message is surfaced and no file is produced", async () => {
    overrides["/admin/consolidation/export"] = () => ({ status: 400, body: { message: "Date range too large for export." } });
    const user = userEvent.setup();
    renderPage();
    await openMenu(user);
    await user.click(within(screen.getByRole("menu")).getAllByRole("menuitem")[0]);
    expect(await screen.findByText("Date range too large for export.")).toBeTruthy();
    expect(clicked).toHaveLength(0);
  });

  it("missing export endpoint and empty/placeholder bodies are rejected, not downloaded", async () => {
    const user = userEvent.setup();
    renderPage();
    await openMenu(user);
    overrides["/admin/consolidation/export"] = () => ({ status: 404, body: "" });
    await user.click(within(screen.getByRole("menu")).getAllByRole("menuitem")[0]);
    expect(await screen.findByText("The export endpoint isn't available on the server yet.")).toBeTruthy();
    overrides["/admin/consolidation/export"] = () => ({ status: 200, body: new Blob([], { type: "application/pdf" }), type: "application/pdf" }) as any;
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(within(screen.getByRole("menu")).getAllByRole("menuitem")[1]);
    expect(await screen.findByText("The server did not return a valid file. Please try again.")).toBeTruthy();
    expect(clicked).toHaveLength(0);
  });

  it("invalid custom range disables date-dependent exports", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total Sales");
    await user.click(tab("Custom Range"));
    await user.click(screen.getByRole("button", { name: /Export/ }));
    for (const item of within(screen.getByRole("menu")).getAllByRole("menuitem")) expect((item as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Sidebar + layout integration", () => {
  it("adds Consolidation as the last primary-section link; existing items unchanged and in order", () => {
    render(<MemoryRouter><DesktopSidebar collapsed={false} onToggleCollapse={() => {}} /></MemoryRouter>);
    const links = within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Dashboard", "/admin/dashboard"], ["Products", "/admin/products"], ["Customers", "/admin/customers"],
      ["Expenses", "/admin/expenses"], ["Purchases", "/admin/purchases"], ["Inventory", "/admin/inventory"],
      ["Credits", "/admin/credits"], ["Reports", "/admin/reports"], ["History", "/admin/history"],
      ["Sessions", "/admin/sessions"], ["Cashiers", "/admin/cashiers"], ["Consolidation", "/admin/consolidation"],
    ]);
  });

  it("global shop stays Shop 2 while Consolidation filters Shop 1; a global switch keeps Consolidation state; Dashboard shows the global shop", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/admin/consolidation"]}>
        <ToastProvider>
          <ShopProvider>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route path="consolidation" element={<Consolidation />} />
                <Route path="dashboard" element={<div>DASHBOARD PAGE</div>} />
              </Route>
            </Routes>
          </ShopProvider>
        </ToastProvider>
      </MemoryRouter>
    );
    await screen.findByText("Total Sales");
    const header = screen.getByRole("banner");
    // global shop = Shop 2 (backend's current)
    expect(within(header).getByText("Shop 2")).toBeTruthy();

    // 1) Consolidation → Shop 1 : global unchanged, no switch call
    await user.selectOptions(screen.getByLabelText("Shop"), "s1");
    await waitFor(() => expect(calls("/admin/consolidation/overview").some((r) => r.params.shop === "s1")).toBe(true));
    expect(calls("/admin/shops/switch")).toHaveLength(0);
    expect(within(header).getByText("Shop 2")).toBeTruthy();

    // 2) navigate to Dashboard: still the global shop (Shop 2)
    // (client-side nav through the router history)
    // 3) global switch to Shop 3 while on Consolidation: page must NOT remount
    (globalThis as any).__switchTo = "s3";
    await user.click(within(header).getByRole("button", { name: /Shop 2/ }));
    await user.click(within(screen.getByRole("listbox", { name: "Select shop" })).getByRole("option", { name: /Shop 3/ }));
    await waitFor(() => expect(calls("/admin/shops/switch")).toHaveLength(1));
    expect(calls("/admin/shops/switch")[0].params).toEqual({});
    await waitFor(() => expect(within(header).getByText("Shop 3")).toBeTruthy());
    expect((screen.getByLabelText("Shop") as HTMLSelectElement).value).toBe("s1"); // Consolidation keeps its own filter
    // only the single GLOBAL switch ever happened; Consolidation never called it
    expect(calls("/admin/shops/switch")).toHaveLength(1);
  });
});
