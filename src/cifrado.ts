import { aBase64, aleatorio, bytes, deBase64, sha256 } from "./util"

const llaves = new Map<string, Promise<CryptoKey>>()

function llave(secreto: string): Promise<CryptoKey> {
  if (!secreto || secreto.length < 16) throw new Error("Falta configurar SECRETO_DATOS")
  let encontrada = llaves.get(secreto)
  if (!encontrada) {
    encontrada = sha256(secreto).then((crudo) =>
      crypto.subtle.importKey("raw", crudo, "AES-GCM", false, ["encrypt", "decrypt"]),
    )
    llaves.set(secreto, encontrada)
  }
  return encontrada
}

export async function cifrar(secreto: string, textoPlano: string): Promise<string> {
  const iv = aleatorio(12)
  const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await llave(secreto), bytes(textoPlano))
  return `v1:${aBase64(iv)}:${aBase64(cifrado)}`
}

export async function descifrar(secreto: string, guardado: string): Promise<string> {
  const [version, iv, datos] = guardado.split(":")
  if (version !== "v1" || !iv || !datos) throw new Error("Dato cifrado con formato desconocido")
  const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deBase64(iv) }, await llave(secreto), deBase64(datos))
  return new TextDecoder().decode(plano)
}
