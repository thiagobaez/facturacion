import type { Emisor, Factura, Modo, Paciente, Usuario } from "./tipos"

export function emisorDe(u: Usuario): Emisor {
  return {
    nombre: u.nombre,
    titulo: u.titulo,
    cuit: u.cuit,
    domicilio: u.domicilio,
    iibb: u.iibb,
    inicio_actividades: u.inicio_actividades,
  }
}

export async function pacientes(db: D1Database, usuarioId: number): Promise<Paciente[]> {
  const { results } = await db
    .prepare(
      "SELECT dni, nombre, telefono, notas, obra_social, plan, numero_socio FROM pacientes WHERE usuario_id = ? ORDER BY nombre COLLATE NOCASE",
    )
    .bind(usuarioId)
    .all<Paciente>()
  return results
}

export async function paciente(db: D1Database, usuarioId: number, dni: number): Promise<Paciente | null> {
  return db
    .prepare("SELECT dni, nombre, telefono, notas, obra_social, plan, numero_socio FROM pacientes WHERE usuario_id = ? AND dni = ?")
    .bind(usuarioId, dni)
    .first<Paciente>()
}

export function sentenciaNombrePaciente(db: D1Database, usuarioId: number, dni: number, nombre: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO pacientes (usuario_id, dni, nombre) VALUES (?, ?, ?) " +
        "ON CONFLICT (usuario_id, dni) DO UPDATE SET nombre = excluded.nombre, actualizado = datetime('now')",
    )
    .bind(usuarioId, dni, nombre)
}

export async function guardarPaciente(db: D1Database, usuarioId: number, p: Paciente): Promise<void> {
  await db
    .prepare(
      "INSERT INTO pacientes (usuario_id, dni, nombre, telefono, notas, obra_social, plan, numero_socio) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (usuario_id, dni) DO UPDATE SET nombre = excluded.nombre, telefono = excluded.telefono, " +
        "notas = excluded.notas, obra_social = excluded.obra_social, plan = excluded.plan, " +
        "numero_socio = excluded.numero_socio, actualizado = datetime('now')",
    )
    .bind(usuarioId, p.dni, p.nombre, p.telefono, p.notas, p.obra_social, p.plan, p.numero_socio)
    .run()
}

export async function borrarPaciente(db: D1Database, usuarioId: number, dni: number): Promise<boolean> {
  const r = await db.prepare("DELETE FROM pacientes WHERE usuario_id = ? AND dni = ?").bind(usuarioId, dni).run()
  return r.meta.changes > 0
}

export async function factura(db: D1Database, usuarioId: number, id: number): Promise<Factura | null> {
  return db.prepare("SELECT * FROM facturas WHERE usuario_id = ? AND id = ?").bind(usuarioId, id).first<Factura>()
}

export async function facturasLote(db: D1Database, usuarioId: number, lote: string): Promise<Factura[]> {
  const { results } = await db
    .prepare("SELECT * FROM facturas WHERE usuario_id = ? AND lote = ? ORDER BY numero")
    .bind(usuarioId, lote)
    .all<Factura>()
  return results
}

export async function historial(db: D1Database, usuarioId: number, modo: Modo, limite = 300) {
  const { results } = await db
    .prepare(
      "SELECT f.id, f.lote, f.numero, f.pto_vta, f.fecha, f.dni, f.nombre, f.sesiones, f.total, f.desde, f.hasta, f.obra_social, " +
        "f.whatsapp_estado, f.whatsapp_detalle, f.enlace_version, p.telefono FROM facturas f " +
        "LEFT JOIN pacientes p ON p.usuario_id = f.usuario_id AND p.dni = f.dni " +
        "WHERE f.usuario_id = ? AND f.modo = ? ORDER BY f.id DESC LIMIT ?",
    )
    .bind(usuarioId, modo, limite)
    .all()
  return results
}

export async function yaFacturados(db: D1Database, usuarioId: number, modo: Modo, dnis: number[], desde: string, hasta: string) {
  if (!dnis.length) return []
  // Un solo parámetro con la lista en JSON: D1 admite como máximo 100 parámetros por consulta.
  const { results } = await db
    .prepare(
      "SELECT DISTINCT dni FROM facturas WHERE usuario_id = ? AND modo = ? AND dni IN (SELECT value FROM json_each(?)) " +
        "AND desde <= ? AND hasta >= ?",
    )
    .bind(usuarioId, modo, JSON.stringify(dnis), hasta, desde)
    .all<{ dni: number }>()
  return results.map((r) => r.dni)
}

export async function ultimoNumero(db: D1Database, usuarioId: number, modo: Modo, ptoVta: number, cbteTipo: number) {
  const fila = await db
    .prepare("SELECT MAX(numero) AS n FROM facturas WHERE usuario_id = ? AND modo = ? AND pto_vta = ? AND cbte_tipo = ?")
    .bind(usuarioId, modo, ptoVta, cbteTipo)
    .first<{ n: number | null }>()
  return fila?.n ?? 0
}

export async function marcarEnvio(db: D1Database, facturaId: number, estado: string, detalle: string | null, mensajeId: string | null) {
  await db
    .prepare(
      "UPDATE facturas SET whatsapp_estado = ?, whatsapp_detalle = ?, whatsapp_id = ?, whatsapp_fecha = datetime('now') WHERE id = ?",
    )
    .bind(estado, detalle, mensajeId, facturaId)
    .run()
}

export async function tomarCandado(db: D1Database, usuarioId: number, segundos = 300, ahora = Date.now()): Promise<boolean> {
  const momento = Math.floor(ahora / 1000)
  const r = await db
    .prepare(
      "INSERT INTO candados (usuario_id, hasta) VALUES (?, ?) " +
        "ON CONFLICT (usuario_id) DO UPDATE SET hasta = excluded.hasta WHERE candados.hasta < ?",
    )
    .bind(usuarioId, momento + segundos, momento)
    .run()
  return r.meta.changes > 0
}

export async function renovarCandado(db: D1Database, usuarioId: number, segundos = 300, ahora = Date.now()): Promise<void> {
  await db.prepare("UPDATE candados SET hasta = ? WHERE usuario_id = ?").bind(Math.floor(ahora / 1000) + segundos, usuarioId).run()
}

export async function soltarCandado(db: D1Database, usuarioId: number): Promise<void> {
  await db.prepare("DELETE FROM candados WHERE usuario_id = ?").bind(usuarioId).run()
}
