import type { Usuario } from "./tipos"
import { aBase64Url, aleatorio, bytes, deBase64Url, iguales, sha256 } from "./util"

export const COOKIE = "sesion"
export const DURACION_SESION = 12 * 3600
export const ITERACIONES = 600_000
// Workers no acepta más de 100.000 iteraciones por llamada a PBKDF2: se encadenan rondas
// (la salida de cada una es la clave de la siguiente). Con 100.000 da lo mismo que PBKDF2 común.
export const RONDA = 100_000
export const VENTANA_INTENTOS = 15 * 60
export const LIMITES = { usuarioEnIp: 10, ip: 30, usuario: 100, cambioClave: 10 }

async function derivar(clave: string, sal: Uint8Array, iteraciones: number): Promise<Uint8Array> {
  if (!Number.isInteger(iteraciones) || iteraciones < 1 || iteraciones > 10 * ITERACIONES) throw new Error("Iteraciones inválidas")
  let actual: Uint8Array = bytes(clave)
  for (let restantes = iteraciones; restantes > 0; restantes -= RONDA) {
    const base = await crypto.subtle.importKey("raw", actual, "PBKDF2", false, ["deriveBits"])
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: Math.min(restantes, RONDA) },
      base,
      256,
    )
    actual = new Uint8Array(bits)
  }
  return actual
}

export async function hashearClave(clave: string): Promise<string> {
  const sal = aleatorio(16)
  return `pbkdf2:${ITERACIONES}:${aBase64Url(sal)}:${aBase64Url(await derivar(clave, sal, ITERACIONES))}`
}

export async function verificarClave(clave: string, guardado: string): Promise<boolean> {
  const [tipo, iteraciones, sal, resumen] = guardado.split(":")
  if (tipo !== "pbkdf2" || !sal || !resumen) return false
  try {
    return iguales(await derivar(clave, deBase64Url(sal), Number(iteraciones)), deBase64Url(resumen))
  } catch {
    return false
  }
}

export function necesitaRehash(guardado: string): boolean {
  return Number(guardado.split(":")[1]) < ITERACIONES
}

const HASH_FALSO = `pbkdf2:${ITERACIONES}:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`

export async function buscarParaLogin(db: D1Database, usuario: string, clave: string): Promise<Usuario | null> {
  const encontrado = await db.prepare("SELECT * FROM usuarios WHERE usuario = ?").bind(usuario.trim()).first<Usuario>()
  const valida = await verificarClave(clave, encontrado?.clave_hash ?? HASH_FALSO)
  if (!encontrado || !valida) return null
  if (necesitaRehash(encontrado.clave_hash)) {
    const nuevo = await hashearClave(clave)
    await db.prepare("UPDATE usuarios SET clave_hash = ? WHERE id = ?").bind(nuevo, encontrado.id).run()
    encontrado.clave_hash = nuevo
  }
  return encontrado
}

export async function crearSesion(db: D1Database, usuarioId: number, ahora = Date.now()): Promise<string> {
  const token = aBase64Url(aleatorio(32))
  const vence = Math.floor(ahora / 1000) + DURACION_SESION
  await db.batch([
    db.prepare("DELETE FROM sesiones WHERE vence < ?").bind(Math.floor(ahora / 1000)),
    db
      .prepare("INSERT INTO sesiones (token_hash, usuario_id, vence) VALUES (?, ?, ?)")
      .bind(aBase64Url(await sha256(token)), usuarioId, vence),
  ])
  return token
}

export async function usuarioDeSesion(db: D1Database, token: string | undefined, ahora = Date.now()): Promise<Usuario | null> {
  if (!token || token.length > 100) return null
  return db
    .prepare(
      "SELECT u.* FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ? AND s.vence > ?",
    )
    .bind(aBase64Url(await sha256(token)), Math.floor(ahora / 1000))
    .first<Usuario>()
}

export async function cerrarSesion(db: D1Database, token: string | undefined): Promise<void> {
  if (!token) return
  await db.prepare("DELETE FROM sesiones WHERE token_hash = ?").bind(aBase64Url(await sha256(token))).run()
}

export async function cerrarOtrasSesiones(db: D1Database, usuarioId: number, tokenActual: string): Promise<void> {
  await db
    .prepare("DELETE FROM sesiones WHERE usuario_id = ? AND token_hash != ?")
    .bind(usuarioId, aBase64Url(await sha256(tokenActual)))
    .run()
}

export interface Limite {
  clave: string
  maximo: number
}

// Agrupa las IPv6 por su red /64: cada conexión suele tener millones de direcciones propias.
export function redDe(ip: string): string {
  if (!ip.includes(":")) return ip
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1)
  const [cabeza, cola] = ip.toLowerCase().split("::")
  const izquierda = cabeza ? cabeza.split(":") : []
  const derecha = cola ? cola.split(":") : []
  const grupos = cola === undefined ? izquierda : [...izquierda, ...Array(Math.max(0, 8 - izquierda.length - derecha.length)).fill("0"), ...derecha]
  return `${grupos.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`
}

export function limitesLogin(usuario: string, ip: string, dispositivoConocido: boolean): Limite[] {
  const u = usuario.trim().toLowerCase()
  const red = redDe(ip)
  const limites = [
    { clave: `login:${u}|ip:${red}`, maximo: LIMITES.usuarioEnIp },
    { clave: `ip:${red}`, maximo: LIMITES.ip },
  ]
  // El tope global por usuario no se aplica a navegadores donde ya entró bien: así nadie puede
  // dejarlo afuera fallando a propósito desde muchas IPs.
  if (!dispositivoConocido) limites.push({ clave: `login:${u}`, maximo: LIMITES.usuario })
  return limites
}

// Anota el intento solo si ninguno de los contadores llegó a su tope, en una sola sentencia
// dentro de la misma transacción: los pedidos simultáneos no pueden pasar el límite y los
// pedidos ya bloqueados no escriben nada. Devuelve false si hay que frenarlo.
export async function registrarIntento(db: D1Database, limites: Limite[], ahora = Date.now()): Promise<boolean> {
  const momento = Math.floor(ahora / 1000)
  const desde = momento - VENTANA_INTENTOS
  const condicion = limites.map(() => "(SELECT COUNT(*) FROM intentos WHERE clave = ? AND momento > ?) < ?").join(" AND ")
  const [, insertado] = await db.batch([
    db.prepare("DELETE FROM intentos WHERE momento <= ?").bind(desde),
    db
      .prepare(`INSERT INTO intentos (clave, momento) SELECT value, ? FROM json_each(?) WHERE ${condicion}`)
      .bind(momento, JSON.stringify(limites.map((l) => l.clave)), ...limites.flatMap((l) => [l.clave, desde, l.maximo])),
  ])
  return insertado.meta.changes > 0
}

export async function limpiarIntentos(db: D1Database, claves: string[]): Promise<void> {
  await db.prepare("DELETE FROM intentos WHERE clave IN (SELECT value FROM json_each(?))").bind(JSON.stringify(claves)).run()
}

export const COOKIE_DISPOSITIVO = "dispositivo"
export const DURACION_DISPOSITIVO = 180 * 86_400

export async function marcaDispositivo(secreto: string, usuario: string): Promise<string> {
  if (!secreto || secreto.length < 16) throw new Error("Falta configurar SECRETO_DATOS")
  const llave = await crypto.subtle.importKey("raw", bytes(`dispositivos|${secreto}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const firma = await crypto.subtle.sign("HMAC", llave, bytes(`dispositivo:${usuario.trim().toLowerCase()}`))
  return aBase64Url(new Uint8Array(firma).slice(0, 16))
}

export async function esDispositivoConocido(secretos: string[], usuario: string, valor: string | undefined): Promise<boolean> {
  if (!valor || valor.length !== 22) return false
  for (const secreto of secretos) {
    if (iguales(bytes(await marcaDispositivo(secreto, usuario)), bytes(valor))) return true
  }
  return false
}
