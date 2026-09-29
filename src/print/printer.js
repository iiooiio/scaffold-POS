const { printer: ThermalPrinter, types: PrinterTypes } = require('node-thermal-printer');
const config = require('../config');

// PRINTER_INTERFACE en .env, ej:
//   'printer:auto'                -> intenta autodetectar impresora USB del sistema
//   'printer:EPSON TM-T20III'     -> nombre exacto de la impresora tal como aparece en el SO
// NO PROBADO en hardware real -- ajusta `interface` según lo que reporte tu impresora
// específica (esto varía por SO y modelo; ver README).
function buildPrinter() {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON, // cambiar a STAR si tu impresora es Star Micronics
    interface: config.printerInterface,
    width: 42, // ~42 columnas para papel de 80mm; usar 32 para 58mm
    removeSpecialCharacters: false,
    lineCharacter: '-',
  });
}

const PAYMENT_LABELS = { cash: 'Efectivo', card: 'Tarjeta' };

// Normaliza a [{ method, amount }]. Las ventas anteriores a los pagos divididos no traen
// desglose, solo `paymentMethod`: se les arma uno de un renglón para que la reimpresión
// de un ticket viejo se siga viendo igual que el original.
function asPaymentList({ payments, paymentMethod, total }) {
  if (Array.isArray(payments) && payments.length > 0) return payments;
  return [{ method: paymentMethod === 'card' ? 'card' : 'cash', amount: total || 0 }];
}

// Un solo método se imprime en una línea, como siempre. Varios se desglosan con su monto:
// sin el monto el cliente no puede verificar cuánto se le cargó a la tarjeta.
//
// El encabezado del caso dividido se pasa aparte porque no siempre es la misma frase: en
// el ticket es "Pago: dividido" y en una devolución es "Se devuelve en:".
function printPaymentBreakdown(thermalPrinter, list, singleLabel, multiHeader) {
  if (list.length === 1) {
    thermalPrinter.println(`${singleLabel}: ${PAYMENT_LABELS[list[0].method] || list[0].method}`);
    return;
  }
  thermalPrinter.println(multiHeader);
  for (const p of list) {
    thermalPrinter.println(`  ${PAYMENT_LABELS[p.method] || p.method}: $${(p.amount || 0).toFixed(2)}`);
  }
}

async function printTicket({ localTicket, cartItems, total, paymentMethod, payments, cashInfo, note, isReprint = false }) {
  const thermalPrinter = buildPrinter();

  const isConnected = await thermalPrinter.isPrinterConnected().catch(() => false);
  if (!isConnected) {
    throw new Error('Impresora no detectada (revisa cable USB / PRINTER_INTERFACE en .env)');
  }

  thermalPrinter.alignCenter();
  thermalPrinter.println('*** TICKET DE VENTA ***');
  thermalPrinter.println(localTicket);
  // Una reimpresión NUNCA debe verse idéntica al original: si no se distingue, un mismo
  // ticket puede pasar dos veces por caja o por contabilidad.
  if (isReprint) {
    thermalPrinter.bold(true);
    thermalPrinter.println('--- REIMPRESION ---');
    thermalPrinter.bold(false);
    thermalPrinter.println(new Date().toLocaleString());
  }
  thermalPrinter.drawLine();

  thermalPrinter.alignLeft();
  let descuentoTotal = 0;
  for (const item of cartItems) {
    const subtotal = item.line_subtotal ?? item.price * item.quantity;
    const lineTotal = item.line_total ?? item.price * item.quantity;
    descuentoTotal += subtotal - lineTotal;

    thermalPrinter.println(`${item.quantity}x ${item.name}`);
    thermalPrinter.alignRight();
    if (lineTotal < subtotal) {
      // Se imprime el precio de lista tachado conceptualmente (sin tachado real en
      // ESC/POS): primero el original, luego el cobrado.
      thermalPrinter.println(`$${subtotal.toFixed(2)} -> $${lineTotal.toFixed(2)}`);
    } else {
      thermalPrinter.println(`$${lineTotal.toFixed(2)}`);
    }
    thermalPrinter.alignLeft();
  }

  thermalPrinter.drawLine();
  thermalPrinter.alignRight();
  if (descuentoTotal > 0.005) {
    thermalPrinter.println(`Subtotal: $${(total + descuentoTotal).toFixed(2)}`);
    thermalPrinter.println(`Descuento: -$${descuentoTotal.toFixed(2)}`);
  }
  thermalPrinter.println(`TOTAL: $${total.toFixed(2)}`);

  const paymentList = asPaymentList({ payments, paymentMethod, total });
  printPaymentBreakdown(thermalPrinter, paymentList, 'Pago', 'Pago: dividido');

  // "Recibido" y "Cambio" son del efectivo. En un pago dividido se aclara, porque si no
  // el cliente ve "Recibido: $150" bajo un total de $200 y parece que falta dinero.
  const hasCash = paymentList.some((p) => p.method === 'cash');
  if (hasCash && cashInfo) {
    const suffix = paymentList.length > 1 ? ' en efectivo' : '';
    thermalPrinter.println(`Recibido${suffix}: $${cashInfo.received.toFixed(2)}`);
    thermalPrinter.println(`Cambio: $${cashInfo.change.toFixed(2)}`);
  }

  if (note && note.trim()) {
    thermalPrinter.alignLeft();
    thermalPrinter.newLine();
    thermalPrinter.println('Nota:');
    thermalPrinter.println(note.trim());
  }

  thermalPrinter.alignCenter();
  thermalPrinter.newLine();
  thermalPrinter.println('Gracias por su compra');
  thermalPrinter.cut();

  await thermalPrinter.execute();
}

module.exports = { printTicket, printCashReport, printCancellation, printPartialRefund };

// Comprobante de devolución parcial: detalla qué piezas se devolvieron y por cuánto.
async function printPartialRefund({ localTicket, items, amount, reason, paymentMethod, payments }) {
  const thermalPrinter = buildPrinter();

  const isConnected = await thermalPrinter.isPrinterConnected().catch(() => false);
  if (!isConnected) {
    throw new Error('Impresora no detectada (revisa cable USB / PRINTER_INTERFACE en .env)');
  }

  thermalPrinter.alignCenter();
  thermalPrinter.bold(true);
  thermalPrinter.println('*** DEVOLUCION PARCIAL ***');
  thermalPrinter.bold(false);
  thermalPrinter.println(localTicket);
  thermalPrinter.println(new Date().toLocaleString());
  thermalPrinter.drawLine();

  thermalPrinter.alignLeft();
  for (const item of items) {
    thermalPrinter.println(`${item.quantity}x ${item.name}`);
    thermalPrinter.alignRight();
    thermalPrinter.println(`$${item.amount.toFixed(2)}`);
    thermalPrinter.alignLeft();
  }

  thermalPrinter.drawLine();
  thermalPrinter.alignRight();
  thermalPrinter.println(`DEVUELTO: $${amount.toFixed(2)}`);
  // En una venta dividida, `payments` ya viene repartido proporcionalmente desde
  // order-sync: esto es cuánto se le devuelve a CADA método, no cómo se pagó originalmente.
  printPaymentBreakdown(
    thermalPrinter,
    asPaymentList({ payments, paymentMethod, total: amount }),
    'Se devuelve en', 'Se devuelve en:'
  );

  if (reason && reason.trim()) {
    thermalPrinter.alignLeft();
    thermalPrinter.newLine();
    thermalPrinter.println('Motivo:');
    thermalPrinter.println(reason.trim());
  }

  thermalPrinter.alignCenter();
  thermalPrinter.newLine();
  thermalPrinter.println('Firma: ____________________');
  thermalPrinter.cut();

  await thermalPrinter.execute();
}

// Comprobante de cancelación: deja constancia física de que se devolvió el dinero.
async function printCancellation({ localTicket, total, reason, paymentMethod, payments }) {
  const thermalPrinter = buildPrinter();

  const isConnected = await thermalPrinter.isPrinterConnected().catch(() => false);
  if (!isConnected) {
    throw new Error('Impresora no detectada (revisa cable USB / PRINTER_INTERFACE en .env)');
  }

  thermalPrinter.alignCenter();
  thermalPrinter.bold(true);
  thermalPrinter.println('*** VENTA CANCELADA ***');
  thermalPrinter.bold(false);
  thermalPrinter.println(localTicket);
  thermalPrinter.println(new Date().toLocaleString());
  thermalPrinter.drawLine();

  thermalPrinter.alignLeft();
  thermalPrinter.println(`Monto devuelto: $${(total || 0).toFixed(2)}`);
  printPaymentBreakdown(
    thermalPrinter,
    asPaymentList({ payments, paymentMethod, total }),
    'Se devuelve en', 'Se devuelve en:'
  );
  if (reason && reason.trim()) {
    thermalPrinter.newLine();
    thermalPrinter.println('Motivo:');
    thermalPrinter.println(reason.trim());
  }

  thermalPrinter.alignCenter();
  thermalPrinter.newLine();
  thermalPrinter.println('Firma: ____________________');
  thermalPrinter.cut();

  await thermalPrinter.execute();
}

// Imprime el corte de caja al cerrar el turno.
async function printCashReport(summary) {
  const thermalPrinter = buildPrinter();

  const isConnected = await thermalPrinter.isPrinterConnected().catch(() => false);
  if (!isConnected) {
    throw new Error('Impresora no detectada (revisa cable USB / PRINTER_INTERFACE en .env)');
  }

  const line = (label, value) => {
    thermalPrinter.alignLeft();
    thermalPrinter.println(`${label}: $${value.toFixed(2)}`);
  };

  thermalPrinter.alignCenter();
  thermalPrinter.println('*** CORTE DE CAJA ***');
  thermalPrinter.println(summary.register_id);
  thermalPrinter.drawLine();

  thermalPrinter.alignLeft();
  thermalPrinter.println(`Apertura: ${new Date(summary.opened_at).toLocaleString()}`);
  thermalPrinter.println(`Cierre:   ${new Date(summary.closed_at).toLocaleString()}`);
  thermalPrinter.drawLine();

  line('Fondo inicial', summary.opening_float);
  line(`Ventas efectivo (${summary.cashSalesCount})`, summary.cashSalesTotal);
  line('Ingresos', summary.cashIn);
  line('Retiros', summary.cashOut);
  thermalPrinter.drawLine();

  line('Esperado en cajon', summary.expected);
  line('Contado', summary.counted_amount);
  thermalPrinter.bold(true);
  line('DIFERENCIA', summary.difference);
  thermalPrinter.bold(false);

  thermalPrinter.drawLine();
  line(`Ventas tarjeta (${summary.cardSalesCount})`, summary.cardSalesTotal);
  thermalPrinter.println('(no afecta el efectivo del cajon)');

  thermalPrinter.alignCenter();
  thermalPrinter.newLine();
  thermalPrinter.println('Firma: ____________________');
  thermalPrinter.cut();

  await thermalPrinter.execute();
}
