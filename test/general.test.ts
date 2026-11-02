import { describe, expect, it } from "vitest"
import { esDispositivoConocido, hashearClave, limitesLogin, marcaDispositivo, necesitaRehash, redDe, verificarClave } from "../src/auth"
import { cifrar, descifrar, descifrarConCualquiera } from "../src/cifrado"
import { describirPeriodo, faltantes } from "../src/facturador"
import type { Env, Usuario } from "../src/tipos"
import { apto, generarPdf, nombreArchivo, urlQr } from "../src/pdf"
import { aCentavos, deBase64, deCentavos, pesos } from "../src/util"
import * as validar from "../src/validacion"
import { mostrarTelefono, normalizarTelefono, TelefonoInvalido } from "../src/whatsapp"
import { DURACION_ENLACE, enlacePublico, enlaceValido, leerEnlace } from "../src/enlaces"
const SECRETO = "secreto-de-prueba-para-tests"

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
    expect(hash).toMatch(/^pbkdf2:600000:/)
    expect(necesitaRehash(hash)).toBe(false)
  })

  it("sigue aceptando los hashes viejos de 100.000 iteraciones y pide actualizarlos", async () => {
    const { pbkdf2Sync } = await import("node:crypto")
    const sal = Buffer.alloc(16, 7)
    const b64 = (b: Buffer) => b.toString("base64url")
    const viejo = `pbkdf2:100000:${b64(sal)}:${b64(pbkdf2Sync("una clave larga", sal, 100_000, 32, "sha256"))}`
    expect(await verificarClave("una clave larga", viejo)).toBe(true)
    expect(necesitaRehash(viejo)).toBe(true)
  })

  it("coincide con el hash del script de cuentas (rondas encadenadas)", async () => {
    const { pbkdf2Sync } = await import("node:crypto")
    const sal = Buffer.alloc(16, 3)
    let r = Buffer.from("una clave larga")
    for (let i = 0; i < 6; i++) r = pbkdf2Sync(r, sal, 100_000, 32, "sha256")
    expect(await verificarClave("una clave larga", `pbkdf2:600000:${sal.toString("base64url")}:${r.toString("base64url")}`)).toBe(true)
  })

  it("cifra y descifra; con otro secreto no se puede leer", async () => {
    const guardado = await cifrar("secreto-de-prueba-123", "clave privada")
    expect(guardado).not.toContain("clave privada")
    expect(await descifrar("secreto-de-prueba-123", guardado)).toBe("clave privada")
    await expect(descifrar("otro-secreto-de-prueba", guardado)).rejects.toThrow()
  })

  it("al rotar el secreto todavía lee lo cifrado con el anterior", async () => {
    const guardado = await cifrar("secreto-viejo-de-prueba", "clave privada")
    expect(await descifrarConCualquiera(["secreto-nuevo-de-prueba", "secreto-viejo-de-prueba"], guardado)).toEqual({
      texto: "clave privada",
      conActual: false,
    })
    await expect(descifrarConCualquiera(["secreto-nuevo-de-prueba"], guardado)).rejects.toThrow()
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
  const secreto = "secreto-de-prueba-123"
  const f41 = { id: 41, enlace_version: 0 }
  const ahora = Date.parse("2026-11-01T12:00:00Z")
  const abrir = async (enlace: string, f = f41, secretos = [secreto], momento = ahora) => {
    const leido = leerEnlace(enlace.slice(3), momento)
    return !!leido && (await enlaceValido(secretos, f, leido))
  }

  it("el enlace abre solo la factura que corresponde", async () => {
    const enlace = await enlacePublico(secreto, f41, ahora)
    expect(enlace).toMatch(/^\/f\/41-\d+-[A-Za-z0-9_-]{22}$/)
    expect(await abrir(enlace)).toBe(true)
  })

  it("no se puede adivinar ni reusar para otra factura", async () => {
    const [, vence, firma] = (await enlacePublico(secreto, f41, ahora)).slice(3).split(/-(\d+)-/)
    expect(await abrir(`/f/42-${vence}-${firma}`, { id: 42, enlace_version: 0 })).toBe(false)
    expect(await abrir(await enlacePublico(secreto, f41, ahora), f41, ["otro-secreto-distinto"])).toBe(false)
    expect(await abrir(`/f/41-${vence}-AAAAAAAAAAAAAAAAAAAAAA`)).toBe(false)
    expect(leerEnlace("basura", ahora)).toBeNull()
  })

  it("no se puede estirar el vencimiento", async () => {
    const [, vence, firma] = (await enlacePublico(secreto, f41, ahora)).slice(3).split(/-(\d+)-/)
    expect(await abrir(`/f/41-${Number(vence) + 86_400}-${firma}`)).toBe(false)
  })

  it("vence a los 60 días", async () => {
    const enlace = await enlacePublico(secreto, f41, ahora)
    expect(await abrir(enlace, f41, [secreto], ahora + (DURACION_ENLACE - 60) * 1000)).toBe(true)
    expect(await abrir(enlace, f41, [secreto], ahora + DURACION_ENLACE * 1000)).toBe(false)
  })

  it("al anularlo deja de andar y el nuevo sí anda", async () => {
    const viejo = await enlacePublico(secreto, f41, ahora)
    const anulada = { id: 41, enlace_version: 1 }
    expect(await abrir(viejo, anulada)).toBe(false)
    expect(await abrir(await enlacePublico(secreto, anulada, ahora), anulada)).toBe(true)
  })

  it("al rotar el secreto los enlaces viejos siguen andando", async () => {
    const viejo = await enlacePublico("secreto-viejo-de-prueba", f41, ahora)
    expect(await abrir(viejo, f41, [secreto, "secreto-viejo-de-prueba"])).toBe(true)
    expect(await abrir(viejo, f41, [secreto])).toBe(false)
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

describe("límite de intentos: redes y dispositivos", () => {
  it("agrupa las IPv6 por /64 y deja las IPv4 como están", () => {
    expect(redDe("203.0.113.7")).toBe("203.0.113.7")
    expect(redDe("2001:db8:aa:bb:1:2:3:4")).toBe("2001:db8:aa:bb::/64")
    expect(redDe("2001:DB8:aa:bb::9")).toBe("2001:db8:aa:bb::/64")
    expect(redDe("2001:db8::1")).toBe("2001:db8:0:0::/64")
    expect(redDe("::ffff:198.51.100.2")).toBe("198.51.100.2")
  })

  it("solo aplica el tope global por usuario a navegadores desconocidos", () => {
    expect(limitesLogin("Ana", "1.2.3.4", false).map((l) => l.clave)).toEqual(["login:ana|ip:1.2.3.4", "ip:1.2.3.4", "login:ana"])
    expect(limitesLogin("Ana", "1.2.3.4", true).map((l) => l.clave)).toEqual(["login:ana|ip:1.2.3.4", "ip:1.2.3.4"])
  })

  it("la cookie de dispositivo es por usuario y no se puede falsificar", async () => {
    const marca = await marcaDispositivo(SECRETO, "Ana")
    expect(await esDispositivoConocido([SECRETO], "ana", marca)).toBe(true)
    expect(await esDispositivoConocido([SECRETO], "otro", marca)).toBe(false)
    expect(await esDispositivoConocido(["otro-secreto-de-prueba-123"], "ana", marca)).toBe(false)
    expect(await esDispositivoConocido([SECRETO], "ana", "A".repeat(22))).toBe(false)
    expect(await esDispositivoConocido([SECRETO], "ana", undefined)).toBe(false)
  })
})

describe("certificado vencido", () => {
  async function certificado(dias: number) {
    const x509 = await import("@peculiar/x509")
    x509.cryptoProvider.set(crypto)
    const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 }
    const llaves = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair
    const c = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=prueba",
      notBefore: new Date(Date.now() - 400 * 86_400_000),
      notAfter: new Date(Date.now() + dias * 86_400_000),
      keys: llaves,
      signingAlgorithm: alg,
    })
    return c.toString("pem")
  }
  const usuario = (cert: string) => ({ nombre: "Ana", cuit: "20111111112", certificado: cert, clave_privada: "v1:x:y" }) as unknown as Usuario
  const env = { SIMULAR_ARCA: "false" } as unknown as Env

  it("bloquea la emisión si el certificado venció", async () => {
    const falta = faltantes(usuario(await certificado(-1)), env)
    expect(falta).toHaveLength(1)
    expect(falta[0]).toMatch(/certificado de ARCA nuevo \(el tuyo venció el/)
  })

  it("deja facturar si el certificado sigue vigente", async () => {
    expect(faltantes(usuario(await certificado(10)), env)).toEqual([])
  })
})

describe("contraseña nueva", () => {
  it("pide largo, mayúscula y símbolo", () => {
    expect(() => validar.claveNueva("Corta!")).toThrow(/10 caracteres/)
    expect(() => validar.claveNueva("sinmayuscula!")).toThrow(/mayúscula/)
    expect(() => validar.claveNueva("SinSimbolo123")).toThrow(/símbolo/)
    expect(() => validar.claveNueva("Con espacio 12")).toThrow(/símbolo/)
    expect(validar.claveNueva("Ñandú-de-campo")).toBe("Ñandú-de-campo")
    expect(validar.claveNueva("Buenisima#2026")).toBe("Buenisima#2026")
  })
})
