export class TelefonoInvalido extends Error {}

export const MENSAJE_PREDETERMINADO =
  "Hola {nombre}, te paso la factura de las sesiones de {periodo} por {importe}. La podés descargar acá: {enlace}"

export function normalizarTelefono(entrada: string): string {
  let digitos = (entrada || "").replace(/\D/g, "")
  if (digitos.startsWith("00")) digitos = digitos.slice(2)
  if (digitos.startsWith("54") && digitos.length >= 12) {
    digitos = digitos.slice(2)
    if (digitos.startsWith("9") && digitos.length === 11) digitos = digitos.slice(1)
  }
  digitos = digitos.replace(/^0+/, "")
  if (digitos.length === 12) {
    const candidatos = [2, 3, 4].filter((i) => digitos.slice(i, i + 2) === "15")
    if (candidatos.length !== 1) throw new TelefonoInvalido("Escribí el número con código de área, sin el 0 y sin el 15")
    digitos = digitos.slice(0, candidatos[0]) + digitos.slice(candidatos[0] + 2)
  }
  if (digitos.length !== 10) {
    throw new TelefonoInvalido("El número tiene que tener 10 cifras contando el código de área (sin 0 ni 15)")
  }
  return `549${digitos}`
}

export function mostrarTelefono(normalizado: string): string {
  const nacional = normalizado.slice(3)
  const [area, resto] = nacional.startsWith("11") ? [nacional.slice(0, 2), nacional.slice(2)] : [nacional.slice(0, 3), nacional.slice(3)]
  return `+54 9 ${area} ${resto.slice(0, -4)}-${resto.slice(-4)}`
}
