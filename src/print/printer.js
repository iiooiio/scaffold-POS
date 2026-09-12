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

async function printTicket({ localTicket, cartItems, total, paymentMethod, cashInfo, note, isReprint = false }) {
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
  for (const item of cartItems) {
    thermalPrinter.println(`${item.quantity}x ${item.name}`);
    thermalPrinter.alignRight();
    thermalPrinter.println(`$${(item.price * item.quantity).toFixed(2)}`);
    thermalPrinter.alignLeft();
  }

  thermalPrinter.drawLine();
  thermalPrinter.alignRight();
  thermalPrinter.println(`TOTAL: $${total.toFixed(2)}`);
  thermalPrinter.println(`Pago: ${paymentMethod === 'cash' ? 'Efectivo' : 'Tarjeta'}`);
  if (paymentMethod === 'cash' && cashInfo) {
    thermalPrinter.println(`Recibido: $${cashInfo.received.toFixed(2)}`);
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
async function printPartialRefund({ localTicket, items, amount, reason, paymentMethod }) {
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
  thermalPrinter.println(`Pago original: ${paymentMethod === 'cash' ? 'Efectivo' : 'Tarjeta'}`);

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
async function printCancellation({ localTicket, total, reason, paymentMethod }) {
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
  thermalPrinter.println(`Pago original: ${paymentMethod === 'cash' ? 'Efectivo' : 'Tarjeta'}`);
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
