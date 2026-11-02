import * as asn1js from "asn1js"
import * as pkijs from "pkijs"
import { aBase64, bytes, dePem, etiqueta, texto } from "../util"

pkijs.setEngine("webcrypto", new pkijs.CryptoEngine({ name: "webcrypto", crypto }) as unknown as pkijs.ICryptoEngine)

export const URLS_WSAA = {
  homologacion: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
  produccion: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
} as const

export class ErrorArca extends Error {}

export interface Ticket {
  token: string
  sign: string
  vence: number
}

function isoArgentina(momento: Date): string {
  return new Date(momento.getTime() - 3 * 3600_000).toISOString().slice(0, 19) + "-03:00"
}

export function armarTra(servicio: string, ahora: Date): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<loginTicketRequest version="1.0">' +
    `<header><uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>` +
    `<generationTime>${isoArgentina(new Date(ahora.getTime() - 600_000))}</generationTime>` +
    `<expirationTime>${isoArgentina(new Date(ahora.getTime() + 600_000))}</expirationTime></header>` +
    `<service>${servicio}</service>` +
    "</loginTicketRequest>"
  )
}

export async function firmarTra(tra: string, certificadoPem: string, clavePrivadaPem: string): Promise<string> {
  const contenido = bytes(tra)
  const certificado = pkijs.Certificate.fromBER(dePem(certificadoPem))
  const clave = await crypto.subtle.importKey(
    "pkcs8",
    dePem(clavePrivadaPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const resumen = await crypto.subtle.digest("SHA-256", contenido)
  const firmado = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: "1.2.840.113549.1.7.1",
      eContent: new asn1js.OctetString({ valueHex: contenido }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: certificado.issuer, serialNumber: certificado.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({
              type: "1.2.840.113549.1.9.3",
              values: [new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.7.1" })],
            }),
            new pkijs.Attribute({ type: "1.2.840.113549.1.9.5", values: [new asn1js.UTCTime({ valueDate: new Date() })] }),
            new pkijs.Attribute({ type: "1.2.840.113549.1.9.4", values: [new asn1js.OctetString({ valueHex: resumen })] }),
          ],
        }),
      }),
    ],
    certificates: [certificado],
  })
  await firmado.sign(clave, 0, "SHA-256")
  const envoltorio = new pkijs.ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: firmado.toSchema(true) })
  return aBase64(envoltorio.toSchema().toBER(false))
}

export function sobreLogin(cms: string): string {
  return (
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">' +
    "<soapenv:Header/><soapenv:Body><wsaa:loginCms>" +
    `<wsaa:in0>${cms}</wsaa:in0>` +
    "</wsaa:loginCms></soapenv:Body></soapenv:Envelope>"
  )
}

export function revisarFalla(xml: string): void {
  if (etiqueta(xml, "Fault") !== null) {
    const motivo = texto(xml, "faultstring") ?? "ARCA devolvió un error"
    if (/ya posee un TA valido/i.test(motivo)) {
      throw new ErrorArca("ARCA ya entregó un acceso hace poco y no quedó guardado. Probá de nuevo en unos minutos.")
    }
    throw new ErrorArca(motivo)
  }
}

export function parsearLogin(xml: string): Ticket {
  revisarFalla(xml)
  const interno = texto(xml, "loginCmsReturn")
  if (!interno) throw new ErrorArca("ARCA respondió sin ticket de acceso")
  const token = texto(interno, "token")
  const sign = texto(interno, "sign")
  const vence = texto(interno, "expirationTime")
  if (!token || !sign || !vence) throw new ErrorArca("El ticket de acceso de ARCA vino incompleto")
  return { token, sign, vence: Date.parse(vence) }
}

export async function pedirTicket(
  modo: keyof typeof URLS_WSAA,
  certificadoPem: string,
  clavePrivadaPem: string,
  pedir: typeof fetch = fetch,
): Promise<Ticket> {
  const cms = await firmarTra(armarTra("wsfe", new Date()), certificadoPem, clavePrivadaPem)
  const respuesta = await pedir(URLS_WSAA[modo], {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
    body: sobreLogin(cms),
  })
  return parsearLogin(await respuesta.text())
}
