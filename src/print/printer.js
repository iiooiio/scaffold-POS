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

async function printTicket({ localTicket, cartItems, total, paymentMethod, cashInfo, note }) {
  const thermalPrinter = buildPrinter();

  const isConnected = await thermalPrinter.isPrinterConnected().catch(() => false);
  if (!isConnected) {
    throw new Error('Impresora no detectada (revisa cable USB / PRINTER_INTERFACE en .env)');
  }

  thermalPrinter.alignCenter();
  thermalPrinter.println('*** TICKET DE VENTA ***');
  thermalPrinter.println(localTicket);
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

module.exports = { printTicket };
