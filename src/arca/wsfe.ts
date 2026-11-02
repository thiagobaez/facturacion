import { deCentavos, escaparXml, etiqueta, etiquetas, texto } from "../util"
import { ErrorArca, revisarFalla, type Ticket } from "./wsaa"

export const NS = "http://ar.gov.afip.dif.FEV1/"

export const URLS_WSFE = {
  homologacion: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  produccion: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
} as const

export const FACTURA_C = 11
export const CONCEPTO_SERVICIOS = 2
export const DOC_DNI = 96
export const CONSUMIDOR_FINAL = 5

export interface Comprobante {
  ptoVta: number
  numero: number
  fecha: string
  docNro: number
  centavos: number
  desde: string
  hasta: string
  vtoPago: string
}

export interface ResultadoCae {
  aprobado: boolean
  cae?: string
  caeVto?: string
  docNro?: number
  fecha?: string
  observaciones: string[]
  errores: string[]
}

export interface ClienteFacturacion {
  ultimoAutorizado(ptoVta: number, cbteTipo: number): Promise<number>
  solicitarCae(comprobante: Comprobante): Promise<ResultadoCae>
  consultar(ptoVta: number, cbteTipo: number, numero: number): Promise<ResultadoCae | null>
}

const compacta = (iso: string) => iso.replaceAll("-", "")
const isoDe = (compactada: string | null) =>
  compactada && /^\d{8}$/.test(compactada)
    ? `${compactada.slice(0, 4)}-${compactada.slice(4, 6)}-${compactada.slice(6, 8)}`
    : undefined

function mensajes(xml: string | null, contenedor: string, item: string): string[] {
  if (!xml) return []
  const bloque = etiqueta(xml, contenedor)
  if (!bloque) return []
  return etiquetas(bloque, item).map((e) => `${texto(e, "Code")}: ${texto(e, "Msg")}`)
}

export function cuerpoCae(c: Comprobante): string {
  const importe = deCentavos(c.centavos)
  return (
    "<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg>" +
    `<ar:PtoVta>${c.ptoVta}</ar:PtoVta><ar:CbteTipo>${FACTURA_C}</ar:CbteTipo></ar:FeCabReq>` +
    "<ar:FeDetReq><ar:FECAEDetRequest>" +
    `<ar:Concepto>${CONCEPTO_SERVICIOS}</ar:Concepto>` +
    `<ar:DocTipo>${DOC_DNI}</ar:DocTipo><ar:DocNro>${c.docNro}</ar:DocNro>` +
    `<ar:CbteDesde>${c.numero}</ar:CbteDesde><ar:CbteHasta>${c.numero}</ar:CbteHasta>` +
    `<ar:CbteFch>${compacta(c.fecha)}</ar:CbteFch>` +
    `<ar:ImpTotal>${importe}</ar:ImpTotal><ar:ImpTotConc>0</ar:ImpTotConc>` +
    `<ar:ImpNeto>${importe}</ar:ImpNeto><ar:ImpOpEx>0</ar:ImpOpEx>` +
    "<ar:ImpTrib>0</ar:ImpTrib><ar:ImpIVA>0</ar:ImpIVA>" +
    `<ar:FchServDesde>${compacta(c.desde)}</ar:FchServDesde>` +
    `<ar:FchServHasta>${compacta(c.hasta)}</ar:FchServHasta>` +
    `<ar:FchVtoPago>${compacta(c.vtoPago)}</ar:FchVtoPago>` +
    "<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>" +
    `<ar:CondicionIVAReceptorId>${CONSUMIDOR_FINAL}</ar:CondicionIVAReceptorId>` +
    "</ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>"
  )
}

export function resultadoDe(xml: string, metodo: string): string {
  revisarFalla(xml)
  const resultado = etiqueta(xml, `${metodo}Result`)
  if (resultado === null) throw new ErrorArca("ARCA respondió sin resultado")
  return resultado
}

export function parsearCae(resultado: string): ResultadoCae {
  const errores = mensajes(resultado.replace(/<(?:\w+:)?FeDetResp[\s\S]*<\/(?:\w+:)?FeDetResp>/, ""), "Errors", "Err")
  const detalle = etiqueta(resultado, "FECAEDetResponse")
  if (detalle === null) {
    return { aprobado: false, observaciones: [], errores: errores.length ? errores : ["ARCA no devolvió el detalle del comprobante"] }
  }
  const aprobado = texto(detalle, "Resultado") === "A"
  return {
    aprobado,
    cae: texto(detalle, "CAE") || undefined,
    caeVto: isoDe(texto(detalle, "CAEFchVto")),
    docNro: Number(texto(detalle, "DocNro") ?? 0),
    observaciones: aprobado ? [] : mensajes(detalle, "Observaciones", "Obs"),
    errores,
  }
}

export class Wsfe implements ClienteFacturacion {
  constructor(
    private modo: keyof typeof URLS_WSFE,
    private cuit: string,
    private ticket: () => Promise<Ticket>,
    private pedir: typeof fetch = fetch,
  ) {}

  private async llamar(metodo: string, cuerpo: string): Promise<string> {
    const t = await this.ticket()
    const sobre =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
      `xmlns:ar="${NS}"><soapenv:Header/><soapenv:Body>` +
      `<ar:${metodo}><ar:Auth><ar:Token>${escaparXml(t.token)}</ar:Token>` +
      `<ar:Sign>${escaparXml(t.sign)}</ar:Sign><ar:Cuit>${this.cuit}</ar:Cuit></ar:Auth>` +
      `${cuerpo}</ar:${metodo}></soapenv:Body></soapenv:Envelope>`
    const respuesta = await this.pedir(URLS_WSFE[this.modo], {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${NS}${metodo}"` },
      body: sobre,
    })
    return resultadoDe(await respuesta.text(), metodo)
  }

  async ultimoAutorizado(ptoVta: number, cbteTipo: number): Promise<number> {
    const resultado = await this.llamar(
      "FECompUltimoAutorizado",
      `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`,
    )
    const errores = mensajes(resultado, "Errors", "Err")
    if (errores.length) throw new ErrorArca(errores.join("; "))
    return Number(texto(resultado, "CbteNro") ?? 0)
  }

  async solicitarCae(comprobante: Comprobante): Promise<ResultadoCae> {
    return parsearCae(await this.llamar("FECAESolicitar", cuerpoCae(comprobante)))
  }

  async consultar(ptoVta: number, cbteTipo: number, numero: number): Promise<ResultadoCae | null> {
    const resultado = await this.llamar(
      "FECompConsultar",
      `<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${numero}</ar:CbteNro>` +
        `<ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`,
    )
    const datos = etiqueta(resultado, "ResultGet")
    if (datos === null) return null
    return {
      aprobado: texto(datos, "Resultado") === "A",
      cae: texto(datos, "CodAutorizacion") ?? undefined,
      caeVto: isoDe(texto(datos, "FchVto")),
      docNro: Number(texto(datos, "DocNro") ?? 0),
      fecha: isoDe(texto(datos, "CbteFch")),
      observaciones: [],
      errores: [],
    }
  }
}

export class Simulador implements ClienteFacturacion {
  private emitidos = new Map<string, ResultadoCae>()

  constructor(private ultimo: number) {}

  async ultimoAutorizado(): Promise<number> {
    return this.ultimo
  }

  async solicitarCae(c: Comprobante): Promise<ResultadoCae> {
    if (c.numero !== this.ultimo + 1) {
      return { aprobado: false, observaciones: [], errores: ["10016: El número de comprobante no es el siguiente"] }
    }
    this.ultimo = c.numero
    const vence = new Date(Date.parse(c.fecha) + 10 * 86_400_000).toISOString().slice(0, 10)
    const cae = Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => String(b % 10)).join("")
    const resultado = { aprobado: true, cae, caeVto: vence, docNro: c.docNro, fecha: c.fecha, observaciones: [], errores: [] }
    this.emitidos.set(`${c.ptoVta}-${c.numero}`, resultado)
    return resultado
  }

  async consultar(ptoVta: number, _cbteTipo: number, numero: number): Promise<ResultadoCae | null> {
    return this.emitidos.get(`${ptoVta}-${numero}`) ?? null
  }
}
