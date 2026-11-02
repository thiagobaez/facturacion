import { cifrar, descifrarConCualquiera, secretos } from "./cifrado"
import * as datos from "./datos"
import { generarPdf, nombreArchivo } from "./pdf"
import type { Env, Factura, Modo, Usuario } from "./tipos"
import { aCentavos, deCentavos } from "./util"
import { ErrorArca, pedirTicket, type Ticket } from "./arca/wsaa"
import { FACTURA_C, Simulador, Wsfe, type ClienteFacturacion, type Comprobante, type ResultadoCae } from "./arca/wsfe"
import { enlacePublico } from "./enlaces"

export class ErrorUsuario extends Error {}

export interface Item {
  dni: number
  nombre: string
  sesiones: number
}

export interface Lote {
  fecha: string
  desde: string
  hasta: string
  vtoPago: string
  precio: string
  descripcion: string
  items: Item[]
}

export interface ResultadoItem {
  dni: number
  nombre: string
  sesiones: number
  total: string
  ok: boolean
  factura_id?: number
  numero?: number
  cae?: string
  errores: string[]
  enlace?: string
}

export interface Dependencias {
  pedir?: typeof fetch
  cliente?: ClienteFacturacion
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

export function describirPeriodo(desde: string, hasta: string): string {
  const [ad, md] = desde.split("-").map(Number)
  const [ah, mh] = hasta.split("-").map(Number)
  if (ad === ah && md === mh) return `${MESES[md - 1]} de ${ad}`
  return `${desde.split("-").reverse().join("/")} al ${hasta.split("-").reverse().join("/")}`
}

export function simulado(env: Env): boolean {
  return env.SIMULAR_ARCA === "true"
}

export function modoDe(env: Env): Modo {
  return simulado(env) ? "simulacion" : "produccion"
}

export function faltantes(u: Usuario, env: Env): string[] {
  const falta: string[] = []
  if (!u.nombre.trim()) falta.push("tu nombre")
  if (!/^\d{11}$/.test(u.cuit)) falta.push("tu CUIT")
  if (!simulado(env) && (!u.certificado || !u.clave_privada)) falta.push("el certificado de ARCA")
  return falta
}

async function ticketDe(env: Env, u: Usuario, pedir: typeof fetch): Promise<Ticket> {
  const modo = "produccion"
  const guardado = await env.DB.prepare("SELECT datos, vence FROM tickets WHERE usuario_id = ? AND modo = ?")
    .bind(u.id, modo)
    .first<{ datos: string; vence: number }>()
  if (guardado && guardado.vence > Date.now() + 10 * 60_000) {
    try {
      return JSON.parse((await descifrarConCualquiera(secretos(env), guardado.datos)).texto)
    } catch {}
  }
  const clave = await descifrarConCualquiera(secretos(env), u.clave_privada!)
  if (!clave.conActual) {
    await env.DB.prepare("UPDATE usuarios SET clave_privada = ? WHERE id = ?")
      .bind(await cifrar(env.SECRETO_DATOS, clave.texto), u.id)
      .run()
  }
  const ticket = await pedirTicket(modo, u.certificado!, clave.texto, pedir)
  await env.DB.prepare(
    "INSERT INTO tickets (usuario_id, modo, datos, vence) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (usuario_id, modo) DO UPDATE SET datos = excluded.datos, vence = excluded.vence",
  )
    .bind(u.id, modo, await cifrar(env.SECRETO_DATOS, JSON.stringify(ticket)), ticket.vence)
    .run()
  return ticket
}

export async function clienteDe(env: Env, u: Usuario, pedir: typeof fetch = fetch): Promise<ClienteFacturacion> {
  if (simulado(env)) {
    return new Simulador(await datos.ultimoNumero(env.DB, u.id, "simulacion", u.punto_venta, FACTURA_C))
  }
  return new Wsfe("produccion", u.cuit, () => ticketDe(env, u, pedir), pedir)
}

const FALLAS = (e: unknown) => e instanceof ErrorArca || e instanceof TypeError || (e instanceof Error && e.name === "AbortError")

function mensaje(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Pregunta a ARCA qué pasó con un comprobante cuya respuesta se perdió.
// null: no se pudo saber (hay que dejarlo pendiente). aprobado: salió con estos datos.
async function averiguar(cliente: ClienteFacturacion, ptoVta: number, numero: number, docNro: number): Promise<ResultadoCae | null> {
  try {
    const ultimo = await cliente.ultimoAutorizado(ptoVta, FACTURA_C)
    if (ultimo < numero) return { aprobado: false, observaciones: [], errores: ["ARCA no emitió el comprobante"] }
    const emitido = await cliente.consultar(ptoVta, FACTURA_C, numero)
    if (emitido?.aprobado && emitido.docNro === docNro) return emitido
    return {
      aprobado: false,
      observaciones: [],
      errores: [`El comprobante ${numero} quedó emitido en ARCA con otros datos. Revisalo en ARCA antes de volver a facturar.`],
    }
  } catch {
    return null
  }
}

// Columnas de facturas salvo cae y cae_vto, en el orden del INSERT.
type Fila = [number, string, Modo, number, number, number, string, number, string, number, string, string, string, string, string, string, string, string, string, string]

function guardarFactura(env: Env, fila: Fila, cae: ResultadoCae) {
  const [usuarioId, , modo, ptoVta, cbteTipo, numero, , dni, nombre] = fila
  return env.DB.batch([
    env.DB.prepare(
      "INSERT INTO facturas (usuario_id, lote, modo, pto_vta, cbte_tipo, numero, fecha, dni, nombre, sesiones, precio, total, " +
        "descripcion, desde, hasta, vto_pago, emisor, obra_social, plan, numero_socio, cae, cae_vto) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    ).bind(...fila, cae.cae!, cae.caeVto!),
    datos.sentenciaNombrePaciente(env.DB, usuarioId, dni, nombre),
    sentenciaSinPendiente(env, usuarioId, modo, ptoVta, cbteTipo, numero),
  ])
}

function sentenciaSinPendiente(env: Env, usuarioId: number, modo: Modo, ptoVta: number, cbteTipo: number, numero: number) {
  return env.DB.prepare("DELETE FROM pendientes WHERE usuario_id = ? AND modo = ? AND pto_vta = ? AND cbte_tipo = ? AND numero = ?").bind(
    usuarioId, modo, ptoVta, cbteTipo, numero,
  )
}

// Resuelve los comprobantes que quedaron sin confirmar en una tanda anterior. Devuelve cuántos
// estaban emitidos en ARCA y se guardaron ahora. Si alguno no se puede confirmar, no deja facturar.
async function resolverPendientes(env: Env, u: Usuario, modo: Modo, cliente: ClienteFacturacion): Promise<number> {
  const { results } = await env.DB.prepare("SELECT datos FROM pendientes WHERE usuario_id = ? AND modo = ? ORDER BY numero")
    .bind(u.id, modo)
    .all<{ datos: string }>()
  let recuperadas = 0
  for (const { datos: crudo } of results) {
    const fila = JSON.parse(crudo) as Fila
    const [, , , ptoVta, cbteTipo, numero, , dni] = fila
    const cae = await averiguar(cliente, ptoVta, numero, dni)
    if (!cae) {
      throw new ErrorUsuario(
        "En una tanda anterior se cortó la conexión con ARCA y todavía no se pudo confirmar si salió una factura. " +
          "Probá de nuevo en unos minutos.",
      )
    }
    if (cae.aprobado && cae.cae && cae.caeVto) {
      const [guardada] = await guardarFactura(env, fila, cae)
      recuperadas++
      try {
        await guardarPdf(env, (guardada.results as Factura[])[0])
      } catch {}
    } else {
      await sentenciaSinPendiente(env, u.id, modo, ptoVta, cbteTipo, numero).run()
    }
  }
  return recuperadas
}

export async function guardarPdf(env: Env, f: Factura): Promise<Uint8Array> {
  const pdf = await generarPdf(f, JSON.parse(f.emisor))
  await env.ARCHIVOS.put(`u/${f.usuario_id}/facturas/${f.id}.pdf`, pdf, {
    httpMetadata: { contentType: "application/pdf" },
  })
  return pdf
}

export async function pdfDe(env: Env, f: Factura): Promise<Uint8Array> {
  const guardado = await env.ARCHIVOS.get(`u/${f.usuario_id}/facturas/${f.id}.pdf`)
  if (guardado) return new Uint8Array(await guardado.arrayBuffer())
  return guardarPdf(env, f)
}

export async function marcarWhatsApp(env: Env, u: Usuario, facturaId: number) {
  if (!(await datos.factura(env.DB, u.id, facturaId))) return false
  await datos.marcarEnvio(env.DB, facturaId, "abierto", null, null)
  return true
}

export async function facturarLote(env: Env, u: Usuario, lote: Lote, dep: Dependencias = {}) {
  const falta = faltantes(u, env)
  const modo = modoDe(env)
  if (falta.length) throw new ErrorUsuario(`Antes de facturar completá en Cuenta: ${falta.join(", ")}.`)
  if (!(await datos.tomarCandado(env.DB, u.id))) {
    throw new ErrorUsuario("Ya hay una tanda emitiéndose. Esperá a que termine.")
  }
  const loteId = crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  const resultados: ResultadoItem[] = []
  let recuperadas = 0
  try {
    const cliente = dep.cliente ?? (await clienteDe(env, u, dep.pedir))
    recuperadas = await resolverPendientes(env, u, modo, cliente)
    const precio = aCentavos(lote.precio)
    const emisor = JSON.stringify(datos.emisorDe(u))
    const fichas = new Map((await datos.pacientes(env.DB, u.id)).map((p) => [p.dni, p]))
    let cortado = false
    for (const item of lote.items) {
      const centavos = precio * item.sesiones
      const r: ResultadoItem = { dni: item.dni, nombre: item.nombre, sesiones: item.sesiones, total: deCentavos(centavos), ok: false, errores: [] }
      resultados.push(r)
      if (cortado) {
        r.errores = ["No se emitió porque se cortó la conexión con ARCA. Volvé a intentar en unos minutos."]
        continue
      }
      await datos.renovarCandado(env.DB, u.id)
      let numero: number
      try {
        numero = (await cliente.ultimoAutorizado(u.punto_venta, FACTURA_C)) + 1
      } catch (e) {
        if (!FALLAS(e)) throw e
        r.errores = [`No se pudo consultar la numeración en ARCA: ${mensaje(e)}`]
        continue
      }
      const c: Comprobante = {
        ptoVta: u.punto_venta,
        numero,
        fecha: lote.fecha,
        docNro: item.dni,
        centavos,
        desde: lote.desde,
        hasta: lote.hasta,
        vtoPago: lote.vtoPago,
      }
      const ficha = fichas.get(item.dni)
      const fila: Fila = [
        u.id, loteId, modo, u.punto_venta, FACTURA_C, numero, lote.fecha, item.dni, item.nombre, item.sesiones,
        deCentavos(precio), r.total, lote.descripcion, lote.desde, lote.hasta, lote.vtoPago, emisor,
        ficha?.obra_social ?? "", ficha?.plan ?? "", ficha?.numero_socio ?? "",
      ]
      // Se anota antes de pedir el CAE: si el Worker se corta antes de guardar, la próxima tanda lo resuelve.
      await env.DB.prepare("INSERT INTO pendientes (usuario_id, modo, pto_vta, cbte_tipo, numero, datos) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(u.id, modo, u.punto_venta, FACTURA_C, numero, JSON.stringify(fila))
        .run()
      let cae: ResultadoCae | null
      try {
        cae = await cliente.solicitarCae(c)
      } catch (e) {
        if (!FALLAS(e)) throw e
        cae = await averiguar(cliente, c.ptoVta, c.numero, c.docNro)
        if (!cae?.aprobado) {
          // No se sabe si ARCA lo emitió (o pasó algo raro): queda pendiente y se frena la tanda.
          if (cae) await sentenciaSinPendiente(env, u.id, modo, u.punto_venta, FACTURA_C, numero).run()
          r.errores = cae ? cae.errores : [`Se cortó la conexión con ARCA: ${mensaje(e)}. Volvé a intentar en unos minutos.`]
          cortado = true
          continue
        }
      }
      if (!cae.aprobado || !cae.cae || !cae.caeVto) {
        await sentenciaSinPendiente(env, u.id, modo, u.punto_venta, FACTURA_C, numero).run()
        r.errores = [...cae.errores, ...cae.observaciones]
        if (!r.errores.length) r.errores = ["ARCA rechazó el comprobante"]
        continue
      }
      const [guardada] = await guardarFactura(env, fila, cae)
      const f = (guardada.results as Factura[])[0]
      r.ok = true
      r.factura_id = f.id
      r.numero = numero
      r.cae = cae.cae
      try {
        await guardarPdf(env, f)
      } catch {}
    }
  } finally {
    await datos.soltarCandado(env.DB, u.id)
  }

  for (const r of resultados) {
    if (r.ok) r.enlace = await enlacePublico(env.SECRETO_DATOS, { id: r.factura_id!, enlace_version: 0 })
  }
  return { lote: loteId, aprobadas: resultados.filter((r) => r.ok).length, recuperadas, resultados }
}
