import { normalizarTelefono, TelefonoInvalido } from "./whatsapp"
import { aCentavos, diasEntre, hoyArgentina } from "./util"
import type { Lote } from "./facturador"

export class Invalido extends Error {}

const FECHA = /^\d{4}-\d{2}-\d{2}$/

function cadena(valor: unknown, campo: string, min = 0, max = 200): string {
  if (valor === undefined || valor === null) valor = ""
  if (typeof valor !== "string") throw new Invalido(`${campo} no es válido`)
  const limpio = valor.trim().replace(/\s+/g, " ")
  if (limpio.length < min) throw new Invalido(`Completá ${campo}`)
  if (limpio.length > max) throw new Invalido(`${campo} es demasiado largo`)
  return limpio
}

function fecha(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || !FECHA.test(valor) || Number.isNaN(Date.parse(valor))) {
    throw new Invalido(`La fecha de ${campo} no es válida`)
  }
  return valor
}

export function dni(valor: unknown): number {
  const limpio = String(valor ?? "").replace(/\D/g, "")
  if (limpio.length < 6 || limpio.length > 8) throw new Invalido("El DNI debe tener entre 6 y 8 números")
  return Number(limpio)
}

export function cuitValido(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = pesos.reduce((a, p, i) => a + p * Number(cuit[i]), 0)
  const resto = 11 - (suma % 11)
  const verificador = resto === 11 ? 0 : resto === 10 ? 9 : resto
  return verificador === Number(cuit[10])
}

export function precio(valor: unknown): string {
  const texto = String(valor ?? "").trim()
  let centavos: number
  try {
    centavos = aCentavos(texto)
  } catch {
    throw new Invalido("El precio no es válido")
  }
  if (centavos <= 0) throw new Invalido("El precio tiene que ser mayor a cero")
  if (centavos > 1_000_000_000_00) throw new Invalido("El precio es demasiado alto")
  return texto
}

export function lote(cuerpo: any, hoy = hoyArgentina()): Lote {
  if (!cuerpo || typeof cuerpo !== "object") throw new Invalido("Faltan datos")
  const resultado: Lote = {
    fecha: fecha(cuerpo.fecha, "la factura"),
    desde: fecha(cuerpo.desde, "inicio del período"),
    hasta: fecha(cuerpo.hasta, "fin del período"),
    vtoPago: fecha(cuerpo.vto_pago, "vencimiento"),
    precio: precio(cuerpo.precio),
    descripcion: cadena(cuerpo.descripcion, "el concepto", 3, 200),
    items: [],
  }
  if (resultado.desde > resultado.hasta) throw new Invalido("El período empieza después de que termina")
  if (resultado.vtoPago < resultado.fecha) throw new Invalido("El vencimiento de pago no puede ser anterior a la fecha de la factura")
  if (Math.abs(diasEntre(hoy, resultado.fecha)) > 10) {
    throw new Invalido("ARCA solo acepta facturas de servicios con fecha de hasta 10 días antes o después de hoy")
  }
  if (!Array.isArray(cuerpo.items) || !cuerpo.items.length) throw new Invalido("Agregá al menos un paciente")
  if (cuerpo.items.length > 200) throw new Invalido("Una tanda puede tener hasta 200 facturas")
  const vistos = new Set<number>()
  for (const item of cuerpo.items) {
    const d = dni(item?.dni)
    if (vistos.has(d)) throw new Invalido(`El DNI ${d} está dos veces`)
    vistos.add(d)
    const sesiones = Number(item?.sesiones)
    if (!Number.isInteger(sesiones) || sesiones < 1 || sesiones > 100) {
      throw new Invalido("La cantidad de sesiones tiene que ser entre 1 y 100")
    }
    resultado.items.push({ dni: d, nombre: cadena(item?.nombre, "el nombre del paciente", 2, 120), sesiones })
  }
  return resultado
}

export function paciente(cuerpo: any, dniRuta: string) {
  let telefono: string | null = null
  const crudo = cadena(cuerpo?.telefono, "el teléfono", 0, 40)
  if (crudo) {
    try {
      telefono = normalizarTelefono(crudo)
    } catch (e) {
      if (e instanceof TelefonoInvalido) throw new Invalido(e.message)
      throw e
    }
  }
  const notas = typeof cuerpo?.notas === "string" ? cuerpo.notas.trim() : ""
  if (notas.length > 1000) throw new Invalido("Las notas son demasiado largas")
  return {
    dni: dni(dniRuta),
    nombre: cadena(cuerpo?.nombre, "el nombre y apellido", 2, 120),
    telefono,
    notas,
    obra_social: cadena(cuerpo?.obra_social, "la obra social", 0, 80),
    plan: cadena(cuerpo?.plan, "el plan", 0, 60),
    numero_socio: cadena(cuerpo?.numero_socio, "el número de socio", 0, 40),
  }
}

export function datosCuenta(cuerpo: any) {
  const cuit = String(cuerpo?.cuit ?? "").replace(/\D/g, "")
  if (cuit && !cuitValido(cuit)) throw new Invalido("El CUIT no es válido. Revisá los 11 números.")
  const puntoVenta = Number(cuerpo?.punto_venta)
  if (!Number.isInteger(puntoVenta) || puntoVenta < 1 || puntoVenta > 99998) throw new Invalido("El punto de venta no es válido")
  const inicio = cadena(cuerpo?.inicio_actividades, "el inicio de actividades", 0, 10)
  if (inicio && !/^\d{2}\/\d{2}\/\d{4}$/.test(inicio)) throw new Invalido("El inicio de actividades va como dd/mm/aaaa")
  return {
    nombre: cadena(cuerpo?.nombre, "tu nombre", 0, 120),
    titulo: cadena(cuerpo?.titulo, "el título", 0, 120),
    cuit,
    domicilio: cadena(cuerpo?.domicilio, "el domicilio", 0, 200),
    iibb: cadena(cuerpo?.iibb, "Ingresos Brutos", 0, 40),
    inicio_actividades: inicio,
    punto_venta: puntoVenta,
    precio_sesion: String(cuerpo?.precio_sesion ?? "").trim() ? precio(cuerpo.precio_sesion) : "0",
    descripcion: cadena(cuerpo?.descripcion, "el concepto", 3, 200),
  }
}

export function claveNueva(clave: unknown): string {
  if (typeof clave !== "string" || clave.length < 10) throw new Invalido("La contraseña tiene que tener al menos 10 caracteres")
  if (clave.length > 200) throw new Invalido("La contraseña es demasiado larga")
  return clave
}
