import { degrees, PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib"
import qrcode from "qrcode-generator"
import type { Emisor, Factura } from "./tipos"
import { aBase64, dmy, pesos } from "./util"
import { DOC_DNI } from "./arca/wsfe"

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255)
const TINTA = hex("#2d2522")
const SUAVE = hex("#5e534e")
const ROSA = hex("#8c5e52")
const LINEA = hex("#d9cbc2")
const FONDO = hex("#f7efeb")
const MARCA = hex("#ecd6cf")

const ANCHO = 595.28
const ALTO = 841.89
const MARGEN = 40

type FacturaPdf = Pick<
  Factura,
  "modo" | "pto_vta" | "cbte_tipo" | "numero" | "fecha" | "dni" | "nombre" | "sesiones" | "precio" | "total" | "descripcion" | "desde" | "hasta" | "vto_pago" | "cae" | "cae_vto"
> &
  Partial<Pick<Factura, "obra_social" | "plan" | "numero_socio">>

export function urlQr(f: FacturaPdf, cuit: string): string {
  const datos = {
    ver: 1,
    fecha: f.fecha,
    cuit: Number(cuit),
    ptoVta: f.pto_vta,
    tipoCmp: f.cbte_tipo,
    nroCmp: f.numero,
    importe: Number(f.total),
    moneda: "PES",
    ctz: 1,
    tipoDocRec: DOC_DNI,
    nroDocRec: f.dni,
    tipoCodAut: "E",
    codAut: Number(f.cae),
  }
  return `https://www.afip.gob.ar/fe/qr/?p=${aBase64(new TextEncoder().encode(JSON.stringify(datos)))}`
}

export function nombreArchivo(f: Pick<Factura, "pto_vta" | "numero" | "nombre">): string {
  const plano = f.nombre.normalize("NFKD").replace(/[^\x20-\x7e]/g, "")
  const nombre = plano.replace(/[^A-Za-z0-9 ]/g, "").trim().replace(/\s+/g, "-")
  return `Factura-C-${String(f.pto_vta).padStart(5, "0")}-${String(f.numero).padStart(8, "0")}-${nombre}.pdf`
}

const EXTRA_WINANSI = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ")
const EQUIVALENTES: Record<string, string> = { Ł: "L", ł: "l", Đ: "D", đ: "d", Ħ: "H", ħ: "h", ı: "i", Ŧ: "T", ŧ: "t" }

export function apto(texto: string): string {
  return [...texto]
    .map((c) => {
      if (c.charCodeAt(0) <= 0xff || EXTRA_WINANSI.has(c)) return c
      if (EQUIVALENTES[c]) return EQUIVALENTES[c]
      const base = c.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      return [...base].every((b) => b.charCodeAt(0) <= 0xff) ? base : "?"
    })
    .join("")
}

class Lienzo {
  constructor(
    private pagina: PDFPage,
    private normal: PDFFont,
    private negrita: PDFFont,
    private serif: PDFFont,
  ) {}

  private fuente(tipo: "n" | "b" | "s") {
    return tipo === "b" ? this.negrita : tipo === "s" ? this.serif : this.normal
  }

  ancho(texto: string, tamano: number, tipo: "n" | "b" | "s" = "n") {
    return this.fuente(tipo).widthOfTextAtSize(apto(texto), tamano)
  }

  texto(texto: string, x: number, y: number, tamano: number, color = TINTA, tipo: "n" | "b" | "s" = "n") {
    this.pagina.drawText(apto(texto), { x, y, size: tamano, font: this.fuente(tipo), color })
  }

  derecha(texto: string, x: number, y: number, tamano: number, color = TINTA, tipo: "n" | "b" | "s" = "n") {
    this.texto(texto, x - this.ancho(texto, tamano, tipo), y, tamano, color, tipo)
  }

  centro(texto: string, x: number, y: number, tamano: number, color = TINTA, tipo: "n" | "b" | "s" = "n") {
    this.texto(texto, x - this.ancho(texto, tamano, tipo) / 2, y, tamano, color, tipo)
  }

  linea(x1: number, y1: number, x2: number, y2: number) {
    this.pagina.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.8, color: LINEA })
  }

  caja(x: number, y: number, w: number, h: number, relleno = FONDO, borde?: ReturnType<typeof rgb>) {
    this.pagina.drawRectangle({ x, y, width: w, height: h, color: relleno, borderColor: borde, borderWidth: borde ? 0.8 : 0 })
  }

  qr(contenido: string, x: number, y: number, lado: number) {
    const codigo = qrcode(0, "M")
    codigo.addData(contenido)
    codigo.make()
    const n = codigo.getModuleCount()
    const celda = lado / n
    for (let fila = 0; fila < n; fila++) {
      for (let col = 0; col < n; col++) {
        if (codigo.isDark(fila, col)) {
          this.pagina.drawRectangle({ x: x + col * celda, y: y + lado - (fila + 1) * celda, width: celda + 0.05, height: celda + 0.05, color: TINTA })
        }
      }
    }
  }

  marcaDeAgua(texto: string) {
    const tamano = 34
    const ancho = this.ancho(texto, tamano, "b")
    const angulo = (35 * Math.PI) / 180
    this.pagina.drawText(texto, {
      x: ANCHO / 2 - (Math.cos(angulo) * ancho) / 2,
      y: ALTO / 2 - (Math.sin(angulo) * ancho) / 2,
      size: tamano,
      font: this.negrita,
      color: MARCA,
      rotate: degrees(35),
    })
  }
}

export async function generarPdf(f: FacturaPdf, emisor: Emisor): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Factura C ${String(f.pto_vta).padStart(5, "0")}-${String(f.numero).padStart(8, "0")}`)
  doc.setAuthor(emisor.nombre)
  doc.setProducer("Facturación")
  const pagina = doc.addPage([ANCHO, ALTO])
  const l = new Lienzo(
    pagina,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
    await doc.embedFont(StandardFonts.TimesRoman),
  )

  if (f.modo !== "produccion") {
    l.marcaDeAgua(f.modo === "simulacion" ? "SIMULACIÓN · SIN VALIDEZ FISCAL" : "HOMOLOGACIÓN · SIN VALIDEZ FISCAL")
  }

  const arriba = ALTO - MARGEN
  const medio = ANCHO / 2
  l.linea(MARGEN, arriba - 128, ANCHO - MARGEN, arriba - 128)
  l.linea(medio, arriba - 128, medio, arriba - 44)
  l.caja(medio - 22, arriba - 44, 44, 44, FONDO, ROSA)
  l.centro("C", medio, arriba - 28, 26, TINTA, "b")
  l.centro("COD. 011", medio, arriba - 39, 6.5)

  l.texto(emisor.nombre.toUpperCase(), MARGEN, arriba - 22, 20, TINTA, "s")
  if (emisor.titulo) l.texto(emisor.titulo.toUpperCase(), MARGEN, arriba - 37, 8.5, ROSA)
  let y = arriba - 70
  for (const linea of [emisor.domicilio && `Domicilio: ${emisor.domicilio}`, "Condición frente al IVA: Responsable Monotributo"]) {
    if (!linea) continue
    l.texto(linea, MARGEN, y, 8.5, SUAVE)
    y -= 13
  }

  const x = medio + 34
  l.texto("FACTURA", x, arriba - 22, 20, TINTA, "s")
  y = arriba - 44
  for (const [etiqueta, valor] of [
    ["Punto de venta", String(f.pto_vta).padStart(5, "0")],
    ["Comprobante N.º", String(f.numero).padStart(8, "0")],
    ["Fecha de emisión", dmy(f.fecha)],
    ["CUIT", emisor.cuit],
    ["Ingresos Brutos", emisor.iibb || emisor.cuit],
    ["Inicio de actividades", emisor.inicio_actividades || "-"],
  ]) {
    l.texto(etiqueta, x, y, 8.5, SUAVE)
    l.derecha(valor, ANCHO - MARGEN, y, 8.5, TINTA, "b")
    y -= 13
  }

  y = arriba - 150
  l.caja(MARGEN, y - 12, ANCHO - 2 * MARGEN, 26)
  let cursor = MARGEN + 12
  for (const [etiqueta, valor] of [
    ["Período facturado desde", dmy(f.desde)],
    ["hasta", dmy(f.hasta)],
    ["Vto. para el pago", dmy(f.vto_pago)],
  ]) {
    l.texto(etiqueta, cursor, y - 3, 8.5, SUAVE)
    cursor += l.ancho(etiqueta, 8.5) + 5
    l.texto(valor, cursor, y - 3, 8.5, TINTA, "b")
    cursor += l.ancho(valor, 8.5, "b") + 22
  }

  y -= 30
  const filas: string[][][] = [
    [["DNI", String(f.dni)], ["Apellido y nombre", f.nombre]],
    [["Condición frente al IVA", "Consumidor Final"], ["Condición de venta", "Contado"]],
  ]
  if (f.obra_social || f.numero_socio) {
    const cobertura = [f.obra_social, f.plan && `Plan ${f.plan}`].filter(Boolean).join(" · ")
    filas.push([["Obra social", cobertura || "-"], ["N.º de socio", f.numero_socio || "-"]])
  }
  for (const fila of filas) {
    y -= 14
    fila.forEach(([etiqueta, valor], i) => {
      const xi = i === 0 ? MARGEN : medio + 10
      l.texto(`${etiqueta}:`, xi, y, 8.5, SUAVE)
      l.texto(valor, xi + l.ancho(`${etiqueta}:`, 8.5) + 5, y, 8.5, TINTA, "b")
    })
  }
  y -= 12
  l.linea(MARGEN, y, ANCHO - MARGEN, y)

  y -= 26
  l.texto("DESCRIPCIÓN", MARGEN, y, 7.5, ROSA)
  l.derecha("CANTIDAD", 360, y, 7.5, ROSA)
  l.derecha("PRECIO UNIT.", 450, y, 7.5, ROSA)
  l.derecha("SUBTOTAL", ANCHO - MARGEN, y, 7.5, ROSA)
  l.linea(MARGEN, y - 6, ANCHO - MARGEN, y - 6)
  y -= 22
  l.texto(f.descripcion, MARGEN, y, 9.5)
  l.derecha(String(f.sesiones), 360, y, 9.5)
  l.derecha(pesos(f.precio), 450, y, 9.5)
  l.derecha(pesos(f.total), ANCHO - MARGEN, y, 9.5)
  y -= 10
  l.linea(MARGEN, y, ANCHO - MARGEN, y)

  y -= 14
  const xt = ANCHO - MARGEN
  l.derecha("Subtotal", xt - 110, y - 6, 9, SUAVE)
  l.derecha(pesos(f.total), xt, y - 6, 9, SUAVE)
  l.derecha("Otros tributos", xt - 110, y - 22, 9, SUAVE)
  l.derecha(pesos(0), xt, y - 22, 9, SUAVE)
  l.derecha("Importe total", xt - 110, y - 44, 12, TINTA, "b")
  l.derecha(pesos(f.total), xt, y - 44, 12, TINTA, "b")

  const lado = 84
  l.qr(urlQr(f, emisor.cuit), MARGEN, MARGEN, lado)
  l.linea(MARGEN, MARGEN + lado + 14, ANCHO - MARGEN, MARGEN + lado + 14)
  const xp = MARGEN + lado + 18
  l.texto("Comprobante autorizado", xp, MARGEN + 62, 10, TINTA, "b")
  l.texto("Podés verificarla en arca.gob.ar", xp, MARGEN + 48, 7.5, SUAVE)
  l.texto("escaneando el código QR.", xp, MARGEN + 38, 7.5, SUAVE)
  l.derecha("CAE N.º", ANCHO - MARGEN - 80, MARGEN + 62, 9, SUAVE)
  l.derecha("Vencimiento del CAE", ANCHO - MARGEN - 80, MARGEN + 46, 9, SUAVE)
  l.derecha(f.cae, ANCHO - MARGEN, MARGEN + 62, 9, TINTA, "b")
  l.derecha(dmy(f.cae_vto), ANCHO - MARGEN, MARGEN + 46, 9, TINTA, "b")

  return doc.save()
}
