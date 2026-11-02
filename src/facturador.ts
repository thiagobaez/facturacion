import { descifrar, cifrar } from "./cifrado"
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
    return JSON.parse(await descifrar(env.SECRETO_DATOS, guardado.datos))
  }
  const ticket = await pedirTicket(modo, u.certificado!, await descifrar(env.SECRETO_DATOS, u.clave_privada!), pedir)
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

async function recuperar(cliente: ClienteFacturacion, c: Comprobante, falla: unknown): Promise<ResultadoCae> {
  try {
    const ultimo = await cliente.ultimoAutorizado(c.ptoVta, FACTURA_C)
    if (ultimo >= c.numero) {
      const emitido = await cliente.consultar(c.ptoVta, FACTURA_C, c.numero)
      if (emitido?.aprobado && emitido.docNro === c.docNro) return emitido
      return {
        aprobado: false,
        observaciones: [],
        errores: [
          `Se cortó la conexión y el comprobante ${c.numero} quedó emitido con otros datos. Revisalo en ARCA antes de volver a facturar.`,
        ],
      }
    }
  } catch {}
  return { aprobado: false, observaciones: [], errores: [`No se pudo conectar con ARCA: ${mensaje(falla)}`] }
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
  try {
    const cliente = dep.cliente ?? (await clienteDe(env, u, dep.pedir))
    const precio = aCentavos(lote.precio)
    const emisor = JSON.stringify(datos.emisorDe(u))
    const fichas = new Map((await datos.pacientes(env.DB, u.id)).map((p) => [p.dni, p]))
    for (const item of lote.items) {
      const centavos = precio * item.sesiones
      const r: ResultadoItem = { dni: item.dni, nombre: item.nombre, sesiones: item.sesiones, total: deCentavos(centavos), ok: false, errores: [] }
      resultados.push(r)
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
      let cae: ResultadoCae
      try {
        cae = await cliente.solicitarCae(c)
      } catch (e) {
        if (!FALLAS(e)) throw e
        cae = await recuperar(cliente, c, e)
      }
      if (!cae.aprobado || !cae.cae || !cae.caeVto) {
        r.errores = [...cae.errores, ...cae.observaciones]
        if (!r.errores.length) r.errores = ["ARCA rechazó el comprobante"]
        continue
      }
      const [guardada] = await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO facturas (usuario_id, lote, modo, pto_vta, cbte_tipo, numero, fecha, dni, nombre, sesiones, precio, total, " +
            "descripcion, desde, hasta, vto_pago, cae, cae_vto, emisor, obra_social, plan, numero_socio) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
        ).bind(
          u.id, loteId, modo, u.punto_venta, FACTURA_C, numero, lote.fecha, item.dni, item.nombre, item.sesiones,
          deCentavos(precio), r.total, lote.descripcion, lote.desde, lote.hasta, lote.vtoPago, cae.cae, cae.caeVto, emisor,
          fichas.get(item.dni)?.obra_social ?? "", fichas.get(item.dni)?.plan ?? "", fichas.get(item.dni)?.numero_socio ?? "",
        ),
        datos.sentenciaNombrePaciente(env.DB, u.id, item.dni, item.nombre),
      ])
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
    if (r.ok) r.enlace = await enlacePublico(env.SECRETO_DATOS, r.factura_id!)
  }
  return { lote: loteId, aprobadas: resultados.filter((r) => r.ok).length, resultados }
}
