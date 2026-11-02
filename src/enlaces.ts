import { aBase64Url, bytes, deBase64Url, iguales } from "./util"

const llaves = new Map<string, Promise<CryptoKey>>()

function llave(secreto: string): Promise<CryptoKey> {
  let encontrada = llaves.get(secreto)
  if (!encontrada) {
    encontrada = crypto.subtle.importKey("raw", bytes(`enlaces|${secreto}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    llaves.set(secreto, encontrada)
  }
  return encontrada
}

async function firma(secreto: string, id: number): Promise<Uint8Array> {
  const completa = await crypto.subtle.sign("HMAC", await llave(secreto), bytes(`factura:${id}`))
  return new Uint8Array(completa).slice(0, 16)
}

export async function enlacePublico(secreto: string, id: number): Promise<string> {
  return `/f/${id}-${aBase64Url(await firma(secreto, id))}`
}

export async function idDeEnlace(secreto: string, clave: string): Promise<number | null> {
  const encontrado = /^(\d{1,12})-([A-Za-z0-9_-]{22})$/.exec(clave)
  if (!encontrado) return null
  const id = Number(encontrado[1])
  return iguales(await firma(secreto, id), deBase64Url(encontrado[2])) ? id : null
}
