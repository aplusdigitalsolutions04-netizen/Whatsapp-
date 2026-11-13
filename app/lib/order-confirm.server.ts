import prisma from "../db.server";
import { logEvent } from "./log.server";
import { askAddressText, blank, BOT_EMPLOYEE, confirmedText, declinedText, parseYesNo, sheetFill } from "./order-confirm";

/** How long a question stays open. After that the customer's "yes" is treated like any other message. */
const OPEN_MS = 72 * 3_600_000;

export type ConfirmReply = { reply: string; handoffReason?: string };

type Row = NonNullable<Awaited<ReturnType<typeof prisma.orderConfirmation.findFirst>>>;

function replyFor(row: Row): ConfirmReply {
  if (row.state === "address") return { reply: askAddressText({ orderName: row.orderName, customerName: row.customerName, phone: row.phone, address: row.address }) };
  if (row.state === "confirmed") return { reply: confirmedText(row.orderName) };
  return { reply: declinedText(row.orderName), handoffReason: `Customer did not confirm order ${row.orderName}` };
}

/**
 * Called for every message of a customer who has an open order question. Returns the reply to send, or null when the message
 * is not a clear yes/no (the normal bot then answers it, the question stays open).
 *   asked   + YES -> show number and address, ask again   asked/address + NO -> hand over to an agent
 *   address + YES -> order confirmed
 * Calling it again with the same inbound message id gives the same reply (no double step when WhatsApp redelivers a message).
 */
export async function handleConfirmationReply(shop: string, conversationId: string, text: string, inboundId: string): Promise<ConfirmReply | null> {
  const again = await prisma.orderConfirmation.findFirst({ where: { shop, conversationId, lastInboundId: inboundId } });
  if (again) return replyFor(again);

  const row = await prisma.orderConfirmation.findFirst({
    where: { shop, conversationId, state: { in: ["asked", "address"] }, createdAt: { gte: new Date(Date.now() - OPEN_MS) } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  const answer = parseYesNo(text);
  if (!answer) return null;

  const state = answer === "no" ? "declined" : row.state === "asked" ? "address" : "confirmed";
  const next = await prisma.orderConfirmation.update({ where: { id: row.id }, data: { state, lastInboundId: inboundId } });
  await fillOrderSheet(shop, row.orderGid, row.state, state).catch((e) =>
    logEvent({ shop, source: "bot", level: "error", event: "order_sheet_fill_failed", detail: `${row.orderName}: ${(e as Error).message}` }).catch(() => undefined),
  );
  await logEvent({ shop, source: "bot", event: `order_${state}`, detail: `${row.orderName}: customer answered ${answer.toUpperCase()}` });
  return replyFor(next);
}

/**
 * Writes what the customer told JAZZ into the order's row of the Order Calling Sheet, with Employee Name "JAZZ", exactly as an
 * employee would after calling. Only empty cells are filled, so an employee's own entry is never replaced.
 */
export async function fillOrderSheet(shop: string, orderGid: string, prev: string, next: string): Promise<boolean> {
  const fill = sheetFill(prev, next);
  if (!fill) return false;
  const shopifyOrderId = orderGid.split("/").pop() ?? orderGid;
  const row = await prisma.orderSheet.findUnique({ where: { shop_shopifyOrderId: { shop, shopifyOrderId } } });
  if (!row) return false; // not in the sheet (yet): the next order sync adds it, nothing is lost for the customer
  const data: Record<string, unknown> = {};
  if (blank(row.employeeName)) data.employeeName = BOT_EMPLOYEE;
  if (!row.callDate) data.callDate = new Date();
  for (const k of ["customerWants", "addressConfirmed", "callStatus", "finalDecision"] as const) {
    if (fill[k] && blank(row[k])) data[k] = fill[k];
  }
  // A "yes" never reopens an order an employee already moved on, and the remark is added to theirs, not replacing it.
  const theirs = (row.employeeRemark ?? "").split(/(?:^| \| )JAZZ: /)[0].trim(); // an earlier JAZZ line is replaced by the newer one
  data.employeeRemark = theirs ? `${theirs} | ${fill.employeeRemark}` : fill.employeeRemark;
  // Nothing new to write (already filled earlier): leave the row, the log and the Google Sheet alone.
  const changed = Object.keys(data).filter((k) => {
    const old = (row as Record<string, unknown>)[k];
    const now = data[k];
    return old instanceof Date && now instanceof Date ? false : old !== now;
  });
  if (!changed.length) return false;
  await prisma.orderSheet.update({ where: { id: row.id }, data });
  const { scheduleSheetPush } = await import("./google-sheets.server");
  scheduleSheetPush(shop);
  await logEvent({ shop, source: "bot", event: "order_sheet_filled", detail: `${row.orderName ?? shopifyOrderId}: ${changed.join(", ")}` });
  return true;
}

/**
 * Customers who answered JAZZ before the sheet was filled automatically (or whose order was not in the sheet yet) are written
 * to the sheet now. Safe to run again and again: an already filled row is left alone, an employee's entry is never replaced.
 */
export async function backfillSheetFromConfirmations(shop: string): Promise<number> {
  const rows = await prisma.orderConfirmation.findMany({ where: { shop, state: { in: ["address", "confirmed", "declined"] } }, orderBy: { updatedAt: "desc" }, take: 500 });
  let filled = 0;
  for (const r of rows) {
    let prev = "asked";
    if (r.state === "confirmed") prev = "address";
    if (r.state === "declined") {
      // a NO after the address question means the address was wrong, a NO to the first question means the order was not wanted
      const sawAddress = await prisma.message.findFirst({ where: { conversationId: r.conversationId, direction: "out", body: { contains: `delivery details for ${r.orderName}` } }, select: { id: true } });
      if (sawAddress) prev = "address";
    }
    if (await fillOrderSheet(shop, r.orderGid, prev, r.state).catch(() => false)) filled++;
  }
  return filled;
}
