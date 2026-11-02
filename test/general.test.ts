import { describe, expect, it } from "vitest"
import { hashearClave, verificarClave } from "../src/auth"
import { cifrar, descifrar } from "../src/cifrado"
import { describirPeriodo } from "../src/facturador"
import { apto, generarPdf, nombreArchivo, urlQr } from "../src/pdf"
import { aCentavos, deBase64, deCentavos, pesos } from "../src/util"
import * as validar from "../src/validacion"
import { mostrarTelefono, normalizarTelefono, TelefonoInvalido } from "../src/whatsapp"
import { enlacePublico, idDeEnlace } from "../src/enlaces"

const factura = {
  modo: "simulacion" as const,
  pto_vta: 2,
  cbte_tipo: 11,
  numero: 41,
  fecha: "2026-11-01",
  dni: 30111222,
  nombre: "Ana Pérez",
  sesiones: 4,
  precio: "15000.00",
  total: "60000.00",
  descripcion: "Sesión de psicoterapia",
  desde: "2026-10-01",
  hasta: "2026-10-31",
  vto_pago: "2026-11-10",
  cae: "76123456789012",
  cae_vto: "2026-11-11",
}

const emisor = { nombre: "Nombre Apellido", titulo: "Lic. en Psicología", cuit: "20111111112", domicilio: "Calle 1", iibb: "", inicio_actividades: "01/03/2024" }

describe("importes", () => {
  it("trabaja en centavos sin errores de redondeo", () => {
    expect(aCentavos("15000")).toBe(1_500_000)
    expect(aCentavos("0.1")).toBe(10)
    expect(deCentavos(aCentavos("0.1") * 3)).toBe("0.30")
    expect(pesos("1234567.5")).toBe("$ 1.234.567,50")
    expect(() => aCentavos("1,5")).toThrow()
  })
})

describe("contraseñas y cifrado", () => {
  it("verifica la contraseña correcta y rechaza las demás", async () => {
    const hash = await hashearClave("una clave larga")
    expect(await verificarClave("una clave larga", hash)).toBe(true)
    expect(await verificarClave("otra", hash)).toBe(false)
    expect(await verificarClave("x", "basura")).toBe(false)
  })

  it("cifra y descifra; con otro secreto no se puede leer", async () => {
    const guardado = await cifrar("secreto-de-prueba-123", "clave privada")
    expect(guardado).not.toContain("clave privada")
    expect(await descifrar("secreto-de-prueba-123", guardado)).toBe("clave privada")
    await expect(descifrar("otro-secreto-de-prueba", guardado)).rejects.toThrow()
  })
})

describe("validaciones", () => {
  it("CUIT con dígito verificador", () => {
    expect(validar.cuitValido("20111111112")).toBe(true)
    expect(validar.cuitValido("20111111113")).toBe(false)
    expect(validar.cuitValido("2011111111")).toBe(false)
  })

  it("paciente con obra social", () => {
    const p = validar.paciente({ nombre: " Ana  Pérez ", telefono: "", obra_social: " OSDE ", plan: "310", numero_socio: "6123" }, "30111222")
    expect(p).toMatchObject({ dni: 30111222, nombre: "Ana Pérez", telefono: null, obra_social: "OSDE", plan: "310", numero_socio: "6123" })
    expect(validar.paciente({ nombre: "Ana" }, "30111222")).toMatchObject({ obra_social: "", plan: "", numero_socio: "" })
  })

  it("lote completo y reglas de ARCA", () => {
    const base = {
      fecha: "2026-11-01", desde: "2026-10-01", hasta: "2026-10-31", vto_pago: "2026-11-01", precio: "15000",
      descripcion: " Sesión  de psicoterapia ", items: [{ dni: "30.111.222", nombre: " Ana  Pérez ", sesiones: 4 }],
    }
    const lote = validar.lote(base, "2026-11-01")
    expect(lote.items).toEqual([{ dni: 30111222, nombre: "Ana Pérez", sesiones: 4 }])
    expect(lote.descripcion).toBe("Sesión de psicoterapia")
    expect(() => validar.lote(base, "2026-12-01")).toThrow("10 días")
    expect(() => validar.lote({ ...base, desde: "2026-11-30" }, "2026-11-01")).toThrow("período")
    expect(() => validar.lote({ ...base, items: [base.items[0], base.items[0]] }, "2026-11-01")).toThrow("dos veces")
    expect(() => validar.lote({ ...base, items: [{ ...base.items[0], sesiones: 0 }] }, "2026-11-01")).toThrow("sesiones")
  })
})

describe("teléfonos", () => {
  it.each(["343 412-3456", "0343 15 412-3456", "+54 9 343 412 3456", "54 343 4123456", "00549 3434123456"])("normaliza %s", (t) => {
    expect(normalizarTelefono(t)).toBe("5493434123456")
  })

  it("Buenos Aires y formato visible", () => {
    expect(normalizarTelefono("11 15 5555-1234")).toBe("5491155551234")
    expect(mostrarTelefono("5491155551234")).toBe("+54 9 11 5555-1234")
    expect(mostrarTelefono("5493434123456")).toBe("+54 9 343 412-3456")
  })

  it.each(["4123456", "12345", "11 15 15 55 1234"])("rechaza %s", (t) => {
    expect(() => normalizarTelefono(t)).toThrow(TelefonoInvalido)
  })
})

describe("enlaces públicos de facturas", () => {
  it("el enlace abre solo la factura que corresponde", async () => {
    const enlace = await enlacePublico("secreto-de-prueba-123", 41)
    expect(enlace).toMatch(/^\/f\/41-[A-Za-z0-9_-]{22}$/)
    const clave = enlace.slice(3)
    expect(await idDeEnlace("secreto-de-prueba-123", clave)).toBe(41)
  })

  it("no se puede adivinar ni reusar para otra factura", async () => {
    const clave = (await enlacePublico("secreto-de-prueba-123", 41)).slice(3)
    const firma = clave.split("-").slice(1).join("-")
    expect(await idDeEnlace("secreto-de-prueba-123", `42-${firma}`)).toBeNull()
    expect(await idDeEnlace("otro-secreto-distinto", clave)).toBeNull()
    expect(await idDeEnlace("secreto-de-prueba-123", "41-AAAAAAAAAAAAAAAAAAAAAA")).toBeNull()
    expect(await idDeEnlace("secreto-de-prueba-123", "basura")).toBeNull()
  })

  it("describe el período", () => {
    expect(describirPeriodo("2026-10-01", "2026-10-31")).toBe("octubre de 2026")
    expect(describirPeriodo("2026-10-15", "2026-11-14")).toBe("15/10/2026 al 14/11/2026")
  })
})

describe("pdf", () => {
  it("el QR lleva los datos que pide ARCA", () => {
    const p = new URL(urlQr(factura, emisor.cuit)).searchParams.get("p")!
    expect(JSON.parse(new TextDecoder().decode(deBase64(p)))).toEqual({
      ver: 1, fecha: "2026-11-01", cuit: 20111111112, ptoVta: 2, tipoCmp: 11, nroCmp: 41, importe: 60000, moneda: "PES",
      ctz: 1, tipoDocRec: 96, nroDocRec: 30111222, tipoCodAut: "E", codAut: 76123456789012,
    })
  })

  it("genera un PDF aunque el nombre tenga letras raras", async () => {
    const pdf = await generarPdf({ ...factura, nombre: "Łukasz Ñandú 李" }, emisor)
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-")
    expect(apto("Łukasz Ñandú 李")).toBe("Lukasz Ñandú ?")
  })

  it("muestra obra social, plan y número de socio del paciente", async () => {
    const { execFileSync } = await import("node:child_process")
    const { mkdtempSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const archivo = join(mkdtempSync(join(tmpdir(), "pdf-")), "f.pdf")
    writeFileSync(archivo, await generarPdf({ ...factura, obra_social: "OSDE", plan: "310", numero_socio: "61234567801" }, emisor))
    const texto = execFileSync("pdftotext", ["-layout", archivo, "-"], { encoding: "utf8" })
    expect(texto).toContain("Obra social: OSDE · Plan 310")
    expect(texto).toContain("N.º de socio: 61234567801")
    writeFileSync(archivo, await generarPdf(factura, emisor))
    expect(execFileSync("pdftotext", [archivo, "-"], { encoding: "utf8" })).not.toContain("Obra social")
  })

  it("nombre de archivo sin tildes", () => {
    expect(nombreArchivo({ pto_vta: 2, numero: 41, nombre: "Ana Pérez" })).toBe("Factura-C-00002-00000041-Ana-Perez.pdf")
  })
})
