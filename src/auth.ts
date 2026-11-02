import type { Usuario } from "./tipos"
import { aBase64Url, aleatorio, bytes, deBase64Url, iguales, sha256 } from "./util"

export const COOKIE = "sesion"
export const DURACION_SESION = 12 * 3600
export const ITERACIONES = 100_000
export const VENTANA_INTENTOS = 15 * 60
export const MAX_INTENTOS = 10

async function derivar(clave: string, sal: Uint8Array, iteraciones: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", bytes(clave), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, base, 256)
  return new Uint8Array(bits)
}

export async function hashearClave(clave: string): Promise<string> {
  const sal = aleatorio(16)
  return `pbkdf2:${ITERACIONES}:${aBase64Url(sal)}:${aBase64Url(await derivar(clave, sal, ITERACIONES))}`
}

export async function verificarClave(clave: string, guardado: string): Promise<boolean> {
  const [tipo, iteraciones, sal, resumen] = guardado.split(":")
  if (tipo !== "pbkdf2" || !sal || !resumen) return false
  const calculado = await derivar(clave, deBase64Url(sal), Number(iteraciones))
  return iguales(calculado, deBase64Url(resumen))
}

const HASH_FALSO = "pbkdf2:100000:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

export async function buscarParaLogin(db: D1Database, usuario: string, clave: string): Promise<Usuario | null> {
  const encontrado = await db.prepare("SELECT * FROM usuarios WHERE usuario = ?").bind(usuario.trim()).first<Usuario>()
  const valida = await verificarClave(clave, encontrado?.clave_hash ?? HASH_FALSO)
  return encontrado && valida ? encontrado : null
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

function claveIntento(usuario: string): string {
  return `login:${usuario.trim().toLowerCase()}`
}

export async function bloqueado(db: D1Database, usuario: string, ahora = Date.now()): Promise<boolean> {
  const desde = Math.floor(ahora / 1000) - VENTANA_INTENTOS
  const fila = await db
    .prepare("SELECT COUNT(*) AS n FROM intentos WHERE clave = ? AND momento > ?")
    .bind(claveIntento(usuario), desde)
    .first<{ n: number }>()
  return (fila?.n ?? 0) >= MAX_INTENTOS
}

export async function registrarFallo(db: D1Database, usuario: string, ahora = Date.now()): Promise<void> {
  const momento = Math.floor(ahora / 1000)
  await db.batch([
    db.prepare("DELETE FROM intentos WHERE momento < ?").bind(momento - VENTANA_INTENTOS),
    db.prepare("INSERT INTO intentos (clave, momento) VALUES (?, ?)").bind(claveIntento(usuario), momento),
  ])
}

export async function limpiarFallos(db: D1Database, usuario: string): Promise<void> {
  await db.prepare("DELETE FROM intentos WHERE clave = ?").bind(claveIntento(usuario)).run()
}
