import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generarClaveYPedido, leerCertificado, certificadoDesdeArchivo } from "../src/arca/certificado"
import { armarTra, firmarTra, parsearLogin, ErrorArca } from "../src/arca/wsaa"
import { cuerpoCae, parsearCae, resultadoDe, NS, Wsfe, Simulador } from "../src/arca/wsfe"
import { aBase64, deBase64 } from "../src/util"

function sobre(cuerpo: string) {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${cuerpo}</soap:Body></soap:Envelope>`
}

async function certificadoDePrueba() {
  const generado = await generarClaveYPedido("Persona de Prueba", "20111111112")
  const dir = mkdtempSync(join(tmpdir(), "arca-"))
  writeFileSync(join(dir, "clave.key"), generado.clavePrivada)
  writeFileSync(join(dir, "pedido.csr"), generado.pedido)
  execFileSync("openssl", ["x509", "-req", "-days", "30", "-in", join(dir, "pedido.csr"), "-signkey", join(dir, "clave.key"), "-out", join(dir, "cert.crt")], {
    stdio: "ignore",
  })
  return { ...generado, dir, certificado: readFileSync(join(dir, "cert.crt"), "utf8") }
}

describe("certificado", () => {
  it("genera un pedido que openssl valida, con los datos que pide ARCA", async () => {
    const { dir } = await certificadoDePrueba()
    const salida = execFileSync("openssl", ["req", "-in", join(dir, "pedido.csr"), "-noout", "-verify", "-subject", "-nameopt", "RFC2253"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    expect(salida).toContain("serialNumber=CUIT 20111111112")
    expect(salida).toContain("O=Persona de Prueba")
    expect(salida).toContain("C=AR")
  })

  it("acepta el certificado que corresponde a la clave y rechaza otro", async () => {
    const a = await certificadoDePrueba()
    const b = await certificadoDePrueba()
    const info = leerCertificado(a.certificado, a.clavePublica)
    expect(info.cuit).toBe("20111111112")
    expect(Date.parse(info.vence)).toBeGreaterThan(Date.now())
    expect(() => leerCertificado(b.certificado, a.clavePublica)).toThrow("no corresponde")
    expect(() => leerCertificado("basura", a.clavePublica)).toThrow("no es un certificado")
  })

  it("lee el archivo en PEM o en DER", async () => {
    const a = await certificadoDePrueba()
    const desdePem = certificadoDesdeArchivo(aBase64(new TextEncoder().encode(a.certificado)))
    const der = execFileSync("openssl", ["x509", "-in", join(a.dir, "cert.crt"), "-outform", "DER"])
    const desdeDer = certificadoDesdeArchivo(aBase64(der))
    expect(leerCertificado(desdePem, a.clavePublica).cuit).toBe("20111111112")
    expect(leerCertificado(desdeDer, a.clavePublica).cuit).toBe("20111111112")
  })
})

describe("wsaa", () => {
  it("arma el pedido de acceso con hora argentina y ventana de 10 minutos", () => {
    const tra = armarTra("wsfe", new Date("2026-11-01T15:00:00Z"))
    expect(tra).toContain("<service>wsfe</service>")
    expect(tra).toContain("<generationTime>2026-11-01T11:50:00-03:00</generationTime>")
    expect(tra).toContain("<expirationTime>2026-11-01T12:10:00-03:00</expirationTime>")
  })

  it("firma un CMS que openssl verifica y que contiene el pedido", async () => {
    const a = await certificadoDePrueba()
    const tra = armarTra("wsfe", new Date())
    const cms = await firmarTra(tra, a.certificado, a.clavePrivada)
    const archivo = join(a.dir, "tra.cms")
    writeFileSync(archivo, deBase64(cms))
    const contenido = execFileSync("openssl", ["cms", "-verify", "-inform", "DER", "-in", archivo, "-noverify"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    expect(contenido).toBe(tra)
  })

  it("lee token, firma y vencimiento", () => {
    const interno =
      "&lt;loginTicketResponse&gt;&lt;header&gt;&lt;expirationTime&gt;2026-11-02T00:00:00.000-03:00&lt;/expirationTime&gt;" +
      "&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;TOK&lt;/token&gt;&lt;sign&gt;SIG&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;"
    const t = parsearLogin(sobre(`<loginCmsResponse><loginCmsReturn>${interno}</loginCmsReturn></loginCmsResponse>`))
    expect(t).toEqual({ token: "TOK", sign: "SIG", vence: Date.parse("2026-11-02T03:00:00Z") })
  })

  it("traduce el aviso de acceso ya entregado", () => {
    expect(() => parsearLogin(sobre("<soap:Fault><faultstring>El CEE ya posee un TA valido para el acceso</faultstring></soap:Fault>"))).toThrow(
      "Probá de nuevo en unos minutos",
    )
  })
})

describe("wsfe", () => {
  const comprobante = {
    ptoVta: 2,
    numero: 15,
    fecha: "2026-11-01",
    docNro: 30111222,
    centavos: 6_000_000,
    desde: "2026-10-01",
    hasta: "2026-10-31",
    vtoPago: "2026-11-10",
  }

  it("arma el comprobante en el orden del esquema de ARCA", () => {
    const xml = cuerpoCae(comprobante)
    const orden = [
      "Concepto>2", "DocTipo>96", "DocNro>30111222", "CbteDesde>15", "CbteHasta>15", "CbteFch>20261101",
      "ImpTotal>60000.00", "ImpTotConc>0", "ImpNeto>60000.00", "ImpOpEx>0", "ImpTrib>0", "ImpIVA>0",
      "FchServDesde>20261001", "FchServHasta>20261031", "FchVtoPago>20261110", "MonId>PES", "MonCotiz>1",
      "CondicionIVAReceptorId>5",
    ].map((campo) => xml.indexOf(`<ar:${campo}`))
    expect(orden.every((p) => p >= 0)).toBe(true)
    expect([...orden].sort((a, b) => a - b)).toEqual(orden)
    expect(xml).toContain("<ar:CbteTipo>11</ar:CbteTipo>")
  })

  it("lee un CAE aprobado", () => {
    const r = parsearCae(
      resultadoDe(
        sobre(
          `<FECAESolicitarResponse xmlns="${NS}"><FECAESolicitarResult><FeCabResp><Resultado>A</Resultado></FeCabResp>` +
            "<FeDetResp><FECAEDetResponse><DocNro>30111222</DocNro><Resultado>A</Resultado><CAE>76123456789012</CAE>" +
            "<CAEFchVto>20261111</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>",
        ),
        "FECAESolicitar",
      ),
    )
    expect(r).toMatchObject({ aprobado: true, cae: "76123456789012", caeVto: "2026-11-11", docNro: 30111222 })
  })

  it("junta observaciones y errores de un rechazo", () => {
    const r = parsearCae(
      resultadoDe(
        sobre(
          `<FECAESolicitarResponse xmlns="${NS}"><FECAESolicitarResult><FeDetResp><FECAEDetResponse><Resultado>R</Resultado>` +
            "<Observaciones><Obs><Code>10015</Code><Msg>DocNro invalido</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp>" +
            "<Errors><Err><Code>10016</Code><Msg>Numero incorrecto</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse>",
        ),
        "FECAESolicitar",
      ),
    )
    expect(r.aprobado).toBe(false)
    expect(r.observaciones).toEqual(["10015: DocNro invalido"])
    expect(r.errores).toEqual(["10016: Numero incorrecto"])
  })

  it("un SOAP Fault es un error", () => {
    expect(() => resultadoDe(sobre("<soap:Fault><faultstring>token vencido</faultstring></soap:Fault>"), "FECAESolicitar")).toThrow(ErrorArca)
  })

  it("manda autenticación, CUIT y acción SOAP", async () => {
    const pedidos: Request[] = []
    const pedir = (async (url: string, init: RequestInit) => {
      pedidos.push(new Request(url, init))
      return new Response(
        sobre(
          `<FECompUltimoAutorizadoResponse xmlns="${NS}"><FECompUltimoAutorizadoResult><CbteNro>41</CbteNro>` +
            "</FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>",
        ),
      )
    }) as typeof fetch
    const cliente = new Wsfe("homologacion", "20111111112", async () => ({ token: "T<1>", sign: "S", vence: 0 }), pedir)
    expect(await cliente.ultimoAutorizado(2, 11)).toBe(41)
    const cuerpo = await pedidos[0].text()
    expect(pedidos[0].url).toBe("https://wswhomo.afip.gov.ar/wsfev1/service.asmx")
    expect(pedidos[0].headers.get("SOAPAction")).toBe(`"${NS}FECompUltimoAutorizado"`)
    expect(cuerpo).toContain("<ar:Token>T&lt;1&gt;</ar:Token>")
    expect(cuerpo).toContain("<ar:Cuit>20111111112</ar:Cuit>")
  })

  it("el simulador numera correlativo", async () => {
    const s = new Simulador(40)
    expect(await s.ultimoAutorizado()).toBe(40)
    expect((await s.solicitarCae({ ...comprobante, numero: 41 })).aprobado).toBe(true)
    expect((await s.solicitarCae({ ...comprobante, numero: 43 })).aprobado).toBe(false)
  })
})
