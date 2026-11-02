import "reflect-metadata"
import * as x509 from "@peculiar/x509"
import { aPem, deBase64, dePem, iguales } from "../util"

x509.cryptoProvider.set(crypto)

const ALGORITMO = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
}

export interface ClaveYPedido {
  clavePrivada: string
  clavePublica: string
  pedido: string
}

export interface DatosCertificado {
  vence: string
  sujeto: string
  cuit: string | null
}

export async function generarClaveYPedido(nombre: string, cuit: string): Promise<ClaveYPedido> {
  const llaves = (await crypto.subtle.generateKey(ALGORITMO, true, ["sign", "verify"])) as CryptoKeyPair
  const pedido = await x509.Pkcs10CertificateRequestGenerator.create({
    name: [
      { "2.5.4.6": ["AR"] },
      { "2.5.4.10": [nombre] },
      { "2.5.4.3": ["facturacion"] },
      { "2.5.4.5": [`CUIT ${cuit}`] },
    ],
    keys: llaves,
    signingAlgorithm: ALGORITMO,
  })
  const privada = (await crypto.subtle.exportKey("pkcs8", llaves.privateKey)) as ArrayBuffer
  const publica = (await crypto.subtle.exportKey("spki", llaves.publicKey)) as ArrayBuffer
  return {
    clavePrivada: aPem("PRIVATE KEY", privada),
    clavePublica: aPem("PUBLIC KEY", publica),
    pedido: pedido.toString("pem"),
  }
}

export function leerCertificado(certificadoPem: string, clavePublicaPem: string): DatosCertificado {
  let certificado: x509.X509Certificate
  try {
    certificado = new x509.X509Certificate(certificadoPem.trim())
  } catch {
    throw new Error("El archivo no es un certificado válido. Tiene que ser el .crt que descargaste de ARCA.")
  }
  if (!iguales(new Uint8Array(certificado.publicKey.rawData), dePem(clavePublicaPem))) {
    throw new Error("Este certificado no corresponde al último pedido generado desde la app.")
  }
  const serie = /CUIT (\d{11})/.exec(certificado.subject)
  return {
    vence: certificado.notAfter.toISOString(),
    sujeto: certificado.subject,
    cuit: serie ? serie[1] : null,
  }
}

export function certificadoDesdeArchivo(contenidoBase64: string): string {
  const crudo = deBase64(contenidoBase64)
  const comoTexto = new TextDecoder().decode(crudo).trim()
  if (comoTexto.startsWith("-----BEGIN CERTIFICATE-----")) return comoTexto + "\n"
  return aPem("CERTIFICATE", crudo)
}
