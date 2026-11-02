const codificador = new TextEncoder()

export function bytes(texto: string): Uint8Array {
  return codificador.encode(texto)
}

export function aBase64(datos: ArrayBuffer | Uint8Array): string {
  const arreglo = datos instanceof Uint8Array ? datos : new Uint8Array(datos)
  let binario = ""
  for (let i = 0; i < arreglo.length; i += 0x8000) {
    binario += String.fromCharCode(...arreglo.subarray(i, i + 0x8000))
  }
  return btoa(binario)
}

export function deBase64(texto: string): Uint8Array {
  const binario = atob(texto)
  const arreglo = new Uint8Array(binario.length)
  for (let i = 0; i < binario.length; i++) arreglo[i] = binario.charCodeAt(i)
  return arreglo
}

export function aBase64Url(datos: ArrayBuffer | Uint8Array): string {
  return aBase64(datos).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function deBase64Url(texto: string): Uint8Array {
  const normal = texto.replace(/-/g, "+").replace(/_/g, "/")
  return deBase64(normal + "=".repeat((4 - (normal.length % 4)) % 4))
}

export async function sha256(datos: string | Uint8Array): Promise<Uint8Array> {
  const entrada = typeof datos === "string" ? bytes(datos) : datos
  return new Uint8Array(await crypto.subtle.digest("SHA-256", entrada))
}

export function aleatorio(cantidad: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(cantidad))
}

export function iguales(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diferencia = 0
  for (let i = 0; i < a.length; i++) diferencia |= a[i] ^ b[i]
  return diferencia === 0
}

export function aPem(etiqueta: string, der: ArrayBuffer | Uint8Array): string {
  const cuerpo = aBase64(der).match(/.{1,64}/g)?.join("\n") ?? ""
  return `-----BEGIN ${etiqueta}-----\n${cuerpo}\n-----END ${etiqueta}-----\n`
}

export function dePem(pem: string): Uint8Array {
  const cuerpo = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "")
  return deBase64(cuerpo)
}

export function hoyArgentina(ahora = new Date()): string {
  return new Date(ahora.getTime() - 3 * 3600_000).toISOString().slice(0, 10)
}

export function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}

export function escaparXml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!)
}

export function desescaparXml(texto: string): string {
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function patron(nombre: string, banderas: string): RegExp {
  return new RegExp(`<(?:[\\w-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nombre}>`, banderas)
}

export function etiqueta(xml: string, nombre: string): string | null {
  const encontrado = patron(nombre, "").exec(xml)
  return encontrado ? encontrado[1] : null
}

export function etiquetas(xml: string, nombre: string): string[] {
  return [...xml.matchAll(patron(nombre, "g"))].map((m) => m[1])
}

export function texto(xml: string, nombre: string): string | null {
  const valor = etiqueta(xml, nombre)
  return valor === null ? null : desescaparXml(valor.trim())
}

export function aCentavos(valor: string | number): number {
  const limpio = String(valor).trim()
  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) throw new Error("Importe inválido")
  const [entero, decimales = ""] = limpio.split(".")
  return Number(entero) * 100 + Number(decimales.padEnd(2, "0"))
}

export function deCentavos(centavos: number): string {
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`
}

export function pesos(valor: string | number): string {
  const centavos = typeof valor === "number" ? valor : aCentavos(valor)
  const entero = Math.floor(centavos / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return `$ ${entero},${String(centavos % 100).padStart(2, "0")}`
}

export function dmy(iso: string): string {
  return iso.split("-").reverse().join("/")
}
