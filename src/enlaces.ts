import { aBase64Url, bytes, deBase64Url, iguales } from "./util"

export const DURACION_ENLACE = 60 * 86_400

const llaves = new Map<string, Promise<CryptoKey>>()

function llave(secreto: string): Promise<CryptoKey> {
  if (!secreto || secreto.length < 16) throw new Error("Falta configurar SECRETO_DATOS")
  let encontrada = llaves.get(secreto)
  if (!encontrada) {
    encontrada = crypto.subtle.importKey("raw", bytes(`enlaces|${secreto}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    llaves.set(secreto, encontrada)
  }
  return encontrada
}

export interface FacturaEnlace {
  id: number
  enlace_version: number
}

export interface Enlace {
  id: number
  vence: number
  firma: Uint8Array
}

async function firma(secreto: string, f: FacturaEnlace, vence: number): Promise<Uint8Array> {
  const completa = await crypto.subtle.sign("HMAC", await llave(secreto), bytes(`factura:${f.id}:${f.enlace_version}:${vence}`))
  return new Uint8Array(completa).slice(0, 16)
}

export async function enlacePublico(secreto: string, f: FacturaEnlace, ahora = Date.now()): Promise<string> {
  const vence = Math.floor(ahora / 1000) + DURACION_ENLACE
  return `/f/${f.id}-${vence}-${aBase64Url(await firma(secreto, f, vence))}`
}

export function leerEnlace(clave: string, ahora = Date.now()): Enlace | null {
  const encontrado = /^(\d{1,12})-(\d{1,12})-([A-Za-z0-9_-]{22})$/.exec(clave)
  if (!encontrado) return null
  const vence = Number(encontrado[2])
  if (vence <= Math.floor(ahora / 1000)) return null
  return { id: Number(encontrado[1]), vence, firma: deBase64Url(encontrado[3]) }
}

export async function enlaceValido(secretos: string[], f: FacturaEnlace, enlace: Enlace): Promise<boolean> {
  if (f.id !== enlace.id) return false
  for (const secreto of secretos) {
    if (iguales(await firma(secreto, f, enlace.vence), enlace.firma)) return true
  }
  return false
}
